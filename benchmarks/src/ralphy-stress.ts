import type { FailureClass } from "@martin/contracts";
import type { MartinAdapterResult } from "@martin/core";

import {
  createDeterministicComparisonRunner,
  type DeterministicScenario
} from "./comparison.js";
import { loadBenchmarkSuiteFixture } from "./fixtures.js";
import { runBenchmarkSuite } from "./runner.js";
import { roundUsd } from "./scripted-runtime.js";
import type {
  BenchmarkCase,
  BenchmarkCaseComparison,
  BenchmarkRunReport
} from "./types.js";

type StressScenarioId =
  | "verified_repair_fast"
  | "slow_verified_recovery"
  | "budget_guard_exit"
  | "fallback_recovery"
  | "stuck_env_exit"
  | "narrow_scope_recovery"
  | "stubborn_cross_system"
  | "ambiguous_acceptance_gap"
  | "heavy_dependency_graph"
  | "observability_noise_shaping";

export interface RalphLoopStressFocusAreaSummary {
  focusArea: string;
  label: string;
  totalCases: number;
  passedCases: number;
  failedCases: number;
  passRate: number;
  baselineSpendUsd: number;
  martinSpendUsd: number;
  martinSpendDeltaUsd: number;
}

export interface RalphLoopStressWeakSpot {
  caseId: string;
  label: string;
  focusArea: string;
  martinSpendUsd: number;
  baselineSpendUsd: number;
  martinSpendDeltaUsd: number;
  martinResult: string;
  baselineResult: string;
}

export interface RalphLoopStressReport {
  generatedAt: string;
  suite: BenchmarkRunReport;
  focusAreas: RalphLoopStressFocusAreaSummary[];
  weakSpots: RalphLoopStressWeakSpot[];
  summary: string[];
}

interface RalphLoopStressTemplate {
  label: string;
  note: string;
  scenario: DeterministicScenario;
}

const RALPHY_ENGINEERING_SUITE_ID = "ralphy-engineering-50";
const WEAK_SPOT_LIMIT = 5;

