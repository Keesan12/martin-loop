import { createHash } from "node:crypto";

import { FAILURE_CLASSES } from "./index.js";
import type {
  ApprovalPolicy,
  FailureClass,
  LoopBudget,
  ReceiptIntegrityState,
  VerificationStep
} from "./index.js";

export const SWARM_SCHEMA_VERSION = "martin.swarm.v1" as const;

export const SWARM_EVENT_TYPES = [
  "SWARM_CREATED",
  "SWARM_PLAN_CREATED",
  "SWARM_PLAN_APPROVED",
  "TASK_READY",
  "TASK_ASSIGNED",
  "CHILD_STARTED",
  "CHILD_PROGRESS",
  "CHILD_VERIFIER_STARTED",
  "CHILD_VERIFIED",
  "CHILD_STOPPED",
  "CHILD_NEEDS_REVIEW",
  "CHILD_PATCH_PROPOSED",
  "CHILD_PATCH_REJECTED",
  "CHILD_PATCH_ADMITTED",
  "ACTION_BLOCKED",
  "TASK_REASSIGNED",
  "DEPENDENCY_SATISFIED",
  "INTEGRATION_STARTED",
  "INTEGRATION_CONFLICT",
  "INTEGRATION_COMPLETED",
  "GLOBAL_VERIFIER_STARTED",
  "GLOBAL_VERIFIER_PASSED",
  "GLOBAL_VERIFIER_FAILED",
  "SWARM_CANCEL_REQUESTED",
  "SWARM_STOPPED",
  "SWARM_NEEDS_REVIEW",
  "SWARM_VERIFIED"
] as const;

export type SwarmEventType = (typeof SWARM_EVENT_TYPES)[number];
export const SWARM_ORCHESTRATION_STRATEGIES = [
  "hierarchical_dag",
  "pipeline_dag",
  "parallel_dag",
  "hybrid"
] as const;

export type SwarmOrchestrationStrategy = (typeof SWARM_ORCHESTRATION_STRATEGIES)[number];
export type SwarmIntegrationStrategy = "parent_fan_in" | "serial_parent_merge";
export type SwarmStopDisposition = "stop" | "needs_review";
export type SwarmVerifierAuthority = "child_only" | "parent_global";

export interface SwarmScope {
  allowedPaths: string[];
  deniedPaths: string[];
}

export interface SwarmPermissions {
  networkDomains: string[];
  commands: string[];
}

export interface SwarmStopPolicy {
  budgetExhausted: SwarmStopDisposition;
  blockingFailure: SwarmStopDisposition;
  verifierFailure: SwarmStopDisposition;
}

export interface SwarmRecoveryPolicy {
  maxReassignmentsPerTask: number;
  dependencyWaiversAllowed: boolean;
}

export interface SwarmParentContract {
  policyVersion: string;
  objective: string;
  definitionOfDone: string[];
  budget: LoopBudget;
  maxWallClockMs: number;
  maxConcurrency: number;
  scope: SwarmScope;
  permissions: SwarmPermissions;
  integrationStrategy: SwarmIntegrationStrategy;
  globalVerifierStack: VerificationStep[];
  stopPolicy: SwarmStopPolicy;
  recoveryPolicy: SwarmRecoveryPolicy;
  approvalPolicy: ApprovalPolicy;
  orchestrationStrategy: SwarmOrchestrationStrategy;
}

export interface SwarmChildContract {
  agentId: string;
  taskIds: string[];
  scope: SwarmScope;
  budget: LoopBudget;
  /** Optional explicit child ceiling, distinct from its initial fair-share reservation. */
  hardMaxUsd?: number;
  /** Optional explicit child ceiling, distinct from its initial fair-share reservation. */
  hardMaxTokens?: number;
  maxWallClockMs: number;
  permissions: SwarmPermissions;
  approvalPolicy: ApprovalPolicy;
  verifierAuthority: SwarmVerifierAuthority;
}

export interface SwarmChildReceiptLink {
  parentSwarmId: string;
  agentId: string;
  attemptId: string;
  taskIds: string[];
}

export type SwarmTaskStatus =
  | "queued"
  | "ready"
  | "running"
  | "accepted"
  | "rejected"
  | "stopped"
  | "needs_review";

export interface SwarmTaskNode {
  taskId: string;
  title: string;
  objective: string;
  required: boolean;
  dependsOn: string[];
  assignedAgentId?: string;
  status: SwarmTaskStatus;
  mutationMode: "read_only" | "write";
  writeScope: string[];
}

export interface SwarmDependencyWaiver {
  taskId: string;
  dependencyTaskId: string;
  parentPolicyVersion: string;
  approvedBy: string;
  approvedAt: string;
}

export type SwarmAgentStatus = "queued" | "running" | "verified" | "stopped" | "needs_review";

export interface SwarmAgentRecord {
  agentId: string;
  role: string;
  status: SwarmAgentStatus;
  childRunId?: string;
  contract: SwarmChildContract;
  failureClass?: FailureClass;
}

export type SwarmLeaseStatus = "reserved" | "settled" | "overspent" | "released";

export interface SwarmBudgetUsage {
  usd: number;
  tokens: number;
  provenance?: string;
}

export interface SwarmBudgetLease {
  leaseId: string;
  agentId: string;
  taskId: string;
  reservedUsd: number;
  reservedTokens: number;
  status: SwarmLeaseStatus;
  actualUsage?: SwarmBudgetUsage;
}

export interface SwarmBudgetLedger {
  capUsd: number;
  capTokens?: number;
  settledUsd: number;
  settledTokens: number;
  leases: SwarmBudgetLease[];
}

