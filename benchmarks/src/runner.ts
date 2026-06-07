import { roundUsd, sum } from "./scripted-runtime.js";
import type {
  BenchmarkCaseResult,
  BenchmarkRunReport,
  BenchmarkSuite
} from "./types.js";
import type { BenchmarkComparisonRunner } from "./comparison.js";

export async function runBenchmarkSuite(
  suite: BenchmarkSuite,
  runner: BenchmarkComparisonRunner,
  options: { now?: () => string } = {}
): Promise<BenchmarkRunReport> {
  const now = options.now ?? (() => new Date().toISOString());
  const results: BenchmarkCaseResult[] = [];

  for (const benchmarkCase of suite.cases) {
    results.push(await runner(benchmarkCase));
  }

  const totalCases = results.length;
  const passedCases = results.filter((result) => result.status === "passed").length;
  const failedCases = results.filter((result) => result.status === "failed").length;
  const stubCases = results.filter((result) => result.status === "stub").length;
  const totalActualUsd = roundUsd(
    sum(
      results.map((result) => result.comparison?.martin.spendUsd ?? 0)
    )
  );

  return {
    suiteId: suite.suiteId,
    label: suite.label,
    generatedAt: now(),
    results,
    summary: {
      totalCases,
      passedCases,
      failedCases,
      stubCases,
      totalActualUsd,
      passRate: totalCases === 0 ? 0 : Math.round((passedCases / totalCases) * 100)
    }
  };
}
