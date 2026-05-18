import {
  buildPortfolioSnapshot,
  createLoopRecord,
  type LoopRecord
} from "@martin/contracts";

import type {
  BenchmarkCase,
  BenchmarkCaseResult,
  BenchmarkRunOptions,
  BenchmarkRunReport,
  BenchmarkRunner,
  BenchmarkSuite,
  StubBenchmarkRunnerOptions
} from "./types.js";

export async function runBenchmarkSuite(
  suite: BenchmarkSuite,
  runner: BenchmarkRunner,
  options: BenchmarkRunOptions = {}
): Promise<BenchmarkRunReport> {
  const now = options.now ?? defaultNow;
  const startedAt = now();
  const results: BenchmarkCaseResult[] = [];

  for (const [index, benchmarkCase] of suite.cases.entries()) {
    const result = await runner(benchmarkCase, {
      suite,
      index,
      startedAt
    });

    results.push(result);
  }

  const finishedAt = now();
  const loops = results.flatMap((result) => (result.loop ? [result.loop] : []));
  const passedCases = results.filter((result) => result.status === "passed").length;
  const failedCases = results.filter((result) => result.status === "failed").length;
  const skippedCases = results.filter((result) => result.status === "skipped").length;
  const stubCases = results.filter((result) => result.status === "stub").length;
  const totalDurationMs = results.reduce((total, result) => total + result.durationMs, 0);
  const portfolio = buildPortfolioSnapshot(loops);

  return {
    suiteId: suite.suiteId,
    label: suite.label,
    baselineAdapter: suite.baselineAdapter,
    startedAt,
    finishedAt,
    results,
    summary: {
      ...portfolio,
      totalCases: suite.cases.length,
      passedCases,
      failedCases,
      skippedCases,
      stubCases,
      totalDurationMs,
      passRate: suite.cases.length === 0 ? 0 : Math.round((passedCases / suite.cases.length) * 100)
    }
  };
}

export function createStubBenchmarkRunner(
  options: StubBenchmarkRunnerOptions = {}
): BenchmarkRunner {
  const now = options.now ?? defaultNow;
  const workspaceId = options.workspaceId ?? "ws_bench";
  const projectId = options.projectId ?? "proj_baseline";
  const note =
    options.note ??
    "Stub benchmark result. Wire a concrete adapter runner here when @martin/core lands.";

  return async (benchmarkCase, context) => ({
    caseId: benchmarkCase.caseId,
    status: "stub",
    durationMs: 0,
    notes: [note],
    loop: createStubLoopRecord(benchmarkCase, context.suite.suiteId, workspaceId, projectId, now())
  });
}

function createStubLoopRecord(
  benchmarkCase: BenchmarkCase,
  suiteId: string,
  workspaceId: string,
  projectId: string,
  timestamp: string
): LoopRecord {
  const metadata: Record<string, string> = {
    benchmarkCaseId: benchmarkCase.caseId,
    benchmarkSuiteId: suiteId,
    baselineAdapter: benchmarkCase.baseline.adapterId
  };

  if (benchmarkCase.metadata) {
    Object.assign(metadata, benchmarkCase.metadata);
  }

  return createLoopRecord(
    {
      workspaceId,
      projectId,
      task: benchmarkCase.task,
      budget: benchmarkCase.budget,
      metadata
    },
    {
      now: timestamp
    }
  );
}

function defaultNow(): string {
  return new Date().toISOString();
}
