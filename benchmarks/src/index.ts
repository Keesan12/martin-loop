import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { runMartin, type MartinAdapter, type MartinAdapterResult } from "@martin/core";
import { type LoopBudget, type LoopRecord, type LoopTask } from "@martin/contracts";

export interface BenchmarkCaseBaseline {
  adapterId: string;
  model: string;
  strategy: string;
}

export interface BenchmarkCase {
  caseId: string;
  label: string;
  task: LoopTask;
  budget: LoopBudget;
  baseline: BenchmarkCaseBaseline;
  tags: string[];
}

export interface BenchmarkSuite {
  suiteId: string;
  label: string;
  description: string;
  baselineAdapter: string;
  cases: BenchmarkCase[];
}

export interface BenchmarkCaseResult {
  caseId: string;
  status: "passed" | "failed" | "skipped";
  durationMs: number;
  notes: string[];
  loop?: LoopRecord;
  comparison?: BenchmarkCaseComparison;
}

export interface BenchmarkReport {
  suiteId: string;
  label: string;
  startedAt: string;
  finishedAt: string;
  results: BenchmarkCaseResult[];
  summary: {
    totalCases: number;
    passedCases: number;
    failedCases: number;
    skippedCases: number;
    stubCases: number;
    totalDurationMs: number;
    totalActualUsd: number;
    totalAvoidedUsd: number;
    passRate: number;
  };
}

export interface BenchmarkCompetitorOutcome {
  adapterId: string;
  attempts: number;
  spendUsd: number;
  result: string;
}

export interface BenchmarkCaseComparison {
  baseline: BenchmarkCompetitorOutcome;
  martin: BenchmarkCompetitorOutcome;
}

const BUILT_IN_SUITES = [
  {
    suiteId: "ralphy-smoke",
    label: "Ralphy Smoke",
    description: "Small benchmark suite mirroring Ralph/Ralphy-style retry-loop tasks."
  },
  {
    suiteId: "phase7-variants",
    label: "Phase 7 Benchmark Variants",
    description: "Variant A/B/C bakeoff comparing Martin Loop v4 against a baseline retry controller."
  }
] as const;

export function getBuiltInFixturePath(suiteId: string): string {
  return fileURLToPath(new URL(`../fixtures/${suiteId}.json`, import.meta.url));
}

export async function loadBenchmarkSuiteFixture(suiteId: string): Promise<BenchmarkSuite> {
  const contents = await readFile(getBuiltInFixturePath(suiteId), "utf8");
  const parsed = JSON.parse(contents) as Omit<BenchmarkSuite, "cases"> & {
    cases: Array<Omit<BenchmarkCase, "budget"> & { budget?: Partial<LoopBudget> }>;
  };

  return {
    ...parsed,
    cases: parsed.cases.map((benchmarkCase) => ({
      ...benchmarkCase,
      budget: {
        maxUsd: benchmarkCase.budget?.maxUsd ?? 8,
        softLimitUsd: benchmarkCase.budget?.softLimitUsd ?? 4,
        maxIterations: benchmarkCase.budget?.maxIterations ?? 3,
        maxTokens: benchmarkCase.budget?.maxTokens ?? 20_000
      }
    }))
  };
}

export async function listBuiltInSuites(): Promise<
  Array<{ suiteId: string; label: string; description: string; fixturePath: string }>
> {
  return BUILT_IN_SUITES.map((suite) => ({
    ...suite,
    fixturePath: getBuiltInFixturePath(suite.suiteId)
  }));
}

