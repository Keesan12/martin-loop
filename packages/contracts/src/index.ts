export type LoopStatus =
  | "queued"
  | "running"
  | "verifying"
  | "completed"
  | "failed"
  | "exited";

export type LoopLifecycleState =
  | "created"
  | "running"
  | "verifying"
  | "completed"
  | "budget_exit"
  | "diminishing_returns"
  | "stuck_exit"
  | "human_escalation";

export type FailureClass =
  | "logic_error"
  | "hallucination"
  | "syntax_error"
  | "type_error"
  | "test_regression"
  | "scope_creep"
  | "no_progress"
  | "repo_grounding_failure"
  | "verification_failure"
  | "environment_mismatch"
  | "budget_pressure";

export type InterventionType =
  | "compress_context"
  | "change_model"
  | "tighten_task"
  | "switch_adapter"
  | "run_verifier"
  | "escalate_human"
  | "stop_loop";

export type LoopEventType =
  | "run.started"
  | "attempt.started"
  | "attempt.completed"
  | "failure.classified"
  | "intervention.selected"
  | "verification.completed"
  | "budget.updated"
  | "run.completed";

export interface LoopTask {
  title: string;
  objective: string;
  repoRoot?: string;
  verificationPlan: string[];
  verificationStack?: VerificationStep[];
  executionProfile?: ExecutionProfile;
  allowedNetworkDomains?: string[];
  approvalPolicy?: ApprovalPolicy;
  /** Glob patterns for files the agent is allowed to modify. Empty = no restriction. */
  allowedPaths?: string[];
  /** Glob patterns for files the agent must never modify. */
  deniedPaths?: string[];
  /** Human-readable acceptance criteria injected into the prompt as a checklist. */
  acceptanceCriteria?: string[];
}

export type ExecutionProfile =
  | "strict_local"
  | "ci_safe"
  | "staging_controlled"
  | "research_untrusted";

export interface ApprovalPolicy {
  dependencyAdds?: boolean;
  migrations?: boolean;
  configChanges?: boolean;
  externalWrites?: boolean;
}

export interface VerificationStep {
  /** Shell command to run. */
  command: string;
  /** Classification for reporting and intervention selection. */
  type: "lint" | "typecheck" | "test_targeted" | "test_full" | "custom";
  /** Stop the verification stack immediately on failure. Defaults to true. */
  fastFail?: boolean;
  /** Relative weight for partial scoring (0.0-1.0). */
  weight?: number;
}

export interface LoopBudget {
  maxUsd: number;
  softLimitUsd: number;
  maxIterations: number;
  maxTokens: number;
}

export interface LoopCost {
  actualUsd: number;
  avoidedUsd: number;
  tokensIn: number;
  tokensOut: number;
}

export interface LoopArtifact {
  artifactId: string;
  kind: "diff" | "trace" | "report" | "transcript" | "screenshot" | "other";
  label: string;
  uri: string;
}

export interface LoopAttempt {
  attemptId: string;
  index: number;
  adapterId: string;
  model: string;
  startedAt: string;
  completedAt?: string;
  summary?: string;
  failureClass?: FailureClass;
  intervention?: InterventionType;
}

export interface LoopEvent {
  eventId: string;
  type: LoopEventType;
  timestamp: string;
  lifecycleState: LoopLifecycleState;
  payload: Record<string, unknown>;
}

export interface LoopRecord {
  loopId: string;
  workspaceId: string;
  projectId: string;
  teamId?: string;
  status: LoopStatus;
  lifecycleState: LoopLifecycleState;
  task: LoopTask;
  budget: LoopBudget;
  cost: LoopCost;
  artifacts: LoopArtifact[];
  attempts: LoopAttempt[];
  events: LoopEvent[];
  metadata: Record<string, string>;
  createdAt: string;
  updatedAt: string;
}