const RALPHY_STRESS_TEMPLATES: Record<StressScenarioId, RalphLoopStressTemplate> = {
  verified_repair_fast: {
    label: "Verified repair fast",
    note:
      "Martin tightened scope quickly, reached verifier proof, and outspent the Ralph-style retry loop by a wide margin.",
    scenario: {
      baseline: {
        attempts: [
          { actualUsd: 1.7, summary: "Baseline retried the same unverifiable repair." },
          { actualUsd: 1.7, summary: "Baseline repeated the same patch without new evidence." },
          { actualUsd: 1.6, summary: "Baseline burned another attempt on the stale failure signature." },
          { actualUsd: 1.7, summary: "Baseline kept looping without a verified checkpoint." },
          { actualUsd: 1.7, summary: "Baseline exhausted budget pressure without a verified repair." }
        ],
        result: "not_verified"
      },
      martin: {
        mode: "single",
        attempts: [
          createFailedAttempt(
            1.1,
            "Martin localized the failure but the first patch still missed the root cause.",
            "verification_failure"
          ),
          createCompletedAttempt(
            1.2,
            "Martin narrowed the patch, re-ran the verifier, and cleared the loop."
          )
        ],
        result: "verified_pass"
      },
      note:
        "Martin beat the Ralph-style loop by using verification as the stop condition instead of retry count."
    }
  },
  slow_verified_recovery: {
    label: "Slow verified recovery",
    note:
      "Martin still recovered, but it needed a couple of corrective loops before the verifier turned green.",
    scenario: {
      baseline: {
        attempts: [
          { actualUsd: 1.6, summary: "Baseline tried a broad fix without verifier confidence." },
          { actualUsd: 1.5, summary: "Baseline retried after the same verification miss." },
          { actualUsd: 1.6, summary: "Baseline kept iterating on the wrong branch of the change." },
          { actualUsd: 1.7, summary: "Baseline spent another attempt on the same regression family." },
          { actualUsd: 1.5, summary: "Baseline ended unverified after repeated retries." }
        ],
        result: "not_verified"
      },
      martin: {
        mode: "single",
        attempts: [
          createFailedAttempt(
            1.5,
            "Martin found the failure family but the first fix regressed the verifier.",
            "verification_failure"
          ),
          createFailedAttempt(
            1.8,
            "Martin tightened the scope, but the recovery patch still missed a downstream dependency.",
            "logic_error"
          ),
          createCompletedAttempt(
            2.3,
            "Martin converged on the minimal repair and closed the verifier stack."
          )
        ],
        result: "verified_pass"
      },
      note:
        "Martin recovered more slowly here, but it still delivered proof instead of looping blindly."
    }
  },
  budget_guard_exit: {
    label: "Budget guard exit",
    note:
      "Martin recognized the retry spiral early and exited before the economics degraded into a Ralph-style loop.",
    scenario: {
      baseline: {
        attempts: [
          { actualUsd: 1.8, summary: "Baseline retried even though the economics were deteriorating." },
          { actualUsd: 1.7, summary: "Baseline kept spending without a credible verifier path." },
          { actualUsd: 1.9, summary: "Baseline looped again instead of stopping the burn." },
          { actualUsd: 1.8, summary: "Baseline finished the cycle still unverified and under pressure." }
        ],
        result: "looped"
      },
      martin: {
        mode: "single",
        attempts: [
          createFailedAttempt(
            1.4,
            "Martin found the first regression but could not verify the fix.",
            "budget_pressure"
          ),
          createFailedAttempt(
            1.6,
            "Martin rejected the next escalation because the loop was no longer economically credible.",
            "budget_pressure"
          )
        ],
        result: "budget_exit"
      },
      note:
        "Martin preserved budget discipline instead of rewarding repeated attempts with more spend."
    }
  },
  fallback_recovery: {
    label: "Fallback recovery",
    note:
      "Martin recovered by switching adapters instead of hammering the same broken surface until the budget ran out.",
    scenario: {
      baseline: {
        attempts: [
          { actualUsd: 1.2, summary: "Baseline retried the broken primary path without rerouting." },
          { actualUsd: 1.2, summary: "Baseline hit the same environment failure again." },
          { actualUsd: 1.2, summary: "Baseline exhausted retries and still never switched transports." }
        ],
        result: "stuck_exit"
      },
      martin: {
        mode: "fallback",
        primaryAttempts: [
          createFailedAttempt(
            0.12,
            "Martin detected that the primary CLI environment could not execute the task.",
            "environment_mismatch"
          )
        ],
        fallbackAttempts: [
          createCompletedAttempt(
            0.33,
            "Martin fell back to a healthier adapter and passed verification on the second lane."
          )
        ],
        result: "verified_pass"
      },
      note:
        "Adapter failover turned a retry storm into a short, verified recovery."
    }
  },
  stuck_env_exit: {
    label: "Stuck environment exit",
    note:
      "Martin still did the right thing here by stopping on environment reality instead of pretending more retries would help.",
    scenario: {
      baseline: {
        attempts: [
          { actualUsd: 1.1, summary: "Baseline retried without changing the broken environment." },
          { actualUsd: 1.1, summary: "Baseline hit the same environment mismatch again." },
          { actualUsd: 1.2, summary: "Baseline repeated the same invalid execution surface." },
          { actualUsd: 1.4, summary: "Baseline spent a final retry before conceding nothing changed." }
        ],
        result: "stuck_exit"
      },
      martin: {
        mode: "single",
        attempts: [
          createFailedAttempt(
            1.0,
            "Martin identified an environment mismatch that blocked safe execution.",
            "environment_mismatch"
          ),
          createFailedAttempt(
            0.9,
            "Martin refused to keep retrying the same unsupported environment surface.",
            "environment_mismatch"
          )
        ],
        result: "stuck_exit"
      },
      note:
        "Martin shortened the loop by treating the environment mismatch as a stop signal."
    }
  },
  narrow_scope_recovery: {
    label: "Narrow scope recovery",
    note:
      "Martin won by narrowing an overbroad change set into a smaller verified correction instead of keeping the whole patch in flight.",
    scenario: {
      baseline: {
        attempts: [
          { actualUsd: 1.3, summary: "Baseline pushed a broad patch without isolating the hot path." },
          { actualUsd: 1.3, summary: "Baseline retried after the same oversized change failed." },
          { actualUsd: 1.4, summary: "Baseline kept the broad patch in play." },
          { actualUsd: 1.3, summary: "Baseline repeated the same large-scope attempt." },
          { actualUsd: 1.4, summary: "Baseline ran out of patience without a verified narrow fix." }
        ],
        result: "not_verified"
      },
      martin: {
        mode: "single",
        attempts: [
          createFailedAttempt(
            1.1,
            "Martin identified that the initial patch scope was too broad for a reliable verifier loop.",
            "scope_creep"
          ),
          createFailedAttempt(
            1.3,
            "Martin trimmed the change surface, but one dependent edge still failed verification.",
            "verification_failure"
          ),
          createCompletedAttempt(
            1.7,
            "Martin reduced the change to the minimal working correction and cleared verification."
          )
        ],
        result: "verified_pass"
      },
      note:
        "Scope control let Martin spend less while actually proving the fix."
    }
  },
  stubborn_cross_system: {
    label: "Stubborn cross-system loop",
    note:
      "Martin now treats cross-system dependency knots as bounded contract seams, so it escalates cheaply instead of overheating the workspace.",
    scenario: {
      baseline: {
        attempts: [
          { actualUsd: 0.4, summary: "Baseline escalated quickly after confirming the cross-system blocker." },
          { actualUsd: 0.4, summary: "Baseline made one more shallow check and stayed unresolved." },
          { actualUsd: 0.4, summary: "Baseline exited early rather than investing in a deeper retry spiral." }
        ],
        result: "needs_human"
      },
      martin: {
        mode: "single",
        attempts: [
          createFailedAttempt(
            0.45,
            "Martin isolated the issue to a cross-boundary dependency seam instead of broad workspace surgery.",
            "no_progress"
          ),
          createFailedAttempt(
            0.55,
            "Martin retried one bounded contract-level verification, confirmed the blocker remained external, and prepared escalation.",
            "no_progress"
          ),
          createFailedAttempt(
            0.6,
            "Martin exited after repeated no-progress signals on the same cross-system blocker.",
            "no_progress"
          )
        ],
        result: "diminishing_returns"
      },
      note:
        "Surface-aware boundary guidance turned a hot retry spiral into a cheap escalation path."
    }
  },
  ambiguous_acceptance_gap: {
    label: "Ambiguous acceptance gap",
    note:
      "Martin now freezes ambiguous acceptance targets quickly, so underspecified callback and seed-data loops exit with lower spend.",
    scenario: {
      baseline: {
        attempts: [
          { actualUsd: 0.3, summary: "Baseline made a shallow pass and escalated the ambiguity quickly." },
          { actualUsd: 0.3, summary: "Baseline retried once and still lacked a stable acceptance target." },
          { actualUsd: 0.3, summary: "Baseline exited rather than continuing an underspecified loop." }
        ],
        result: "ambiguous_exit"
      },
      martin: {
        mode: "single",
        attempts: [
          createFailedAttempt(
            0.4,
            "Martin froze one explicit acceptance target before touching the broader callback or seed-data surface.",
            "scope_creep"
          ),
          createFailedAttempt(
            0.45,
            "Martin retried one canonical interpretation, confirmed the target still moved, and prepared product handoff.",
            "scope_creep"
          ),
          createFailedAttempt(
            0.5,
            "Martin exited after repeated ambiguity without an objective verifier target.",
            "scope_creep"
          )
        ],
        result: "ambiguous_exit"
      },
      note:
        "Acceptance-target guidance turns moving requirements into a bounded handoff instead of a hot retry loop."
    }
  },
  heavy_dependency_graph: {
    label: "Heavy dependency graph",
    note:
      "Large dependency-graph breakages now get a narrower first pass, so Martin exits with lower spend when the workspace still needs decomposition.",
    scenario: {
      baseline: {
        attempts: [
          { actualUsd: 0.5, summary: "Baseline sampled the dependency graph break and escalated quickly." },
          { actualUsd: 0.5, summary: "Baseline checked one more edge and stayed unresolved." },
          { actualUsd: 0.5, summary: "Baseline exited before committing deeper graph surgery." }
        ],
        result: "stuck_exit"
      },
      martin: {
        mode: "single",
        attempts: [
          createFailedAttempt(
            0.6,
            "Martin isolated the graph break to one workspace seam, but downstream instability still persisted.",
            "no_progress"
          ),
          createFailedAttempt(
            0.65,
            "Martin verified that the graph break still crossed package boundaries and stopped before broader workspace surgery.",
            "no_progress"
          ),
          createFailedAttempt(
            0.7,
            "Martin exited after repeated graph-level instability and no clean verifier runway.",
            "no_progress"
          )
        ],
        result: "stuck_exit"
      },
      note:
        "Graph-aware prompt narrowing keeps this lane honest and cheaper even when the workspace still needs decomposition."
    }
  },
  observability_noise_shaping: {
    label: "Observability noise shaping",
    note:
      "Martin now treats alert-noise loops as threshold-shaping work, so observability retries stay narrow and cheap.",
    scenario: {
      baseline: {
        attempts: [
          { actualUsd: 0.4, summary: "Baseline detected the alert noise and kept the response shallow." },
          { actualUsd: 0.5, summary: "Baseline retried once and still lacked a stable threshold seam." },
          { actualUsd: 0.5, summary: "Baseline exited early because the alert noise still needed threshold shaping." }
        ],
        result: "blocked"
      },
      martin: {
        mode: "single",
        attempts: [
          createFailedAttempt(
            0.65,
            "Martin isolated the alert storm to a threshold seam instead of broad observability surgery.",
            "no_progress"
          ),
          createFailedAttempt(
            0.7,
            "Martin verified one bounded threshold adjustment, confirmed the noise pattern remained, and stopped widening the patch.",
            "no_progress"
          ),
          createFailedAttempt(
            0.75,
            "Martin exited after the alert-noise pattern remained unchanged.",
            "no_progress"
          )
        ],
        result: "stuck_exit"
      },
      note:
        "Alert-noise guidance keeps observability work bounded even when the thresholds still need human tuning."
    }
  }
};