export interface SwarmConflictRecord {
  conflictId: string;
  taskIds: string[];
  paths: string[];
  state: "detected" | "resolved" | "blocking";
  resolution?: string;
  schemaVersion?: typeof SWARM_SCHEMA_VERSION;
  candidateId?: string;
  childRunId?: string;
  agentId?: string;
  preIntegrationTreeHash?: string;
  recordedAt?: string;
  diagnostic?: string;
}

export interface SwarmVerificationRecord {
  verifierId: string;
  scope: "child" | "parent_global";
  state: "pending" | "passed" | "failed" | "unknown";
  steps: VerificationStep[];
  boundAt?: string;
}

export type SwarmWorkspaceKind = "child" | "integration" | "verifier";
export type SwarmWorkspaceState = "created" | "active" | "closed" | "cleanup_pending" | "removed";

interface SwarmWorkspaceRecordBase {
  readonly schemaVersion: typeof SWARM_SCHEMA_VERSION;
  readonly workspaceId: string;
  readonly swarmId: string;
  readonly kind: SwarmWorkspaceKind;
  readonly baselineCommit: string;
  readonly state: SwarmWorkspaceState;
  readonly createdAt: string;
}

export interface SwarmChildWorkspaceRecord extends SwarmWorkspaceRecordBase {
  readonly kind: "child";
  readonly childRunId: string;
  readonly agentId: string;
  readonly taskIds: readonly string[];
}

export interface SwarmIntegrationWorkspaceRecord extends SwarmWorkspaceRecordBase {
  readonly kind: "integration";
}

export interface SwarmVerifierWorkspaceRecord extends SwarmWorkspaceRecordBase {
  readonly kind: "verifier";
}

export type SwarmWorkspaceRecord =
  | SwarmChildWorkspaceRecord
  | SwarmIntegrationWorkspaceRecord
  | SwarmVerifierWorkspaceRecord;

export interface SwarmCandidate {
  readonly schemaVersion: typeof SWARM_SCHEMA_VERSION;
  readonly candidateId: string;
  readonly swarmId: string;
  readonly workspaceId: string;
  readonly childRunId: string;
  readonly agentId: string;
  readonly taskIds: readonly string[];
  readonly baselineCommit: string;
  readonly patchSha256: string;
  readonly changedPaths: readonly string[];
  readonly createdAt: string;
}

export type SwarmPatchAdmissionState = "admitted" | "rejected";
export type SwarmPatchAdmissionReasonCode =
  | "admitted"
  | "child_not_terminal"
  | "process_active"
  | "identity_mismatch"
  | "receipt_not_verified"
  | "receipt_scope_mismatch"
  | "stale_baseline"
  | "git_inventory_failed"
  | "invalid_concrete_path"
  | "unsafe_path"
  | "undeclared_path"
  | "path_not_allowed"
  | "path_denied"
  | "task_scope_violation"
  | "candidate_changed_during_capture"
  | "empty_candidate"
  | "patch_hash_mismatch"
  | "integration_precondition_failed"
  | "integration_conflict"
  | "integration_apply_failed"
  | "artifact_persistence_failed";

export interface SwarmPatchAdmission {
  readonly schemaVersion: typeof SWARM_SCHEMA_VERSION;
  readonly admissionId: string;
  readonly candidateId: string;
  readonly swarmId: string;
  readonly workspaceId: string;
  readonly childRunId: string;
  readonly agentId: string;
  readonly taskIds: readonly string[];
  readonly baselineCommit: string;
  readonly changedPaths: readonly string[];
  readonly state: SwarmPatchAdmissionState;
  readonly reasonCode: SwarmPatchAdmissionReasonCode;
  readonly receiptIntegrity: ReceiptIntegrityState;
  readonly decidedAt: string;
  readonly preIntegrationTreeHash?: string;
  readonly postIntegrationTreeHash?: string;
  readonly diagnostic?: string;
}

export type SwarmGlobalVerificationCommandState = "pending" | "passed" | "failed" | "unknown";
export type SwarmVerifierMutationState = "pending" | "clean" | "mutated" | "unknown";

export interface SwarmVerifierSubprocessResult {
  readonly command: string;
  readonly launched: boolean;
  readonly completed: boolean;
  readonly timedOut: boolean;
  readonly exitCode: number | null;
  readonly signal?: string;
  readonly startedAt: string;
  readonly completedAt?: string;
}

export interface SwarmGlobalVerification {
  readonly schemaVersion: typeof SWARM_SCHEMA_VERSION;
  readonly verificationId: string;
  readonly swarmId: string;
  readonly workspaceId: string;
  readonly parentPolicyVersion: string;
  readonly baselineCommit: string;
  readonly integratedTreeHash: string;
  readonly commands: readonly string[];
  readonly commandState: SwarmGlobalVerificationCommandState;
  readonly mutationState: SwarmVerifierMutationState;
  readonly startedAt: string;
  readonly completedAt?: string;
  readonly subprocessResults: readonly SwarmVerifierSubprocessResult[];
}

export type SwarmProcessCloseState = "not_required" | "pending" | "closed" | "failed";
export type SwarmWorkspaceRemovalState = "pending" | "removed" | "failed";
export type SwarmCleanupState = "pending" | "completed" | "failed" | "cleanup_pending";

export interface SwarmCleanupRecord {
  readonly schemaVersion: typeof SWARM_SCHEMA_VERSION;
  readonly cleanupId: string;
  readonly swarmId: string;
  readonly workspaceId: string;
  readonly workspaceKind: SwarmWorkspaceKind;
  readonly ownedProcessId?: number;
  readonly evidencePersisted: boolean;
  readonly processCloseState: SwarmProcessCloseState;
  readonly removalState: SwarmWorkspaceRemovalState;
  readonly state: SwarmCleanupState;
  readonly attemptedAt: string;
  readonly completedAt?: string;
  readonly errorCode?: string;
}