export interface LoopRecordDraft {
  loopId?: string;
  workspaceId: string;
  projectId: string;
  teamId?: string;
  status?: LoopStatus;
  lifecycleState?: LoopLifecycleState;
  task: LoopTask;
  budget?: Partial<LoopBudget>;
  cost?: Partial<LoopCost>;
  artifacts?: LoopArtifact[];
  attempts?: LoopAttempt[];
  events?: LoopEvent[];
  metadata?: Record<string, string>;
  createdAt?: string;
  updatedAt?: string;
}

export interface LoopEventDraft {
  type: LoopEventType;
  lifecycleState?: LoopLifecycleState;
  payload: Record<string, unknown>;
  timestamp?: string;
}

export type TelemetryEnvironment = "local" | "ci" | "staging" | "production";

export interface TelemetrySource {
  runtimeVersion: string;
  adapterId: string;
  provider: string;
  model: string;
}

export interface TelemetryEvent {
  eventId: string;
  loopId: string;
  attemptId?: string;
  type: LoopEventType;
  lifecycleState: LoopLifecycleState;
  timestamp: string;
  sequence: number;
  payload: Record<string, unknown>;
}

export interface TelemetryEventDraft {
  loopId: string;
  attemptId?: string;
  type: LoopEventType;
  lifecycleState: LoopLifecycleState;
  timestamp?: string;
  payload: Record<string, unknown>;
}

export interface TelemetryEnvelope {
  schemaVersion: string;
  envelopeId: string;
  workspaceId: string;
  projectId: string;
  ingestKeyId: string;
  environment: TelemetryEnvironment;
  emittedAt: string;
  sequence: number;
  source: TelemetrySource;
  events: TelemetryEvent[];
}

export interface TelemetryEnvelopeDraft {
  schemaVersion?: string;
  workspaceId: string;
  projectId: string;
  ingestKeyId: string;
  environment: TelemetryEnvironment;
  source: TelemetrySource;
  events: TelemetryEventDraft[];
}

export interface TelemetryLoopSnapshot {
  loopId: string;
  status: LoopStatus;
  lifecycleState: LoopLifecycleState;
  cost: LoopCost;
}

export interface TelemetryBatch {
  workspaceId: string;
  projectId: string;
  loops: TelemetryLoopSnapshot[];
}

export interface ValidationResult {
  ok: boolean;
  errors: string[];
}

export interface PortfolioSnapshot {
  totalActualUsd: number;
  totalAvoidedUsd: number;
  totalTokensIn: number;
  totalTokensOut: number;
  activeLoops: number;
  optimizedLoops: number;
  failuresCaught: number;
  averageExitSeconds: number;
}

export interface ContractOptions {
  now?: string;
  idFactory?: (prefix: string) => string;
}

export const DEFAULT_BUDGET: LoopBudget = {
  maxUsd: 25,
  softLimitUsd: 15,
  maxIterations: 8,
  maxTokens: 80_000
};

export const EMPTY_COST: LoopCost = {
  actualUsd: 0,
  avoidedUsd: 0,
  tokensIn: 0,
  tokensOut: 0
};

export function createLoopRecord(
  draft: LoopRecordDraft,
  options: ContractOptions = {}
): LoopRecord {
  const now = options.now ?? new Date().toISOString();

  return {
    loopId: draft.loopId ?? makeId("loop", options),
    workspaceId: draft.workspaceId,
    projectId: draft.projectId,
    status: draft.status ?? "queued",
    lifecycleState: draft.lifecycleState ?? "created",
    task: draft.task,
    budget: {
      ...DEFAULT_BUDGET,
      ...draft.budget
    },
    cost: {
      ...EMPTY_COST,
      ...draft.cost
    },
    artifacts: [...(draft.artifacts ?? [])],
    attempts: [...(draft.attempts ?? [])],
    events: [...(draft.events ?? [])],
    metadata: {
      ...(draft.metadata ?? {})
    },
    createdAt: draft.createdAt ?? now,
    updatedAt: draft.updatedAt ?? now,
    ...(draft.teamId ? { teamId: draft.teamId } : {})
  };
}