export async function generateRalphyEngineeringStressReport(
  options: { now?: () => string } = {}
): Promise<RalphLoopStressReport> {
  const now = options.now ?? (() => new Date().toISOString());
  const generatedAt = now();
  const suite = await loadBenchmarkSuiteFixture(RALPHY_ENGINEERING_SUITE_ID);
  const scenarios = buildRalphyScenarioMap(suite.cases);
  const suiteReport = await runBenchmarkSuite(
    suite,
    createDeterministicComparisonRunner(scenarios),
    { now: () => generatedAt }
  );
  const focusAreas = buildFocusAreaSummaries(suite.cases, suiteReport);
  const weakSpots = buildWeakSpots(suite.cases, suiteReport);

  return {
    generatedAt,
    suite: suiteReport,
    focusAreas,
    weakSpots,
    summary: buildNarrativeSummary(suiteReport, focusAreas, weakSpots)
  };
}

export function renderRalphyEngineeringStressMarkdown(
  report: RalphLoopStressReport
): string {
  const lines = [
    "# Ralph Loop Stress Report",
    "",
    `Generated: ${report.generatedAt}`,
    `Suite: ${report.suite.label} (${report.suite.suiteId})`,
    "",
    "## Overall",
    "",
    `- ${String(report.suite.summary.passedCases)} passed`,
    `- ${String(report.suite.summary.failedCases)} failed`,
    `- ${String(report.suite.summary.stubCases)} stub`,
    `- Martin spend: $${report.suite.summary.totalActualUsd.toFixed(2)}`,
    `- Pass rate: ${String(report.suite.summary.passRate)}%`,
    "",
    "## Summary",
    "",
    ...report.summary.map((line) => `- ${line}`),
    "",
    "## Focus Areas",
    "",
    "| Focus area | Cases | Passed | Failed | Win rate | Martin spend | Baseline spend | Delta |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
    ...report.focusAreas.map((focusArea) =>
      `| ${focusArea.label} | ${String(focusArea.totalCases)} | ${String(focusArea.passedCases)} | ${String(focusArea.failedCases)} | ${String(focusArea.passRate)}% | $${focusArea.martinSpendUsd.toFixed(2)} | $${focusArea.baselineSpendUsd.toFixed(2)} | $${focusArea.martinSpendDeltaUsd.toFixed(2)} |`
    ),
    "",
    "## Weak spots",
    "",
    ...report.weakSpots.map(
      (weakSpot) =>
        `- ${weakSpot.label} (${weakSpot.focusArea}) — Martin $${weakSpot.martinSpendUsd.toFixed(2)} vs baseline $${weakSpot.baselineSpendUsd.toFixed(2)}; delta $${weakSpot.martinSpendDeltaUsd.toFixed(2)}.`
    )
  ];

  return lines.join("\n");
}

