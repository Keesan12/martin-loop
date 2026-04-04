import type {
  CostProvenance,
  LoopBudget,
  LoopRecord,
  LoopTask,
  PortfolioSnapshot
} from "@martin/contracts";

export type BenchmarkCaseStatus = "passed" | "failed" | "skipped" | "stub";

export interface BenchmarkBaseline {
  adapterId: string;
  model: string;
  strategy: string;
}

export interface BenchmarkCase {
  caseId: string;
  label: string;
  task: LoopTask;
  budget: LoopBudget;
  baseline: BenchmarkBaseline;
  tags: string[];
  metadata?: Record<string, string>;
}

export interface BenchmarkSuite {
  suiteId: string;
  label: string;
  description: string;
  baselineAdapter: string;
  cases: BenchmarkCase[];
}

export interface BenchmarkSuiteManifest {
  suiteId: string;
  label: string;
  description: string;
  baselineAdapter: string;
  caseCount: number;
  fixturePath: string;
}

export interface BenchmarkCaseResult {
  caseId: string;
  status: BenchmarkCaseStatus;
  durationMs: number;
  notes: string[];
  loop?: LoopRecord;
  comparison?: BenchmarkCaseComparison;
}

export interface BenchmarkSummary extends PortfolioSnapshot {
  totalCases: number;
  passedCases: number;
  failedCases: number;
  skippedCases: number;
  stubCases: number;
  totalDurationMs: number;
  passRate: number;
}

export interface BenchmarkRunReport {
  suiteId: string;
  label: string;
  baselineAdapter: string;
  startedAt: string;
  finishedAt: string;
  results: BenchmarkCaseResult[];
  summary: BenchmarkSummary;
}

export interface BenchmarkRunnerContext {
  suite: BenchmarkSuite;
  index: number;
  startedAt: string;
}

export type BenchmarkRunner = (
  benchmarkCase: BenchmarkCase,
  context: BenchmarkRunnerContext
) => Promise<BenchmarkCaseResult>;

export interface BenchmarkRunOptions {
  now?: () => string;
}