export function appendLoopEvent(
  loop: LoopRecord,
  eventDraft: LoopEventDraft,
  options: ContractOptions = {}
): LoopRecord {
  const timestamp = eventDraft.timestamp ?? options.now ?? new Date().toISOString();
  const lifecycleState = eventDraft.lifecycleState ?? loop.lifecycleState;

  const event: LoopEvent = {
    eventId: makeId("evt", options),
    type: eventDraft.type,
    timestamp,
    lifecycleState,
    payload: eventDraft.payload
  };

  return {
    ...loop,
    lifecycleState,
    status: nextStatus(loop.status, event.type),
    events: [...loop.events, event],
    updatedAt: timestamp
  };
}

export function validateTelemetryBatch(batch: TelemetryBatch): ValidationResult {
  const errors: string[] = [];

  if (!hasText(batch.workspaceId)) {
    errors.push("workspaceId is required");
  }

  if (!hasText(batch.projectId)) {
    errors.push("projectId is required");
  }

  batch.loops.forEach((loop, index) => {
    if (!hasText(loop.loopId)) {
      errors.push(`loop[${index}].loopId is required`);
    }

    if (loop.cost.actualUsd < 0) {
      errors.push(`loop[${index}].cost.actualUsd must be greater than or equal to 0`);
    }

    if (loop.cost.avoidedUsd < 0) {
      errors.push(`loop[${index}].cost.avoidedUsd must be greater than or equal to 0`);
    }

    if (loop.cost.tokensIn < 0) {
      errors.push(`loop[${index}].cost.tokensIn must be greater than or equal to 0`);
    }

    if (loop.cost.tokensOut < 0) {
      errors.push(`loop[${index}].cost.tokensOut must be greater than or equal to 0`);
    }
  });

  return {
    ok: errors.length === 0,
    errors
  };
}

export function buildPortfolioSnapshot(loops: LoopRecord[]): PortfolioSnapshot {
  const exitedLoops = loops.filter((loop) =>
    ["completed", "budget_exit", "diminishing_returns", "stuck_exit", "human_escalation"].includes(
      loop.lifecycleState
    )
  );

  const totalExitSeconds = exitedLoops.reduce((total, loop) => {
    const created = Date.parse(loop.createdAt);
    const updated = Date.parse(loop.updatedAt);

    if (Number.isNaN(created) || Number.isNaN(updated) || updated < created) {
      return total;
    }

    return total + Math.round((updated - created) / 1000);
  }, 0);

  return {
    totalActualUsd: loops.reduce((total, loop) => total + loop.cost.actualUsd, 0),
    totalAvoidedUsd: loops.reduce((total, loop) => total + loop.cost.avoidedUsd, 0),
    totalTokensIn: loops.reduce((total, loop) => total + loop.cost.tokensIn, 0),
    totalTokensOut: loops.reduce((total, loop) => total + loop.cost.tokensOut, 0),
    activeLoops: loops.filter((loop) => ["queued", "running", "verifying"].includes(loop.status))
      .length,
    optimizedLoops: loops.filter((loop) => loop.cost.avoidedUsd > loop.cost.actualUsd).length,
    failuresCaught: loops.reduce(
      (total, loop) =>
        total + loop.events.filter((event) => event.type === "failure.classified").length,
      0
    ),
    averageExitSeconds:
      exitedLoops.length === 0 ? 0 : Math.round(totalExitSeconds / exitedLoops.length)
  };
}