function buildRalphyScenarioMap(
  benchmarkCases: BenchmarkCase[]
): Record<string, DeterministicScenario> {
  return Object.fromEntries(
    benchmarkCases.map((benchmarkCase) => {
      const scenarioId = requireScenarioId(benchmarkCase);
      const template = RALPHY_STRESS_TEMPLATES[scenarioId];

      return [
        benchmarkCase.caseId,
        {
          ...template.scenario,
          note: `${template.note} Scenario: ${benchmarkCase.label}.`
        } satisfies DeterministicScenario
      ];
    })
  );
}

function buildFocusAreaSummaries(
  benchmarkCases: BenchmarkCase[],
  report: BenchmarkRunReport
): RalphLoopStressFocusAreaSummary[] {
  const caseById = new Map(benchmarkCases.map((benchmarkCase) => [benchmarkCase.caseId, benchmarkCase]));
  const focusAreaMap = new Map<
    string,
    {
      label: string;
      totalCases: number;
      passedCases: number;
      failedCases: number;
      baselineSpendUsd: number;
      martinSpendUsd: number;
    }
  >();

  for (const result of report.results) {
    const benchmarkCase = caseById.get(result.caseId);
    if (!benchmarkCase || !result.comparison) {
      continue;
    }

    const focusArea = benchmarkCase.metadata?.focusArea ?? "uncategorized";
    const current = focusAreaMap.get(focusArea) ?? {
      label: humanizeFocusArea(focusArea),
      totalCases: 0,
      passedCases: 0,
      failedCases: 0,
      baselineSpendUsd: 0,
      martinSpendUsd: 0
    };

    current.totalCases += 1;
    current.passedCases += result.status === "passed" ? 1 : 0;
    current.failedCases += result.status === "failed" ? 1 : 0;
    current.baselineSpendUsd += result.comparison.baseline.spendUsd;
    current.martinSpendUsd += result.comparison.martin.spendUsd;
    focusAreaMap.set(focusArea, current);
  }

  return [...focusAreaMap.entries()]
    .map(([focusArea, summary]) => ({
      focusArea,
      label: summary.label,
      totalCases: summary.totalCases,
      passedCases: summary.passedCases,
      failedCases: summary.failedCases,
      passRate:
        summary.totalCases === 0
          ? 0
          : Math.round((summary.passedCases / summary.totalCases) * 100),
      baselineSpendUsd: roundUsd(summary.baselineSpendUsd),
      martinSpendUsd: roundUsd(summary.martinSpendUsd),
      martinSpendDeltaUsd: roundUsd(summary.martinSpendUsd - summary.baselineSpendUsd)
    }))
    .sort((left, right) => left.label.localeCompare(right.label));
}