export type SwarmDemoReferentialBindingState = "passed" | "failed" | "unknown";

export interface SwarmDeterministicDemoReceiptEvidence {
  evidenceKind: "deterministic_demo";
  swarmId: string;
  agentId: string;
  taskIds: string[];
  childRunId: string;
  referentialBinding: SwarmDemoReferentialBindingState;
  signedIntegrity: "not_evaluated";
}

export type SwarmOutcomeState = "running" | "stopped" | "needs_review" | "verified";

export interface SwarmOutcome {
  state: SwarmOutcomeState;
  reason: string;
  verifiedAt?: string;
}

export interface SwarmEvent {
  type: SwarmEventType;
  swarmId: string;
  timestamp: string;
  parentPolicyVersion: string;
  taskId?: string;
  agentId?: string;
  childRunId?: string;
  payload: Record<string, unknown>;
}

export interface SwarmRunRecord {
  schemaVersion: typeof SWARM_SCHEMA_VERSION;
  swarmId: string;
  workspaceId: string;
  projectId: string;
  parentContract: SwarmParentContract;
  tasks: SwarmTaskNode[];
  agents: SwarmAgentRecord[];
  dependencyWaivers: SwarmDependencyWaiver[];
  budgetLedger: SwarmBudgetLedger;
  conflicts: SwarmConflictRecord[];
  verification: SwarmVerificationRecord[];
  outcome: SwarmOutcome;
  events: SwarmEvent[];
  createdAt: string;
  updatedAt: string;
}

export interface SwarmRunDraft {
  swarmId: string;
  workspaceId: string;
  projectId: string;
  parentContract: SwarmParentContract;
  tasks: SwarmTaskNode[];
  agents: SwarmAgentRecord[];
  dependencyWaivers?: SwarmDependencyWaiver[];
  budgetLedger?: SwarmBudgetLedger;
  conflicts?: SwarmConflictRecord[];
  verification?: SwarmVerificationRecord[];
  outcome?: SwarmOutcome;
  events?: SwarmEvent[];
  createdAt?: string;
  updatedAt?: string;
}

export const SWARM_LIVE_ENGINES = ["claude", "codex", "gemini", "openai"] as const;

export type SwarmLiveEngine = (typeof SWARM_LIVE_ENGINES)[number];

export interface SwarmLiveEngineProfile {
  engine: SwarmLiveEngine;
  model: string;
}

export interface SwarmLivePlanDraft {
  planId: string;
  swarmId: string;
  workspaceId: string;
  projectId: string;
  baselineCommit: string;
  parentContract: SwarmParentContract;
  tasks: SwarmTaskNode[];
  agents: SwarmAgentRecord[];
  engine: SwarmLiveEngineProfile;
  childMaxIterations: number;
  createdAt: string;
}

export interface SwarmLivePlan extends SwarmLivePlanDraft {
  schemaVersion: typeof SWARM_SCHEMA_VERSION;
  planHash: string;
}

export type SwarmLiveRevision = number;

export interface SwarmLiveEvent {
  schemaVersion: typeof SWARM_SCHEMA_VERSION;
  sequence: number;
  idempotencyKey: string;
  type: SwarmEventType;
  swarmId: string;
  timestamp: string;
  parentPolicyVersion: string;
  planHash: string;
  taskId?: string;
  agentId?: string;
  childRunId?: string;
  failureClass?: FailureClass;
  payload: Record<string, unknown>;
}

export const SWARM_PARENT_RECEIPT_SCHEMA_VERSION = "martin.swarm-receipt.v1" as const;

export interface SwarmReceiptBlockedAction {
  eventId: string;
  sequence: number;
  agentId: string;
  taskId: string;
  attemptId: string;
  action: string;
  reason: string;
  timestamp: string;
}

export interface SwarmReceiptReassignment {
  eventId: string;
  sequence: number;
  taskId: string;
  fromAgentId: string;
  toAgentId: string;
  fromAttemptId: string;
  toAttemptId: string;
  reason: string;
  timestamp: string;
}

export interface SwarmParentReceipt {
  schemaVersion: typeof SWARM_PARENT_RECEIPT_SCHEMA_VERSION;
  receiptId: string;
  receiptSha256: string;
  swarmId: string;
  planHash: string;
  objective: string;
  engine: SwarmLiveEngineProfile;
  baselineCommit: string;
  tasks: SwarmTaskNode[];
  agents: SwarmAgentRecord[];
  budget: LoopBudget;
  budgetLedger: SwarmBudgetLedger;
  childReceipts: Array<{
    childRunId: string;
    agentId: string;
    attemptId: string;
    taskIds: string[];
    receiptIntegritySha256: string;
  }>;
  blockedActions: SwarmReceiptBlockedAction[];
  reassignments: SwarmReceiptReassignment[];
  events: SwarmLiveEvent[];
  evidenceIndexSha256: string;
  evidenceFiles: Array<{ kind: "operational" | "artifact"; path: string; sha256: string; bytes: number }>;
  evidenceBindings: {
    admissions: string[];
    rejections: string[];
    conflicts: string[];
    integration: string[];
    globalVerification: string[];
    cleanup: string[];
  };
  integratedTreeHash?: string;
  globalVerificationId?: string;
  parentOutcome: Omit<SwarmOutcome, "state"> & {
    state: Exclude<SwarmOutcomeState, "running">;
  };
  taskVerificationState: "passed" | "failed" | "unknown";
  sealedAt: string;
}

export interface SwarmValidationError {
  code: string;
  path: string;
  message: string;
}

export type SwarmValidationResult =
  | { ok: true; errors: [] }
  | { ok: false; errors: SwarmValidationError[] };