export function createTelemetryEnvelope(
  draft: TelemetryEnvelopeDraft,
  options: ContractOptions = {}
): TelemetryEnvelope {
  const emittedAt = options.now ?? new Date().toISOString();
  const usedIds = new Set<string>();

  return {
    schemaVersion: draft.schemaVersion ?? "martin.telemetry.v1",
    envelopeId: makeId("env", options),
    workspaceId: draft.workspaceId,
    projectId: draft.projectId,
    ingestKeyId: draft.ingestKeyId,
    environment: draft.environment,
    emittedAt,
    sequence: draft.events.length,
    source: draft.source,
    events: draft.events.map((event, index) => {
      const baseId = makeId("evt", options);
      const eventId = usedIds.has(baseId) ? `${baseId}_${index + 1}` : baseId;
      usedIds.add(eventId);

      return {
        eventId,
        loopId: event.loopId,
        type: event.type,
        lifecycleState: event.lifecycleState,
        timestamp: event.timestamp ?? emittedAt,
        sequence: index + 1,
        payload: event.payload,
        ...(event.attemptId ? { attemptId: event.attemptId } : {})
      };
    })
  };
}

export function validateTelemetryEnvelope(envelope: TelemetryEnvelope): ValidationResult {
  const errors: string[] = [];

  if (!hasText(envelope.schemaVersion)) {
    errors.push("schemaVersion is required");
  }

  if (!hasText(envelope.workspaceId)) {
    errors.push("workspaceId is required");
  }

  if (!hasText(envelope.projectId)) {
    errors.push("projectId is required");
  }

  if (!hasText(envelope.ingestKeyId)) {
    errors.push("ingestKeyId is required");
  }

  if (envelope.sequence !== envelope.events.length) {
    errors.push("sequence must equal the number of events in the envelope");
  }

  const sequenceLooksValid = envelope.events.every((event, index) => event.sequence === index + 1);
  if (!sequenceLooksValid) {
    errors.push("events must use a strictly increasing sequence starting at 1");
  }

  envelope.events.forEach((event, index) => {
    if (!hasText(event.eventId)) {
      errors.push(`events[${index}].eventId is required`);
    }

    if (!hasText(event.loopId)) {
      errors.push(`events[${index}].loopId is required`);
    }
  });

  return {
    ok: errors.length === 0,
    errors
  };
}

function makeId(prefix: string, options: ContractOptions): string {
  if (options.idFactory) {
    return options.idFactory(prefix);
  }

  const entropy = Math.random().toString(36).slice(2, 10);
  return `${prefix}_${entropy}`;
}

function nextStatus(current: LoopStatus, eventType: LoopEventType): LoopStatus {
  switch (eventType) {
    case "run.started":
    case "attempt.started":
    case "attempt.completed":
    case "failure.classified":
    case "intervention.selected":
    case "budget.updated":
      return "running";
    case "verification.completed":
      return "verifying";
    case "run.completed":
      return current === "failed" ? "failed" : "completed";
    default:
      return current;
  }
}

function hasText(value: string | undefined): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

// ─── Phase 2: Runtime State Machine Types ───────────────────────────────────

export type PolicyPhase =
  | "GATHER"
  | "ADMIT"
  | "PATCH"
  | "VERIFY"
  | "RECOVER"
  | "ESCALATE"
  | "ABORT"
  | "HANDOFF";

export interface EvidenceVector {
  /** Count of compile/build errors in the last attempt output. */
  compileErrors: number;
  /** Count of TypeScript type errors. */
  typeErrors: number;
  /** Count of failing test cases. */
  failingTests: number;
  /** Verifier score 0.0–1.0 (1.0 = full pass). */
  verifierScore: number;
  /** Patch novelty 0.0–1.0 (0.0 = identical to previous attempt). */
  diffNovelty: number;
  /** Number of forbidden files touched by the last patch. */
  forbiddenTouchedFileCount: number;
  /** Count of unresolvable symbols/modules referenced in the patch. */
  missingSymbolCount: number;
  /** Actual USD cost divided by verifier score improvement. */
  costPerProgressUnit: number;
  /** How many times this failure surface has been retried. */
  retryCountForSurface: number;
  /** Safety risk score 0.0–1.0 from leash evaluation. */
  safetyRiskScore: number;
}

