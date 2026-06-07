export interface BenchmarkTask {
  title: string;
  objective: string;
  verificationPlan: string[];
}

export interface BenchmarkBudget {
  maxUsd: number;
  softLimitUsd: number;
  maxIterations: number;
  maxTokens: number;
}

export interface BenchmarkCase {
  caseId: string;
  label: string;
  task: BenchmarkTask;
  budget: BenchmarkBudget;
  baseline: {
    adapterId: string;
    model: string;
    strategy: string;
  };
  tags?: string[];
  metadata?: Record<string, string>;
}

export interface BenchmarkSuite {
  suiteId: string;
  label: string;
  description: string;
  baselineAdapter: string;
  cases: BenchmarkCase[];
}

export interface BenchmarkLaneSummary {
  attempts: number;
  spendUsd: number;
  result: string;
  summary: string;
}

export interface BenchmarkCaseComparison {
  baseline: BenchmarkLaneSummary;
  martin: BenchmarkLaneSummary;
  martinSpendDeltaUsd: number;
  note: string;
}

export interface BenchmarkCaseResult {
  caseId: string;
  label: string;
  status: "passed" | "failed" | "stub";
  comparison?: BenchmarkCaseComparison;
}

export interface BenchmarkRunSummary {
  totalCases: number;
  passedCases: number;
  failedCases: number;
  stubCases: number;
  totalActualUsd: number;
  passRate: number;
}

export interface BenchmarkRunReport {
  suiteId: string;
  label: string;
  generatedAt: string;
  results: BenchmarkCaseResult[];
  summary: BenchmarkRunSummary;
}

export interface Under3ChallengeFixture {
  suiteId: string;
  label: string;
  description: string;
  task: BenchmarkTask;
  martin: {
    spendUsd: number;
    attempts: number;
    status: string;
    lifecycleState: string;
    verifierStatus: string;
    summary: string;
  };
  baseline: {
    spendUsd: number;
    attempts: number;
    status: string;
    lifecycleState: string;
    verifierStatus: string;
    summary: string;
  };
}

export interface Under3ChallengeReport extends Under3ChallengeFixture {
  generatedAt: string;
  martinSpendDeltaUsd: number;
}