export type SwarmPathPatternResult =
  | { ok: true; value: string }
  | { ok: false; error: string };

export type SwarmConcretePathResult =
  | { ok: true; value: string }
  | { ok: false; error: string };

export function validateSwarmChildReceiptLink(value: unknown): SwarmValidationResult {
  const errors: SwarmValidationError[] = [];
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    addError(errors, "INVALID_SWARM_CHILD_RECEIPT_LINK", "swarmChild", "must be an object");
    return { ok: false, errors };
  }

  const link = value as Partial<SwarmChildReceiptLink>;
  requireText(link.parentSwarmId, "parentSwarmId", errors);
  requireText(link.agentId, "agentId", errors);
  requireText(link.attemptId, "attemptId", errors);
  if (!Array.isArray(link.taskIds) || link.taskIds.length === 0) {
    addError(errors, "EMPTY_SWARM_CHILD_TASKS", "taskIds", "at least one task ID is required");
  } else {
    link.taskIds.forEach((taskId, index) => requireText(taskId, `taskIds[${index}]`, errors));
    addDuplicateErrors(link.taskIds, "DUPLICATE_SWARM_CHILD_TASK_ID", "taskIds", errors);
  }

  return errors.length === 0 ? { ok: true, errors: [] } : { ok: false, errors };
}

export function createSwarmLivePlan(draft: SwarmLivePlanDraft): SwarmLivePlan {
  const planWithoutHash = {
    ...cloneLivePlanDraft(draft),
    schemaVersion: SWARM_SCHEMA_VERSION
  };
  return {
    ...planWithoutHash,
    planHash: computeSwarmLivePlanHash(planWithoutHash)
  };
}

export function computeSwarmLivePlanHash(
  plan: SwarmLivePlan | (SwarmLivePlanDraft & { schemaVersion?: typeof SWARM_SCHEMA_VERSION })
): string {
  const { planHash: _ignored, ...hashInput } = plan as SwarmLivePlan & Record<string, unknown>;
  return createHash("sha256").update(canonicalJson(hashInput)).digest("hex");
}