export interface MachineState {
  phase: PolicyPhase;
  currentAttempt: number;
  activeModel: string;
  remainingBudgetUsd: number;
  /** Retry counter per FailureClass surface. */
  attemptCountersBySurface: Record<string, number>;
  lastFailureSurface?: FailureClass;
  lastVerifierScore: number;
  openAlerts: string[];
  policyHistory: Array<{
    phase: PolicyPhase;
    reason: string;
    timestamp: string;
  }>;
}

// ─── Phase 4: Budget Governor v3 Types ──────────────────────────────────────

/**
 * Cost provenance label — every budget metric must carry this.
 * Never conflate actual with estimated or unavailable.
 */
export type CostProvenance = "actual" | "estimated" | "unavailable";

/**
 * Per-attempt budget preflight estimate produced before admission.
 * Used to gate attempts before any tokens are spent.
 */
export interface BudgetPreflightEstimate {
  estimatedPromptTokens: number;
  estimatedToolOverheadTokens: number;
  estimatedOutputTokensMax: number;
  estimatedVerifierCostUsd: number;
  estimatedAttemptCostUsd: number;
  provenance: CostProvenance;
}

/**
 * Actual cost settlement written to the ledger after an attempt completes.
 * Separates patch cost from verification cost.
 */
export interface BudgetSettlement {
  runId: string;
  attemptIndex: number;
  patchCost: {
    usd: number;
    tokensIn: number;
    tokensOut: number;
    provenance: CostProvenance;
  };
  verificationCost: {
    usd: number;
    provenance: CostProvenance;
  };
  totalActualUsd: number;
  preflightEstimateUsd: number;
  varianceUsd: number;
  settledAt: string;
}

// ─── Phase 10: Patch Truth + Keep/Discard ───────────────────────────────────

export type PatchDecision = "KEEP" | "DISCARD" | "ESCALATE" | "HANDOFF";

export type PatchDecisionReasonCode =
  | "verifier_passed"
  | "verifier_regressed"
  | "grounding_failure"
  | "scope_violation"
  | "no_code_change"
  | "large_diff_no_improvement"
  | "low_novelty_no_progress"
  | "human_approval_required"
  | "safety_violation"
  | "verifier_not_improved";

export interface PatchScore {
  score: number;
  verifierScore: number;
  verifierDelta: number;
  groundingViolationCount: number;
  scopeViolationCount: number;
  safetyViolationCount: number;
  changedFileCount: number;
  diffRiskScore: number;
  noveltyScore: number;
  costUsd: number;
  reasonCodes: PatchDecisionReasonCode[];
}

export interface PatchDecisionArtifact {
  decision: PatchDecision;
  summary: string;
  reasonCodes: PatchDecisionReasonCode[];
}

export type RollbackBoundaryStrategy = "git_head_plus_snapshot" | "no_repo_root";

export interface RollbackFileSnapshot {
  path: string;
  existed: boolean;
  encoding: "base64";
  contentBase64?: string;
}

export interface RollbackBoundaryArtifact {
  strategy: RollbackBoundaryStrategy;
  capturedAt: string;
  headRef?: string;
  trackedDirtyFiles: string[];
  untrackedFiles: string[];
  snapshots: RollbackFileSnapshot[];
}

export type RollbackOutcomeStatus = "restored" | "not_required" | "failed" | "unavailable";

export interface RollbackOutcomeArtifact {
  attempted: boolean;
  status: RollbackOutcomeStatus;
  restoredAt: string;
  decision: PatchDecision;
  before: {
    trackedDirtyFiles: string[];
    untrackedFiles: string[];
  };
  after: {
    trackedDirtyFiles: string[];
    untrackedFiles: string[];
  };
  restoredFiles: string[];
  deletedFiles: string[];
  error?: string;
}

export { createGovernanceSnapshot } from "./governance.js";
export type { GovernanceSnapshot } from "./governance.js";