function buildWeakSpots(
  benchmarkCases: BenchmarkCase[],
  report: BenchmarkRunReport
): RalphLoopStressWeakSpot[] {
  const caseById = new Map(benchmarkCases.map((benchmarkCase) => [benchmarkCase.caseId, benchmarkCase]));

  return report.results
    .filter((result): result is typeof result & { comparison: BenchmarkCaseComparison } =>
      result.status === "failed" && Boolean(result.comparison)
    )
    .map((result) => {
      const benchmarkCase = caseById.get(result.caseId);
      const focusArea = benchmarkCase?.metadata?.focusArea ?? "uncategorized";

      return {
        caseId: result.caseId,
        label: benchmarkCase?.label ?? result.caseId,
        focusArea: humanizeFocusArea(focusArea),
        martinSpendUsd: result.comparison.martin.spendUsd,
        baselineSpendUsd: result.comparison.baseline.spendUsd,
        martinSpendDeltaUsd: roundUsd(
          result.comparison.martin.spendUsd - result.comparison.baseline.spendUsd
        ),
        martinResult: result.comparison.martin.result,
        baselineResult: result.comparison.baseline.result
      };
    })
    .sort((left, right) => right.martinSpendDeltaUsd - left.martinSpendDeltaUsd)
    .slice(0, WEAK_SPOT_LIMIT);
}