export function validateSwarmLiveRevision(value: unknown): value is SwarmLiveRevision {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

export function validateSwarmLivePlan(plan: SwarmLivePlan): SwarmValidationResult {
  const errors: SwarmValidationError[] = [];
  if (plan.schemaVersion !== SWARM_SCHEMA_VERSION) {
    addError(errors, "UNKNOWN_SCHEMA_VERSION", "schemaVersion", "unknown swarm schema version");
  }
  for (const key of ["planId", "swarmId", "workspaceId", "projectId"] as const) {
    requireText(plan[key], key, errors);
  }
  if (!/^[0-9a-f]{40,64}$/iu.test(plan.baselineCommit)) {
    addError(errors, "INVALID_BASELINE_COMMIT", "baselineCommit", "must be an immutable 40-64 character Git object id");
  }
  if (!SWARM_LIVE_ENGINES.includes(plan.engine.engine)) {
    addError(errors, "INVALID_LIVE_ENGINE", "engine.engine", "must select exactly one concrete live engine");
  }
  requireText(plan.engine.model, "engine.model", errors);
  if (!isPositiveInteger(plan.childMaxIterations)) {
    addError(errors, "INVALID_CHILD_ITERATION_LIMIT", "childMaxIterations", "must be a positive integer");
  }
  if (!isCanonicalIsoDate(plan.createdAt)) {
    addError(errors, "INVALID_CREATED_AT", "createdAt", "must be a canonical ISO timestamp");
  }
  errors.push(...validateSwarmParentContract(plan.parentContract).errors);
  if (plan.tasks.length === 0) {
    addError(errors, "EMPTY_TASK_GRAPH", "tasks", "at least one task is required");
  }
  if (plan.agents.length === 0) {
    addError(errors, "EMPTY_AGENT_POOL", "agents", "at least one agent is required");
  }
  addDuplicateErrors(plan.tasks.map((task) => task.taskId), "DUPLICATE_TASK_ID", "tasks", errors);
  addDuplicateErrors(plan.agents.map((agent) => agent.agentId), "DUPLICATE_AGENT_ID", "agents", errors);
  const taskIds = new Set(plan.tasks.map((task) => task.taskId));
  const agentIds = new Set(plan.agents.map((agent) => agent.agentId));
  plan.tasks.forEach((task, index) => {
    requireText(task.taskId, `tasks[${index}].taskId`, errors);
    if (!hasText(task.assignedAgentId)) {
      addError(errors, "MISSING_TASK_AGENT", `tasks[${index}].assignedAgentId`, "every task must have one assigned agent");
    }
    if (task.dependsOn.some((dependency) => !taskIds.has(dependency))) {
      addError(errors, "UNKNOWN_TASK_DEPENDENCY", `tasks[${index}].dependsOn`, "every dependency must name a plan task");
    }
    if (task.assignedAgentId !== undefined && !agentIds.has(task.assignedAgentId)) {
      addError(errors, "UNKNOWN_TASK_AGENT", `tasks[${index}].assignedAgentId`, "assigned agent must be present in the plan");
    }
    const assignedAgent = plan.agents.find((agent) => agent.agentId === task.assignedAgentId);
    if (assignedAgent && !assignedAgent.contract.taskIds.includes(task.taskId)) {
      addError(
        errors,
        "TASK_ASSIGNMENT_NOT_COVERED",
        `tasks[${index}].assignedAgentId`,
        "assigned agent contract must include the exact task"
      );
    }
  });
  plan.agents.forEach((agent, index) => {
    const child = validateSwarmChildContract(plan.parentContract, agent.contract);
    errors.push(...child.errors.map((error) => ({ ...error, path: `agents[${index}].contract.${error.path}` })));
    if (agent.contract.taskIds.some((taskId) => !taskIds.has(taskId))) {
      addError(errors, "UNKNOWN_CHILD_TASK", `agents[${index}].contract.taskIds`, "every child task must be present in the plan");
    }
  });
  if (!/^[0-9a-f]{64}$/u.test(plan.planHash) || computeSwarmLivePlanHash(plan) !== plan.planHash) {
    addError(errors, "LIVE_PLAN_HASH_MISMATCH", "planHash", "plan hash must bind the complete canonical live plan");
  }
  return validationResult(errors);
}

export function validateSwarmLiveEvent(
  event: SwarmLiveEvent,
  plan: SwarmLivePlan
): SwarmValidationResult {
  const errors: SwarmValidationError[] = [];
  if (event.schemaVersion !== SWARM_SCHEMA_VERSION) {
    addError(errors, "UNKNOWN_SCHEMA_VERSION", "schemaVersion", "unknown swarm schema version");
  }
  if (!Number.isSafeInteger(event.sequence) || event.sequence <= 0) {
    addError(errors, "INVALID_EVENT_SEQUENCE", "sequence", "must be a positive safe integer");
  }
  requireText(event.idempotencyKey, "idempotencyKey", errors);
  if (!SWARM_EVENT_TYPES.includes(event.type)) {
    addError(errors, "INVALID_EVENT_TYPE", "type", "must use a canonical swarm event type");
  }
  if (event.swarmId !== plan.swarmId) {
    addError(errors, "EVENT_SWARM_MISMATCH", "swarmId", "must match the live plan");
  }
  if (event.parentPolicyVersion !== plan.parentContract.policyVersion) {
    addError(errors, "EVENT_POLICY_MISMATCH", "parentPolicyVersion", "must match the live plan");
  }
  if (event.planHash !== plan.planHash) {
    addError(errors, "EVENT_PLAN_HASH_MISMATCH", "planHash", "must match the approved live plan hash");
  }
  if (!isCanonicalIsoDate(event.timestamp)) {
    addError(errors, "INVALID_EVENT_TIMESTAMP", "timestamp", "must be a canonical ISO timestamp");
  }
  if (event.failureClass !== undefined && !FAILURE_CLASSES.includes(event.failureClass)) {
    addError(errors, "INVALID_FAILURE_CLASS", "failureClass", "must use a canonical MartinLoop failure class");
  }
  if (event.payload === null || typeof event.payload !== "object" || Array.isArray(event.payload)) {
    addError(errors, "INVALID_EVENT_PAYLOAD", "payload", "must be a JSON object");
  }
  return validationResult(errors);
}

export function validateSwarmConcretePath(value: string): SwarmConcretePathResult {
  if (value.length === 0) {
    return { ok: false, error: "concrete path must not be empty" };
  }
  if (value.includes("\0")) {
    return { ok: false, error: "concrete path must not contain NUL" };
  }
  if (value.includes("\\")) {
    return { ok: false, error: "concrete path must use repository-relative slash separators" };
  }
  if (/^(?:[a-z]:|\/)/iu.test(value)) {
    return { ok: false, error: "concrete path must be repository-relative" };
  }
  if (value !== value.normalize("NFC")) {
    return { ok: false, error: "concrete path must use Unicode NFC normalization" };
  }
  const segments = value.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    return { ok: false, error: "concrete path contains an empty or traversal segment" };
  }
  if (segments.some((segment) => segment.toLowerCase() === ".git")) {
    return { ok: false, error: "concrete path must not enter Git metadata" };
  }
  return { ok: true, value: segments.join("/") };
}

export function swarmConcretePathMatchesPattern(concretePath: string, pattern: string): boolean {
  const validatedPath = validateSwarmConcretePath(concretePath);
  const normalizedPattern = normalizeSwarmPathPattern(pattern);
  if (!validatedPath.ok || !normalizedPattern.ok) return false;
  return matchConcretePathSegments(
    validatedPath.value.split("/"),
    normalizedPattern.value.split("/"),
    0,
    0,
    new Map<string, boolean>()
  );
}

export function normalizeSwarmPathPattern(value: string): SwarmPathPatternResult {
  const candidate = value.trim().replaceAll("\\", "/");
  if (candidate.length === 0) {
    return { ok: false, error: "path pattern must not be empty" };
  }
  if (/^(?:[a-z]:|\/)/iu.test(candidate)) {
    return { ok: false, error: "path pattern must be repository-relative" };
  }
  const segments = candidate.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    return { ok: false, error: "path pattern contains an empty or traversal segment" };
  }
  for (const segment of segments) {
    if (segment === "*" || segment === "**") continue;
    if (!/^[a-z0-9._@+-]+$/iu.test(segment)) {
      return { ok: false, error: `malformed path pattern segment: ${segment}` };
    }
  }
  return { ok: true, value: segments.join("/") };
}

export function swarmPathPatternContains(parent: string, child: string): boolean {
  const normalizedParent = normalizeSwarmPathPattern(parent);
  const normalizedChild = normalizeSwarmPathPattern(child);
  if (!normalizedParent.ok || !normalizedChild.ok) return false;
  if (normalizedParent.value === "**" || normalizedParent.value === normalizedChild.value) return true;
  if (normalizedParent.value.endsWith("/**")) {
    const prefix = normalizedParent.value.slice(0, -3);
    return normalizedChild.value === prefix || normalizedChild.value.startsWith(`${prefix}/`);
  }
  if (normalizedParent.value.startsWith("**/")) {
    const suffix = normalizedParent.value.slice(3);
    return normalizedChild.value === suffix || normalizedChild.value.endsWith(`/${suffix}`);
  }
  return false;
}