export async function runBenchmarkSuite(
  suite: BenchmarkSuite,
  runner: (benchmarkCase: BenchmarkCase) => Promise<BenchmarkCaseResult>,
  options: { now?: () => string } = {}
): Promise<BenchmarkReport> {
  const now = options.now ?? (() => new Date().toISOString());
  const startedAt = now();
  const results: BenchmarkCaseResult[] = [];

  for (const benchmarkCase of suite.cases) {
    results.push(await runner(benchmarkCase));
  }

  const finishedAt = now();
  const totalCases = results.length;
  const passedCases = results.filter((result) => result.status === "passed").length;
  const failedCases = results.filter((result) => result.status === "failed").length;
  const skippedCases = results.filter((result) => result.status === "skipped").length;
  const totalDurationMs = results.reduce((total, result) => total + result.durationMs, 0);
  const totalActualUsd = results.reduce(
    (total, result) => total + (result.loop?.cost.actualUsd ?? 0),
    0
  );
  const totalAvoidedUsd = results.reduce(
    (total, result) => total + (result.loop?.cost.avoidedUsd ?? 0),
    0
  );

  return {
    suiteId: suite.suiteId,
    label: suite.label,
    startedAt,
    finishedAt,
    results,
    summary: {
      totalCases,
      passedCases,
      failedCases,
      skippedCases,
      stubCases: results.filter((result) => result.notes.some((note) => /stub/i.test(note))).length,
      totalDurationMs,
      totalActualUsd,
      totalAvoidedUsd,
      passRate: totalCases === 0 ? 0 : Math.round((passedCases / totalCases) * 100)
    }
  };
}

export async function createStubBenchmarkRunner(
  benchmarkCase: BenchmarkCase
): Promise<BenchmarkCaseResult> {
  return {
    caseId: benchmarkCase.caseId,
    status: "passed",
    durationMs: 25,
    notes: [`Stub runner accepted ${benchmarkCase.caseId}.`]
  };
}

type BaselineAttemptScript = {
  actualUsd: number;
  summary: string;
};

type MartinAttemptScript = MartinAdapterResult;

type DeterministicScenario = {
  baseline: {
    attempts: BaselineAttemptScript[];
    result: string;
  };
  martin: {
    attempts: MartinAttemptScript[];
    result: string;
  };
  note: string;
};

const DETERMINISTIC_SCENARIOS: Record<string, DeterministicScenario> = {
  "repair-ci": {
    baseline: {
      attempts: [
        { actualUsd: 1.7, summary: "Ralph retried the same flaky CI patch without verifier proof." },
        { actualUsd: 1.7, summary: "Ralph repeated the same unverified change." },
        { actualUsd: 1.6, summary: "Ralph kept iterating on the wrong failure signature." },
        { actualUsd: 1.7, summary: "Ralph spent another attempt without stabilizing the gate." },
        { actualUsd: 1.7, summary: "Ralph exhausted the budget and still had no verified pass." }
      ],
      result: "not_verified"
    },
    martin: {
      attempts: [
        {
          status: "failed",
          summary: "The initial patch still touched the wrong branch of the flaky CI gate.",
          usage: {
            actualUsd: 1.1,
            tokensIn: 320,
            tokensOut: 140
          },
          verification: {
            passed: false,
            summary: "pnpm test still failed on the flaky CI gate."
          },
          failure: {
            message: "Repeated logic error in the retry gate."
          }
        },
        {
          status: "completed",
          summary: "Martin narrowed the scope, rewrote the gate deterministically, and cleared verification.",
          usage: {
            actualUsd: 1.2,
            tokensIn: 280,
            tokensOut: 130
          },
          verification: {
            passed: true,
            summary: "pnpm test and pnpm build passed for the flaky CI repair."
          }
        }
      ],
      result: "verified_pass"
    },
    note: "Martin verified the repair before the Ralph-style baseline burned through its budget."
  },
  "budget-guard": {
    baseline: {
      attempts: [
        { actualUsd: 1.8, summary: "Ralph retried even though the economics were deteriorating." },
        { actualUsd: 1.7, summary: "Ralph kept spending without a credible verifier recovery path." },
        { actualUsd: 1.9, summary: "Ralph looped again instead of stopping the burn." },
        { actualUsd: 1.8, summary: "Ralph finished the cycle still unverified and over budget pressure." }
      ],
      result: "looped"
    },
    martin: {
      attempts: [
        {
          status: "failed",
          summary: "Martin found the first regression but could not verify the fix.",
          usage: {
            actualUsd: 1.4,
            tokensIn: 250,
            tokensOut: 110
          },
          verification: {
            passed: false,
            summary: "pnpm test still failed after the first attempt."
          },
          failure: {
            message: "The regression remained unresolved."
          }
        },
        {
          status: "failed",
          summary: "Martin rejected a third attempt because the budget case was no longer economically credible.",
          usage: {
            actualUsd: 1.6,
            tokensIn: 230,
            tokensOut: 100
          },
          verification: {
            passed: false,
            summary: "Budget pressure remained high and pnpm test still failed."
          },
          failure: {
            message: "Budget pressure remained high after the second attempt."
          }
        }
      ],
      result: "budget_exit"
    },
    note: "Martin stopped when the economics stopped being credible."
  }
};