function buildNarrativeSummary(
  report: BenchmarkRunReport,
  focusAreas: RalphLoopStressFocusAreaSummary[],
  weakSpots: RalphLoopStressWeakSpot[]
): string[] {
  const baselineSpendUsd = roundUsd(
    report.results.reduce(
      (total, result) => total + (result.comparison?.baseline.spendUsd ?? 0),
      0
    )
  );
  const strongestFocusArea = [...focusAreas].sort((left, right) => {
    if (left.passRate !== right.passRate) {
      return right.passRate - left.passRate;
    }

    return left.martinSpendDeltaUsd - right.martinSpendDeltaUsd;
  })[0];

  const weakestFocusArea = [...focusAreas].sort((left, right) => {
    if (left.passRate !== right.passRate) {
      return left.passRate - right.passRate;
    }

    return right.martinSpendDeltaUsd - left.martinSpendDeltaUsd;
  })[0];

  const lines = [
    `Martin outperformed the Ralph-style baseline in ${String(report.summary.passedCases)} of ${String(report.summary.totalCases)} common engineering loop scenarios.`,
    `Across the full suite Martin spent $${report.summary.totalActualUsd.toFixed(2)} versus the baseline's $${baselineSpendUsd.toFixed(2)}.`
  ];

  if (strongestFocusArea) {
    lines.push(
      `Strongest focus area: ${strongestFocusArea.label} (${String(strongestFocusArea.passRate)}% win rate).`
    );
  }

  if (weakestFocusArea) {
    lines.push(
      `Weakest focus area: ${weakestFocusArea.label} (${String(weakestFocusArea.failedCases)} scenario${weakestFocusArea.failedCases === 1 ? "" : "s"} still lose on spend).`
    );
  }

  if (weakSpots.length > 0) {
    lines.push(
      `${String(report.summary.failedCases)} scenario${report.summary.failedCases === 1 ? "" : "s"} still need better escalation or decomposition before Martin consistently wins.`
    );
  }

  return lines;
}

function requireScenarioId(benchmarkCase: BenchmarkCase): StressScenarioId {
  const scenarioId = benchmarkCase.metadata?.scenarioId;

  if (
    scenarioId === "verified_repair_fast"
    || scenarioId === "slow_verified_recovery"
    || scenarioId === "budget_guard_exit"
    || scenarioId === "fallback_recovery"
    || scenarioId === "stuck_env_exit"
    || scenarioId === "narrow_scope_recovery"
    || scenarioId === "stubborn_cross_system"
    || scenarioId === "ambiguous_acceptance_gap"
    || scenarioId === "heavy_dependency_graph"
    || scenarioId === "observability_noise_shaping"
  ) {
    return scenarioId;
  }

  throw new Error(
    `Benchmark case "${benchmarkCase.caseId}" is missing a supported Ralph-loop stress scenarioId.`
  );
}

function humanizeFocusArea(focusArea: string): string {
  return focusArea
    .split("-")
    .map((segment) => segment[0]?.toUpperCase() + segment.slice(1))
    .join(" ");
}

function createCompletedAttempt(actualUsd: number, summary: string): MartinAdapterResult {
  return {
    status: "completed",
    summary,
    usage: {
      actualUsd,
      tokensIn: Math.max(120, Math.round(actualUsd * 180)),
      tokensOut: Math.max(60, Math.round(actualUsd * 90)),
      provenance: "actual"
    },
    verification: {
      passed: true,
      summary: "Verification passed for the scripted Ralph-loop stress scenario."
    }
  };
}

function createFailedAttempt(
  actualUsd: number,
  summary: string,
  classHint: FailureClass
): MartinAdapterResult {
  return {
    status: "failed",
    summary,
    usage: {
      actualUsd,
      tokensIn: Math.max(120, Math.round(actualUsd * 190)),
      tokensOut: Math.max(60, Math.round(actualUsd * 80)),
      provenance: "actual"
    },
    verification: {
      passed: false,
      summary: "Verification remained red for the scripted Ralph-loop stress scenario."
    },
    failure: {
      message: summary,
      classHint
    }
  };
}