export function swarmPathPatternsOverlap(left: string, right: string): boolean {
  const normalizedLeft = normalizeSwarmPathPattern(left);
  const normalizedRight = normalizeSwarmPathPattern(right);
  if (!normalizedLeft.ok || !normalizedRight.ok) return true;
  if (
    swarmPathPatternContains(normalizedLeft.value, normalizedRight.value)
    || swarmPathPatternContains(normalizedRight.value, normalizedLeft.value)
  ) {
    return true;
  }
  const leftPrefix = literalPatternPrefix(normalizedLeft.value);
  const rightPrefix = literalPatternPrefix(normalizedRight.value);
  if (leftPrefix.length === 0 || rightPrefix.length === 0) return true;
  return leftPrefix.startsWith(`${rightPrefix}/`) || rightPrefix.startsWith(`${leftPrefix}/`);
}

export function validateSwarmParentContract(parent: SwarmParentContract): SwarmValidationResult {
  const errors: SwarmValidationError[] = [];
  requireText(parent.policyVersion, "policyVersion", errors);
  requireText(parent.objective, "objective", errors);
  if (parent.definitionOfDone.length === 0 || parent.definitionOfDone.some((item) => !hasText(item))) {
    addError(errors, "INVALID_DEFINITION_OF_DONE", "definitionOfDone", "at least one non-empty criterion is required");
  }
  validateBudget(parent.budget, "budget", errors);
  if (!isPositiveInteger(parent.maxConcurrency)) {
    addError(errors, "INVALID_CONCURRENCY", "maxConcurrency", "must be a positive integer");
  }
  if (!isPositiveFinite(parent.maxWallClockMs)) {
    addError(errors, "INVALID_WALL_CLOCK", "maxWallClockMs", "must be a positive finite number");
  }
  if (parent.scope.allowedPaths.length === 0) {
    addError(errors, "INVALID_SCOPE", "scope.allowedPaths", "at least one non-empty allowed path is required");
  }
  validatePathPatterns(parent.scope.allowedPaths, "scope.allowedPaths", errors);
  validatePathPatterns(parent.scope.deniedPaths, "scope.deniedPaths", errors);
  if (parent.globalVerifierStack.length === 0) {
    addError(errors, "INVALID_GLOBAL_VERIFIER", "globalVerifierStack", "at least one global verifier step is required");
  }
  if (!SWARM_ORCHESTRATION_STRATEGIES.includes(parent.orchestrationStrategy)) {
    addError(
      errors,
      "INVALID_ORCHESTRATION_STRATEGY",
      "orchestrationStrategy",
      "must use a canonical swarm orchestration strategy"
    );
  }
  if (!Number.isInteger(parent.recoveryPolicy.maxReassignmentsPerTask) || parent.recoveryPolicy.maxReassignmentsPerTask < 0) {
    addError(errors, "INVALID_RECOVERY_POLICY", "recoveryPolicy.maxReassignmentsPerTask", "must be a nonnegative integer");
  }
  return validationResult(errors);
}

export function validateSwarmDeterministicDemoReceiptEvidence(
  evidence: SwarmDeterministicDemoReceiptEvidence
): SwarmValidationResult {
  const errors: SwarmValidationError[] = [];
  if (evidence.evidenceKind !== "deterministic_demo") {
    addError(errors, "INVALID_DEMO_EVIDENCE_KIND", "evidenceKind", "must identify deterministic demo evidence");
  }
  for (const key of ["swarmId", "agentId", "childRunId"] as const) {
    requireText(evidence[key], key, errors);
  }
  if (
    !Array.isArray(evidence.taskIds)
    || evidence.taskIds.length === 0
    || evidence.taskIds.some((taskId) => !hasText(taskId))
    || new Set(evidence.taskIds).size !== evidence.taskIds.length
  ) {
    addError(
      errors,
      "INVALID_DEMO_TASK_BINDING",
      "taskIds",
      "must contain a non-empty, duplicate-free assigned task set"
    );
  }
  if (!["passed", "failed", "unknown"].includes(evidence.referentialBinding)) {
    addError(errors, "INVALID_DEMO_REFERENTIAL_BINDING", "referentialBinding", "must be passed, failed, or unknown");
  }
  if (evidence.signedIntegrity !== "not_evaluated") {
    addError(
      errors,
      "DEMO_SIGNED_INTEGRITY_FORBIDDEN",
      "signedIntegrity",
      "deterministic demo evidence does not evaluate signed receipt integrity"
    );
  }
  return validationResult(errors);
}