export function createDeterministicComparisonRunner(): (
  benchmarkCase: BenchmarkCase
) => Promise<BenchmarkCaseResult> {
  return async (benchmarkCase) => {
    const scenario = DETERMINISTIC_SCENARIOS[benchmarkCase.caseId];

    if (!scenario) {
      return createStubBenchmarkRunner(benchmarkCase);
    }

    const martinResult = await runMartin({
      workspaceId: "ws_bench",
      projectId: `proj_${benchmarkCase.caseId}`,
      task: benchmarkCase.task,
      budget: benchmarkCase.budget,
      adapter: createScriptedMartinAdapter(benchmarkCase, scenario.martin.attempts)
    });

    const comparison: BenchmarkCaseComparison = {
      baseline: summarizeBaselineOutcome(benchmarkCase, scenario),
      martin: {
        adapterId: "martin",
        attempts: martinResult.loop.attempts.length,
        spendUsd: martinResult.loop.cost.actualUsd,
        result: scenario.martin.result
      }
    };

    return {
      caseId: benchmarkCase.caseId,
      status: comparison.martin.spendUsd < comparison.baseline.spendUsd ? "passed" : "failed",
      durationMs: benchmarkCase.caseId === "repair-ci" ? 42 : 38,
      notes: [scenario.note],
      loop: martinResult.loop,
      comparison
    };
  };
}

function createScriptedMartinAdapter(
  benchmarkCase: BenchmarkCase,
  attempts: MartinAttemptScript[]
): MartinAdapter {
  return {
    adapterId: "martin:deterministic",
    kind: "direct-provider",
    label: `Deterministic Martin runner for ${benchmarkCase.caseId}`,
    metadata: {
      providerId: "openai",
      model: "gpt-5.4-mini"
    },
    async execute(request) {
      const next = attempts[request.previousAttempts.length];

      return next ?? attempts.at(-1) ?? {
        status: "failed",
        summary: "Deterministic scenario exhausted without a scripted result.",
        usage: {
          actualUsd: 0.1,
          tokensIn: 1,
          tokensOut: 1
        },
        verification: {
          passed: false,
          summary: "No scripted verification result remained."
        },
        failure: {
          message: "Missing deterministic benchmark script.",
          classHint: "environment_mismatch"
        }
      };
    }
  };
}

function summarizeBaselineOutcome(
  benchmarkCase: BenchmarkCase,
  scenario: DeterministicScenario
): BenchmarkCompetitorOutcome {
  return {
    adapterId: benchmarkCase.baseline.adapterId,
    attempts: scenario.baseline.attempts.length,
    spendUsd: roundUsd(
      scenario.baseline.attempts.reduce((total, attempt) => total + attempt.actualUsd, 0)
    ),
    result: scenario.baseline.result
  };
}

function roundUsd(value: number): number {
  return Math.round(value * 100) / 100;
}

export { runBenchmarkVariantMatrix } from "./comparison.js";
export {
  generateGoNoGoReport,
  measureBudgetEstimateVariance,
  renderGoNoGoReportMarkdown,
  runFailureReplaySuite,
  runSafetyIncidentDrills
} from "./phase7.js";
export {
  generateCertificationReport,
  renderCertificationReportMarkdown,
  runCertificationSuite
} from "./phase12.js";
export {
  generateProviderPathReport,
  renderProviderPathReportMarkdown,
  writeProviderPathReport
} from "./provider-paths.js";
