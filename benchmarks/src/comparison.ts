import type { MartinAdapterResult } from "@martin/core";

import { roundUsd, sum } from "./scripted-runtime.js";
import type { BenchmarkCase, BenchmarkCaseComparison, BenchmarkCaseResult } from "./types.js";

export interface DeterministicScenario {
  baseline: {
    attempts: Array<{
      actualUsd: number;
      summary: string;
    }>;
    result: string;
  };
  martin:
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
  note: string;
}

export type BenchmarkComparisonRunner = (
  benchmarkCase: BenchmarkCase
) => Promise<BenchmarkCaseResult>;

function summarizeMartinAttempts(
  scenario: DeterministicScenario["martin"]
): { attempts: MartinAdapterResult[]; result: string } {
  if (scenario.mode === "fallback") {
    return {
      attempts: [...scenario.primaryAttempts, ...scenario.fallbackAttempts],
      result: scenario.result
    };
  }

  return {
    attempts: scenario.attempts,
    result: scenario.result
  };
}

function buildComparison(
  scenario: DeterministicScenario
): BenchmarkCaseComparison {
  const martin = summarizeMartinAttempts(scenario.martin);
  const baselineSpendUsd = roundUsd(sum(scenario.baseline.attempts.map((attempt) => attempt.actualUsd)));
  const martinSpendUsd = roundUsd(
    sum(martin.attempts.map((attempt) => attempt.usage.actualUsd))
  );

  return {
    baseline: {
      attempts: scenario.baseline.attempts.length,
      spendUsd: baselineSpendUsd,
      result: scenario.baseline.result,
      summary: scenario.baseline.attempts.at(-1)?.summary ?? "No baseline summary recorded."
    },
    martin: {
      attempts: martin.attempts.length,
      spendUsd: martinSpendUsd,
      result: martin.result,
      summary: martin.attempts.at(-1)?.summary ?? "No Martin summary recorded."
    },
    martinSpendDeltaUsd: roundUsd(martinSpendUsd - baselineSpendUsd),
    note: scenario.note
  };
}

export function createDeterministicComparisonRunner(
  scenarios: Record<string, DeterministicScenario>
): BenchmarkComparisonRunner {
  return async (benchmarkCase) => {
    const scenario = scenarios[benchmarkCase.caseId];
    if (!scenario) {
      return {
        caseId: benchmarkCase.caseId,
        label: benchmarkCase.label,
        status: "stub"
      };
    }

    return {
      caseId: benchmarkCase.caseId,
      label: benchmarkCase.label,
      status: "passed",
      comparison: buildComparison(scenario)
    };
  };
}