export function validateSwarmChildContract(
  parent: SwarmParentContract,
  child: SwarmChildContract
): SwarmValidationResult {
  const errors: SwarmValidationError[] = [];
  requireText(child.agentId, "agentId", errors);
  if (child.taskIds.length === 0 || child.taskIds.some((taskId) => !hasText(taskId))) {
    addError(errors, "INVALID_CHILD_TASKS", "taskIds", "at least one non-empty task identifier is required");
  }
  validateBudget(child.budget, "budget", errors);
  if (child.hardMaxUsd !== undefined && (!isNonnegativeFinite(child.hardMaxUsd) || child.hardMaxUsd > parent.budget.maxUsd)) {
    addError(errors, "CHILD_HARD_USD_CAP_INVALID", "hardMaxUsd", "child hard USD cap must be finite, nonnegative, and within the parent cap");
  }
  if (child.hardMaxTokens !== undefined && (
    !isPositiveInteger(child.hardMaxTokens)
    || parent.budget.maxTokens === undefined
    || child.hardMaxTokens > parent.budget.maxTokens
  )) {
    addError(errors, "CHILD_HARD_TOKEN_CAP_INVALID", "hardMaxTokens", "child hard token cap must be positive and within the parent token cap");
  }

  validatePathPatterns(child.scope.allowedPaths, "scope.allowedPaths", errors);
  validatePathPatterns(child.scope.deniedPaths, "scope.deniedPaths", errors);

  if (child.scope.allowedPaths.some((path) => !parent.scope.allowedPaths.some((allowed) => swarmPathPatternContains(allowed, path)))) {
    addError(errors, "CHILD_SCOPE_WIDENED", "scope.allowedPaths", "child allowed paths must be contained by parent scope");
  }
  if (parent.scope.deniedPaths.some((denied) => !child.scope.deniedPaths.includes(denied))) {
    addError(errors, "CHILD_DENIAL_DROPPED", "scope.deniedPaths", "child must inherit every parent denied path");
  }
  if (budgetWidened(parent.budget, child.budget)) {
    addError(errors, "CHILD_BUDGET_WIDENED", "budget", "child budget must not exceed parent budget");
  }
  if (!isPositiveFinite(child.maxWallClockMs) || child.maxWallClockMs > parent.maxWallClockMs) {
    addError(errors, "CHILD_WALL_CLOCK_WIDENED", "maxWallClockMs", "child wall-clock cap must not exceed parent cap");
  }
  if (!isSubset(child.permissions.networkDomains, parent.permissions.networkDomains)) {
    addError(errors, "CHILD_NETWORK_WIDENED", "permissions.networkDomains", "child network permissions must be a parent subset");
  }
  if (!isSubset(child.permissions.commands, parent.permissions.commands)) {
    addError(errors, "CHILD_COMMAND_WIDENED", "permissions.commands", "child commands must be a parent subset");
  }
  if (approvalWidened(parent.approvalPolicy, child.approvalPolicy)) {
    addError(errors, "CHILD_APPROVAL_WIDENED", "approvalPolicy", "child approval authority must not exceed parent authority");
  }
  if (child.verifierAuthority !== "child_only") {
    addError(errors, "CHILD_GLOBAL_VERIFIER_FORBIDDEN", "verifierAuthority", "only the parent may hold global verifier authority");
  }
  return validationResult(errors);
}

export function createSwarmRunRecord(
  draft: SwarmRunDraft,
  options: { now?: string } = {}
): SwarmRunRecord {
  const now = options.now ?? new Date().toISOString();
  const events = draft.events
    ? draft.events.map((event) => ({ ...event, payload: { ...event.payload } }))
    : [{
        type: "SWARM_CREATED" as const,
        swarmId: draft.swarmId,
        timestamp: now,
        parentPolicyVersion: draft.parentContract.policyVersion,
        payload: {}
      }];
  return {
    schemaVersion: SWARM_SCHEMA_VERSION,
    swarmId: draft.swarmId,
    workspaceId: draft.workspaceId,
    projectId: draft.projectId,
    parentContract: cloneParentContract(draft.parentContract),
    tasks: draft.tasks.map(cloneTask),
    agents: draft.agents.map(cloneAgent),
    dependencyWaivers: (draft.dependencyWaivers ?? []).map((waiver) => ({ ...waiver })),
    budgetLedger: draft.budgetLedger
      ? cloneBudgetLedger(draft.budgetLedger)
      : {
          capUsd: draft.parentContract.budget.maxUsd,
          settledUsd: 0,
          settledTokens: 0,
          leases: [],
          ...(draft.parentContract.budget.maxTokens !== undefined
            ? { capTokens: draft.parentContract.budget.maxTokens }
            : {})
        },
    conflicts: (draft.conflicts ?? []).map((conflict) => ({ ...conflict, taskIds: [...conflict.taskIds], paths: [...conflict.paths] })),
    verification: (draft.verification ?? []).map((item) => ({ ...item, steps: item.steps.map((step) => ({ ...step })) })),
    outcome: { ...(draft.outcome ?? { state: "running", reason: "Swarm execution has not reached a parent terminal decision." }) },
    events,
    createdAt: draft.createdAt ?? now,
    updatedAt: draft.updatedAt ?? now
  };
}

export function validateSwarmRunRecord(record: SwarmRunRecord): SwarmValidationResult {
  const errors: SwarmValidationError[] = [];
  requireText(record.swarmId, "swarmId", errors);
  requireText(record.workspaceId, "workspaceId", errors);
  requireText(record.projectId, "projectId", errors);
  errors.push(...validateSwarmParentContract(record.parentContract).errors);
  addDuplicateErrors(record.tasks.map((task) => task.taskId), "DUPLICATE_TASK_ID", "tasks", errors);
  addDuplicateErrors(record.agents.map((agent) => agent.agentId), "DUPLICATE_AGENT_ID", "agents", errors);
  for (const [index, agent] of record.agents.entries()) {
    const childResult = validateSwarmChildContract(record.parentContract, agent.contract);
    errors.push(...childResult.errors.map((error) => ({ ...error, path: `agents[${index}].contract.${error.path}` })));
  }
  if (record.schemaVersion !== SWARM_SCHEMA_VERSION) {
    addError(errors, "UNKNOWN_SCHEMA_VERSION", "schemaVersion", "unknown swarm schema version");
  }
  return validationResult(errors);
}

function cloneParentContract(parent: SwarmParentContract): SwarmParentContract {
  return {
    ...parent,
    definitionOfDone: [...parent.definitionOfDone],
    budget: { ...parent.budget },
    scope: { allowedPaths: [...parent.scope.allowedPaths], deniedPaths: [...parent.scope.deniedPaths] },
    permissions: { networkDomains: [...parent.permissions.networkDomains], commands: [...parent.permissions.commands] },
    globalVerifierStack: parent.globalVerifierStack.map((step) => ({ ...step })),
    stopPolicy: { ...parent.stopPolicy },
    recoveryPolicy: { ...parent.recoveryPolicy },
    approvalPolicy: { ...parent.approvalPolicy }
  };
}