export interface StubBenchmarkRunnerOptions {
  now?: () => string;
  workspaceId?: string;
  projectId?: string;
  note?: string;
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

export type BenchmarkVariantId = "A" | "B" | "C";

export interface BenchmarkVariantResult {
  variantId: BenchmarkVariantId;
  caseId: string;
  label: string;
  status: BenchmarkCaseStatus;
  notes: string[];
  comparison: BenchmarkCaseComparison;
  loop?: LoopRecord;
}

export interface BenchmarkVariantMatrixReport {
  suiteId: string;
  label: string;
  variantResults: BenchmarkVariantResult[];
  summary: {
    totalVariants: number;
    passedVariants: number;
    failedVariants: number;
    baselineSpendUsd: number;
    martinSpendUsd: number;
    martinSpendDeltaUsd: number;
    martinWinRate: number;
  };
}

export interface ReplayScenarioResult {
  caseId: string;
  label: string;
  status: "passed" | "failed";
  expectedLifecycle: string;
  actualLifecycle: string;
  notes: string[];
  loop?: LoopRecord;
}

export interface FailureReplayReport {
  cases: ReplayScenarioResult[];
  passedCases: number;
  failedCases: number;
}

export interface SafetyDrillReport {
  drills: ReplayScenarioResult[];
  blockedCount: number;
  failedCount: number;
}

export interface BudgetVarianceRun {
  runId: string;
  estimatedUsd: number;
  actualUsd: number;
  varianceUsd: number;
  provenance: CostProvenance;
}

export interface BudgetVarianceReport {
  sampleSize: number;
  averageAbsVarianceUsd: number;
  maxAbsVarianceUsd: number;
  actualTotalUsd: number;
  estimatedTotalUsd: number;
  runs: BudgetVarianceRun[];
}

export interface GoNoGoGate {
  label: string;
  passed: boolean;
  detail: string;
}

export interface GoNoGoReport {
  generatedAt: string;
  verdict: "go" | "no_go";
  benchmarkMatrix: BenchmarkVariantMatrixReport;
  failureReplay: FailureReplayReport;
  safetyDrills: SafetyDrillReport;
  budgetVariance: BudgetVarianceReport;
  gates: GoNoGoGate[];
  summary: string[];
  blockers: string[];
}

export type CertificationEvidenceKey =
  | "contract"
  | "compiled_context"
  | "adapter_request"
  | "verifier_artifact"
  | "grounding_artifact"
  | "budget_artifact"
  | "patch_decision_artifact"
  | "safety_event"
  | "read_model_summary";

export interface CertificationAdapterRequest {
  attemptIndex: number;
  adapterId: string | null;
  providerId: string | null;
  model: string | null;
  transport: string | null;
}

export interface CertificationVerifierArtifact {
  attemptIndex: number;
  passed: boolean;
  summary: string | null;
}

export interface CertificationBudgetArtifact {
  kind: "budget.settled" | "attempt.rejected";
  attemptIndex: number | null;
  provenance: CostProvenance | null;
  varianceUsd: number | null;
  summary: string | null;
}

export interface CertificationSafetyEvent {
  attemptIndex: number | null;
  surface: string | null;
  blocked: boolean;
  profile: string | null;
}

export interface CertificationReadModelAttemptSummary {
  attemptIndex: number;
  patchDecision: string | null;
  patchReasonCodes: string[];
  groundingViolationCount: number;
  safetySurface: string | null;
  safetyBlocked: boolean;
  budgetProvenance: CostProvenance | null;
  budgetVarianceUsd: number;
}

export interface CertificationReadModelSummary {
  runId: string;
  lifecycleState: string;
  status: string;
  stopReason: string | null;
  costProvenance: CostProvenance;
  actualUsd: number;
  estimatedUsd: number;
  budgetVarianceUsd: number;
  latestPatchDecision: string | null;
  groundingViolationCount: number;
  blockedSafetyViolationCount: number;
  attempts: CertificationReadModelAttemptSummary[];
}

export interface CertificationEvidencePackage {
  runDirectory: string;
  contractPath: string | null;
  compiledContextPaths: string[];
  adapterRequests: CertificationAdapterRequest[];
  verifierArtifacts: CertificationVerifierArtifact[];
  groundingArtifactPaths: string[];
  budgetArtifacts: CertificationBudgetArtifact[];
  patchDecisionPaths: string[];
  safetyEvents: CertificationSafetyEvent[];
  readModelSummary: CertificationReadModelSummary | null;
}

export interface CertificationScenarioResult {
  caseId: string;
  label: string;
  status: "passed" | "failed";
  expectedLifecycle: string;
  actualLifecycle: string;
  requiredEvidence: CertificationEvidenceKey[];
  missingEvidence: CertificationEvidenceKey[];
  notes: string[];
  evidence: CertificationEvidencePackage;
}

export interface CertificationGate {
  label: string;
  passed: boolean;
  detail: string;
}

export interface CertificationReport {
  generatedAt: string;
  verdict: "go" | "no_go";
  scenarios: CertificationScenarioResult[];
  gates: CertificationGate[];
  summary: string[];
  blockers: string[];
}

export type ProviderPathRcStatus = "supported_for_rc" | "unsupported_for_rc";
export type ProviderPathAccountingMode = "exact" | "estimated_only" | "unavailable";
export type ProviderPathVerdict = "go" | "no_go";

export interface ProviderPathSurface {
  surfaceId: string;
  label: string;
  kind: "agent-cli" | "direct-provider";
  providerId: string;
  model: string;
  transport: "cli" | "http" | "routed_http";
  rcStatus: ProviderPathRcStatus;
  accountingMode: ProviderPathAccountingMode;
  usageSettlementCapable: boolean;
  executionStatus: "completed" | "failed";
  usageProvenance: CostProvenance;
  notes: string[];
}

export interface ProviderPathReport {
  generatedAt: string;
  verdict: ProviderPathVerdict;
  surfaces: ProviderPathSurface[];
  summary: {
    totalSurfaces: number;
    supportedForRc: number;
    unsupportedForRc: number;
    exactAccounting: number;
    estimatedOnly: number;
    unavailableAccounting: number;
  };
}
