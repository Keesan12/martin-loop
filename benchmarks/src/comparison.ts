import { runMartin, type MartinAdapterResult } from "@martin/core";

import { loadBenchmarkSuiteFixture } from "./fixtures.js";
import { createStubBenchmarkRunner, runBenchmarkSuite } from "./runner.js";
import { createScriptedAdapter, roundUsd } from "./scripted-runtime.js";
import type {
  BenchmarkCase,
  BenchmarkCaseComparison,
  BenchmarkCompetitorOutcome,
  BenchmarkRunner,
  BenchmarkVariantId,
  BenchmarkVariantMatrixReport,
  BenchmarkVariantResult
} from "./types.js";

interface BaselineAttemptScript {
  actualUsd: number;
  summary: string;
}

type MartinScenario =
  | {
      mode: "single";
      attempts: MartinAdapterResult[];
      result: string;
    }
  | {
      mode: "fallback";
      primaryAttempts: MartinAdapterResult[];
      fallbackAttempts: MartinAdapterResult[];
      result: string;
    };

interface DeterministicScenario {
  baseline: {
    attempts: BaselineAttemptScript[];
    result: string;
  };
  martin: MartinScenario;
  note: string;
}

const DETERMINISTIC_SCENARIOS: Record<string, DeterministicScenario> = {
  "repair-ci": {
    baseline: {
      attempts: [
        { actualUsd: 1.7, summary: "Baseline retried the same flaky CI patch without verifier proof." },
        { actualUsd: 1.7, summary: "Baseline repeated the same unverified change." },
        { actualUsd: 1.6, summary: "Baseline kept iterating on the wrong failure signature." },
        { actualUsd: 1.7, summary: "Baseline spent another attempt without stabilizing the gate." },
        { actualUsd: 1.7, summary: "Baseline exhausted the budget and still had no verified pass." }
      ],
      result: "not_verified"
    },
    martin: {
      mode: "single",
      attempts: [
        {
          status: "failed",
          summary: "The initial patch still touched the wrong branch of the flaky CI gate.",
          usage: {
            actualUsd: 1.1,
            tokensIn: 320,
            tokensOut: 140,
            provenance: "actual"
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
            tokensOut: 130,
            provenance: "actual"
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
        { actualUsd: 1.8, summary: "Baseline retried even though the economics were deteriorating." },
        { actualUsd: 1.7, summary: "Baseline kept spending without a credible verifier recovery path." },
        { actualUsd: 1.9, summary: "Baseline looped again instead of stopping the burn." },
        { actualUsd: 1.8, summary: "Baseline finished the cycle still unverified and under budget pressure." }
      ],
      result: "looped"
    },
    martin: {
      mode: "single",
      attempts: [
        {
          status: "failed",
          summary: "Martin found the first regression but could not verify the fix.",
          usage: {
            actualUsd: 1.4,
            tokensIn: 250,
            tokensOut: 110,
            provenance: "actual"
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
            tokensOut: 100,
            provenance: "actual"
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
  },
  "adapter-failover": {
    baseline: {
      attempts: [
        { actualUsd: 1.2, summary: "Baseline retried the missing-tool environment without changing adapters." },
        { actualUsd: 1.2, summary: "Baseline hit the same missing-tool failure again." },
        { actualUsd: 1.2, summary: "Baseline exhausted retries and still never switched transports." }
      ],
      result: "stuck_exit"
    },
    martin: {
      mode: "fallback",
      primaryAttempts: [
        {
          status: "failed",
          summary: "pnpm was missing from PATH in the CLI runner.",
          usage: {
            actualUsd: 0.12,
            tokensIn: 110,
            tokensOut: 45,
            provenance: "actual"
          },
          verification: {
            passed: false,
            summary: "pnpm command not found"
          },
          failure: {
            message: "ENOENT: pnpm: command not found"
          }
        }
      ],
      fallbackAttempts: [
        {
          status: "completed",
          summary: "Fallback direct adapter recovered and passed verification.",
          usage: {
            actualUsd: 0.33,
            tokensIn: 95,
            tokensOut: 70,
            provenance: "actual"
          },
          verification: {
            passed: true,
            summary: "pnpm test passed via fallback adapter."
          }
        }
      ],
      result: "verified_pass"
    },
    note: "Martin switched adapters instead of looping on the broken CLI environment."
  }
};

export function createDeterministicComparisonRunner(
  scenarios: Record<string, DeterministicScenario> = DETERMINISTIC_SCENARIOS
): BenchmarkRunner {
  const stubRunner = createStubBenchmarkRunner({
    note: "Stub benchmark result. Add a deterministic scenario for this case."
  });

  return async (benchmarkCase, context) => {
    const scenario = scenarios[benchmarkCase.caseId];
    if (!scenario) {
      return stubRunner(benchmarkCase, context);
    }

    const martinResult = await runMartinScenario(benchmarkCase, scenario.martin);
    const comparison: BenchmarkCaseComparison = {
      baseline: summarizeBaselineOutcome(benchmarkCase, scenario),
      martin: {
        adapterId: "martin",
        attempts: martinResult.loop.attempts.length,
        spendUsd: roundUsd(martinResult.loop.cost.actualUsd),
        result: scenario.martin.result
      }
    };

    return {
      caseId: benchmarkCase.caseId,
      status: comparison.martin.spendUsd < comparison.baseline.spendUsd ? "passed" : "failed",
      durationMs: 40,
      notes: [scenario.note],
      loop: martinResult.loop,
      comparison
    };
  };
}

export async function runBenchmarkVariantMatrix(): Promise<BenchmarkVariantMatrixReport> {
  const suite = await loadBenchmarkSuiteFixture("phase7-variants");
  const report = await runBenchmarkSuite(suite, createDeterministicComparisonRunner());

  const variantResults = suite.cases.map((benchmarkCase) => {
    const result = report.results.find((entry) => entry.caseId === benchmarkCase.caseId);
    if (!result?.comparison) {
      throw new Error(`Missing deterministic comparison for benchmark case "${benchmarkCase.caseId}".`);
    }

    return {
      variantId: requireVariantId(benchmarkCase),
      caseId: benchmarkCase.caseId,
      label: benchmarkCase.label,
      status: result.status,
      notes: result.notes,
      comparison: result.comparison,
      ...(result.loop ? { loop: result.loop } : {})
    } satisfies BenchmarkVariantResult;
  });

  const baselineSpendUsd = roundUsd(
    variantResults.reduce((total, result) => total + result.comparison.baseline.spendUsd, 0)
  );
  const martinSpendUsd = roundUsd(
    variantResults.reduce((total, result) => total + result.comparison.martin.spendUsd, 0)
  );
  const passedVariants = variantResults.filter((result) => result.status === "passed").length;

  return {
    suiteId: suite.suiteId,
    label: suite.label,
    variantResults,
    summary: {
      totalVariants: variantResults.length,
      passedVariants,
      failedVariants: variantResults.length - passedVariants,
      baselineSpendUsd,
      martinSpendUsd,
      martinSpendDeltaUsd: roundUsd(baselineSpendUsd - martinSpendUsd),
      martinWinRate:
        variantResults.length === 0 ? 0 : Math.round((passedVariants / variantResults.length) * 100)
    }
  };
}

async function runMartinScenario(benchmarkCase: BenchmarkCase, scenario: MartinScenario) {
  if (scenario.mode === "single") {
    return runMartin({
      workspaceId: "ws_bench",
      projectId: `proj_${benchmarkCase.caseId}`,
      task: benchmarkCase.task,
      budget: benchmarkCase.budget,
      adapter: createScriptedAdapter({
        adapterId: "martin:deterministic",
        kind: "direct-provider",
        label: `Deterministic Martin runner for ${benchmarkCase.caseId}`,
        providerId: "openai",
        model: "gpt-5.4-mini",
        transport: "http",
        attempts: scenario.attempts
      })
    });
  }

  return runMartin({
    workspaceId: "ws_bench",
    projectId: `proj_${benchmarkCase.caseId}`,
    task: benchmarkCase.task,
    budget: benchmarkCase.budget,
    adapter: createScriptedAdapter({
      adapterId: "agent-cli:baseline-primary",
      kind: "agent-cli",
      label: `Primary CLI adapter for ${benchmarkCase.caseId}`,
      providerId: "claude",
      model: "claude-sonnet-4-6",
      transport: "cli",
      attempts: scenario.primaryAttempts
    }),
    fallbackAdapters: [
      createScriptedAdapter({
        adapterId: "direct:openai:gpt-5.4-mini",
        kind: "direct-provider",
        label: `Fallback direct adapter for ${benchmarkCase.caseId}`,
        providerId: "openai",
        model: "gpt-5.4-mini",
        transport: "http",
        attempts: scenario.fallbackAttempts
      })
    ]
  });
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

function requireVariantId(benchmarkCase: BenchmarkCase): BenchmarkVariantId {
  const variantId = benchmarkCase.metadata?.variantId;
  if (variantId === "A" || variantId === "B" || variantId === "C") {
    return variantId;
  }

  throw new Error(`Benchmark case "${benchmarkCase.caseId}" is missing a valid Phase 7 variantId.`);
}