function cloneTask(task: SwarmTaskNode): SwarmTaskNode {
  return { ...task, dependsOn: [...task.dependsOn], writeScope: [...task.writeScope] };
}

function cloneAgent(agent: SwarmAgentRecord): SwarmAgentRecord {
  return {
    ...agent,
    contract: {
      ...agent.contract,
      taskIds: [...agent.contract.taskIds],
      scope: { allowedPaths: [...agent.contract.scope.allowedPaths], deniedPaths: [...agent.contract.scope.deniedPaths] },
      budget: { ...agent.contract.budget },
      permissions: { networkDomains: [...agent.contract.permissions.networkDomains], commands: [...agent.contract.permissions.commands] },
      approvalPolicy: { ...agent.contract.approvalPolicy }
    }
  };
}

function cloneLivePlanDraft(draft: SwarmLivePlanDraft): SwarmLivePlanDraft {
  return {
    ...draft,
    parentContract: cloneParentContract(draft.parentContract),
    tasks: draft.tasks.map(cloneTask),
    agents: draft.agents.map(cloneAgent),
    engine: { ...draft.engine }
  };
}

function cloneBudgetLedger(ledger: SwarmBudgetLedger): SwarmBudgetLedger {
  return { ...ledger, leases: ledger.leases.map((lease) => ({ ...lease, ...(lease.actualUsage ? { actualUsage: { ...lease.actualUsage } } : {}) })) };
}

function validateBudget(budget: LoopBudget, path: string, errors: SwarmValidationError[]): void {
  if (!isNonnegativeFinite(budget.maxUsd) || !isNonnegativeFinite(budget.softLimitUsd) || budget.softLimitUsd > budget.maxUsd || !isPositiveInteger(budget.maxIterations) || (budget.maxTokens !== undefined && !isPositiveInteger(budget.maxTokens))) {
    addError(errors, "INVALID_BUDGET", path, "budget caps must be finite, nonnegative, ordered, and use positive iteration/token limits");
  }
}

function budgetWidened(parent: LoopBudget, child: LoopBudget): boolean {
  return child.maxUsd > parent.maxUsd
    || child.softLimitUsd > parent.softLimitUsd
    || child.maxIterations > parent.maxIterations
    || (parent.maxTokens !== undefined
      && (child.maxTokens === undefined || child.maxTokens > parent.maxTokens));
}

function approvalWidened(parent: ApprovalPolicy, child: ApprovalPolicy): boolean {
  const keys = ["dependencyAdds", "migrations", "configChanges", "externalWrites"] as const;
  return keys.some((key) => child[key] === true && parent[key] !== true);
}

function addDuplicateErrors(values: string[], code: string, path: string, errors: SwarmValidationError[]): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) {
      addError(errors, code, path, `duplicate identifier: ${value}`);
    }
    seen.add(value);
  }
}

function isSubset(values: string[], allowed: string[]): boolean {
  return values.every((value) => allowed.includes(value));
}

function validationResult(errors: SwarmValidationError[]): SwarmValidationResult {
  return errors.length === 0 ? { ok: true, errors: [] } : { ok: false, errors };
}

function requireText(value: unknown, path: string, errors: SwarmValidationError[]): void {
  if (!hasText(value)) addError(errors, "REQUIRED_FIELD", path, "non-empty text is required");
}

function addError(errors: SwarmValidationError[], code: string, path: string, message: string): void {
  errors.push({ code, path, message });
}

function hasText(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isNonnegativeFinite(value: number): boolean {
  return Number.isFinite(value) && value >= 0;
}

function isPositiveFinite(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

function isPositiveInteger(value: number): boolean {
  return Number.isInteger(value) && value > 0;
}

function isCanonicalIsoDate(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
}

function validatePathPatterns(
  patterns: string[],
  path: string,
  errors: SwarmValidationError[]
): void {
  patterns.forEach((pattern, index) => {
    const result = normalizeSwarmPathPattern(pattern);
    if (!result.ok) {
      addError(errors, "INVALID_SCOPE_PATTERN", `${path}[${index}]`, result.error);
    }
  });
}

function literalPatternPrefix(pattern: string): string {
  const segments: string[] = [];
  for (const segment of pattern.split("/")) {
    if (segment === "*" || segment === "**") break;
    segments.push(segment);
  }
  return segments.join("/");
}

function matchConcretePathSegments(
  pathSegments: string[],
  patternSegments: string[],
  pathIndex: number,
  patternIndex: number,
  memo: Map<string, boolean>
): boolean {
  const key = `${pathIndex}:${patternIndex}`;
  const cached = memo.get(key);
  if (cached !== undefined) return cached;

  let matched: boolean;
  if (patternIndex === patternSegments.length) {
    matched = pathIndex === pathSegments.length;
  } else if (patternSegments[patternIndex] === "**") {
    matched = matchConcretePathSegments(pathSegments, patternSegments, pathIndex, patternIndex + 1, memo)
      || (pathIndex < pathSegments.length
        && matchConcretePathSegments(pathSegments, patternSegments, pathIndex + 1, patternIndex, memo));
  } else {
    matched = pathIndex < pathSegments.length
      && (patternSegments[patternIndex] === "*" || patternSegments[patternIndex] === pathSegments[pathIndex])
      && matchConcretePathSegments(pathSegments, patternSegments, pathIndex + 1, patternIndex + 1, memo);
  }

  memo.set(key, matched);
  return matched;
}
