import { createHash } from "node:crypto";

import {
  SWARM_PARENT_RECEIPT_SCHEMA_VERSION,
  SWARM_SCHEMA_VERSION,
  type SwarmLiveEvent,
  type SwarmAgentRecord,
  type SwarmBudgetLedger,
  type SwarmParentReceipt,
  type SwarmReceiptBlockedAction,
  type SwarmReceiptReassignment,
  type SwarmTaskNode
} from "@martin/contracts";

import type { ReadAndSealSwarmEvidenceResult } from "./evidence.js";

export class SwarmParentReceiptError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "SwarmParentReceiptError";
    this.code = code;
  }
}

export function buildParentSwarmReceipt(sealed: ReadAndSealSwarmEvidenceResult): SwarmParentReceipt {
  const { plan, events, artifacts } = sealed.model;
  const outcome = sealed.index.outcome;
  if (outcome.state === "running") {
    throw new SwarmParentReceiptError("NON_TERMINAL_SWARM", "A running swarm cannot produce a parent receipt.");
  }
  const terminalOutcome = structuredClone(outcome) as SwarmParentReceipt["parentOutcome"];
  if (sealed.index.swarmId !== plan.swarmId || sealed.index.planHash !== plan.planHash) {
    throw new SwarmParentReceiptError("SEALED_MODEL_MISMATCH", "The sealed evidence model does not match its index.");
  }

  const blockedActions = projectBlockedActions(events);
  const reassignments = projectReassignments(events);
  const childReceipts = projectChildReceipts(sealed);
  const globalEvent = [...events].reverse().find((event) => (
    event.type === "GLOBAL_VERIFIER_PASSED" || event.type === "GLOBAL_VERIFIER_FAILED"
  ));
  const integratedTreeHash = optionalText(globalEvent?.payload.integratedTreeHash);
  const globalVerificationId = optionalText(globalEvent?.payload.verificationId);
  const evidenceFiles = sealed.index.files.map((file) => structuredClone(file));
  const evidenceBindings = projectEvidenceBindings(plan, events, sealed.model.artifacts);
  const base = {
    schemaVersion: SWARM_PARENT_RECEIPT_SCHEMA_VERSION,
    swarmId: plan.swarmId,
    planHash: plan.planHash,
    objective: plan.parentContract.objective,
    engine: structuredClone(plan.engine),
    baselineCommit: plan.baselineCommit,
    tasks: projectTerminalTasks(plan.tasks, events),
    agents: projectTerminalAgents(plan.agents, events),
    budget: structuredClone(plan.parentContract.budget),
    budgetLedger: projectBudgetLedger(plan.parentContract.budget, events),
    childReceipts,
    blockedActions,
    reassignments,
    events: events.map((event) => structuredClone(event)),
    evidenceIndexSha256: sha256(sealed.indexBytes),
    evidenceFiles,
    evidenceBindings,
    ...(integratedTreeHash ? { integratedTreeHash } : {}),
    ...(globalVerificationId ? { globalVerificationId } : {}),
    parentOutcome: terminalOutcome,
    taskVerificationState: globalEvent?.type === "GLOBAL_VERIFIER_PASSED"
      ? "passed" as const
      : globalEvent?.type === "GLOBAL_VERIFIER_FAILED" ? "failed" as const : "unknown" as const,
    sealedAt: sealed.index.sealedAt
  };
  const receiptSha256 = sha256(stableJson(base));
  return {
    ...base,
    receiptId: `swarm-receipt-${receiptSha256.slice(0, 16)}`,
    receiptSha256
  };
}

function projectTerminalTasks(tasks: readonly SwarmTaskNode[], events: readonly SwarmLiveEvent[]): SwarmTaskNode[] {
  const projected = new Map(tasks.map((task) => [task.taskId, structuredClone(task)]));
  for (const event of [...events].sort(bySequence)) {
    if (!event.taskId) continue;
    const task = projected.get(event.taskId);
    if (!task) continue;
    if (event.type === "TASK_REASSIGNED") {
      const toAgentId = requiredText(event.payload.toAgentId, "INVALID_REASSIGNMENT_EVENT");
      projected.set(event.taskId, { ...task, assignedAgentId: toAgentId });
    } else if (event.type === "CHILD_STARTED") {
      projected.set(event.taskId, { ...task, status: "running" });
    } else if (event.type === "CHILD_VERIFIED") {
      projected.set(event.taskId, { ...task, status: "accepted" });
    } else if (event.type === "CHILD_STOPPED") {
      projected.set(event.taskId, { ...task, status: "stopped" });
    } else if (event.type === "CHILD_NEEDS_REVIEW") {
      projected.set(event.taskId, { ...task, status: "needs_review" });
    }
  }
  return tasks.map((task) => projected.get(task.taskId)!);
}

function projectTerminalAgents(agents: readonly SwarmAgentRecord[], events: readonly SwarmLiveEvent[]): SwarmAgentRecord[] {
  const projected = new Map(agents.map((agent) => [agent.agentId, structuredClone(agent)]));
  for (const event of [...events].sort(bySequence)) {
    if (!event.agentId) continue;
    const agent = projected.get(event.agentId);
    if (!agent) continue;
    if (event.type === "CHILD_STARTED") {
      projected.set(event.agentId, { ...agent, status: "running", ...(event.childRunId ? { childRunId: event.childRunId } : {}) });
    } else if (event.type === "CHILD_VERIFIED") {
      projected.set(event.agentId, { ...agent, status: "verified", ...(event.childRunId ? { childRunId: event.childRunId } : {}) });
    } else if (event.type === "CHILD_STOPPED") {
      projected.set(event.agentId, { ...agent, status: "stopped", ...(event.childRunId ? { childRunId: event.childRunId } : {}) });
    } else if (event.type === "CHILD_NEEDS_REVIEW") {
      projected.set(event.agentId, { ...agent, status: "needs_review", ...(event.childRunId ? { childRunId: event.childRunId } : {}) });
    }
  }
  return agents.map((agent) => projected.get(agent.agentId)!);
}

function projectBudgetLedger(
  budget: { maxUsd: number; maxTokens?: number },
  events: readonly SwarmLiveEvent[]
): SwarmBudgetLedger {
  const projected = new Map<string, SwarmBudgetLedger["leases"][number]>();
  const childLeaseIds = new Map<string, string>();
  for (const event of [...events].sort(bySequence)) {
    const explicitLeaseId = optionalText(event.payload.leaseId);
    if (explicitLeaseId && event.childRunId) childLeaseIds.set(event.childRunId, explicitLeaseId);
    const leaseId = explicitLeaseId ?? (event.childRunId ? childLeaseIds.get(event.childRunId) : undefined);
    if (!leaseId) continue;
    const previous = projected.get(leaseId);
    const reservedUsd = event.payload.reservedUsd === undefined
      ? previous?.reservedUsd
      : requiredNumber(event.payload.reservedUsd, "INVALID_CHILD_BUDGET_EVENT");
    const reservedTokens = event.payload.reservedTokens === undefined
      ? previous?.reservedTokens
      : requiredNumber(event.payload.reservedTokens, "INVALID_CHILD_BUDGET_EVENT");
    if (reservedUsd === undefined || reservedTokens === undefined) {
      throw new SwarmParentReceiptError("INVALID_CHILD_BUDGET_EVENT", "Persisted budget evidence omits the reserved lease amount.");
    }
    const statusValue = event.payload.leaseState;
    const status = statusValue === "settled" || statusValue === "overspent" || statusValue === "released" || statusValue === "reserved"
      ? statusValue
      : previous?.status ?? "reserved";
    const actualUsd = optionalNumber(event.payload.actualUsd);
    const actualTokens = optionalNumber(event.payload.actualTokens);
    projected.set(leaseId, {
      leaseId,
      agentId: previous?.agentId ?? requiredText(event.agentId, "INVALID_CHILD_BUDGET_EVENT"),
      taskId: previous?.taskId ?? requiredText(event.taskId, "INVALID_CHILD_BUDGET_EVENT"),
      reservedUsd,
      reservedTokens,
      status,
      ...(actualUsd !== undefined && actualTokens !== undefined
        ? { actualUsage: { usd: actualUsd, tokens: actualTokens } }
        : previous?.actualUsage ? { actualUsage: structuredClone(previous.actualUsage) } : {})
    });
  }
  const leases = [...projected.values()];
  return {
    capUsd: budget.maxUsd,
    ...(budget.maxTokens === undefined ? {} : { capTokens: budget.maxTokens }),
    settledUsd: leases.reduce((sum, lease) => sum + (lease.actualUsage?.usd ?? 0), 0),
    settledTokens: leases.reduce((sum, lease) => sum + (lease.actualUsage?.tokens ?? 0), 0),
    leases
  };
}

function projectEvidenceBindings(
  plan: ReadAndSealSwarmEvidenceResult["model"]["plan"],
  events: readonly SwarmLiveEvent[],
  artifacts: ReadAndSealSwarmEvidenceResult["model"]["artifacts"]
): SwarmParentReceipt["evidenceBindings"] {
  const admissions: string[] = [];
  const rejections: string[] = [];
  const conflicts: string[] = [];
  const integration: string[] = [];
  const globalVerification: string[] = [];
  const cleanup: string[] = [];
  for (const artifact of artifacts) {
    const value = artifact.value;
    const nestedDecision = isRecord(value.decision) ? value.decision : undefined;
    const decision = nestedDecision ?? (typeof value.candidateId === "string" ? value : undefined);
    const validDecision = decision ? isCanonicalDecision(decision, plan, events) : false;
    if (validDecision && decision?.state === "admitted") admissions.push(artifact.path);
    if (validDecision && decision?.state === "rejected") rejections.push(artifact.path);
    if (validDecision && (isRecord(value.conflict) || decision?.reasonCode === "integration_conflict")) conflicts.push(artifact.path);
    if ((nestedDecision && decision && validDecision && isCanonicalIntegrationEvent(value.event, decision, plan, events))
      || isCanonicalReconstruction(value, plan)) integration.push(artifact.path);
    if (isCanonicalGlobalVerification(value, plan, events)) globalVerification.push(artifact.path);
    if (isCanonicalCleanup(value, plan, artifacts)) cleanup.push(artifact.path);
  }
  return {
    admissions: uniqueSorted(admissions),
    rejections: uniqueSorted(rejections),
    conflicts: uniqueSorted(conflicts),
    integration: uniqueSorted(integration),
    globalVerification: uniqueSorted(globalVerification),
    cleanup: uniqueSorted(cleanup)
  };
}

function isCanonicalDecision(
  value: Record<string, unknown>,
  plan: ReadAndSealSwarmEvidenceResult["model"]["plan"],
  events: readonly SwarmLiveEvent[]
): boolean {
  if (
    value.schemaVersion !== SWARM_SCHEMA_VERSION
    || value.swarmId !== plan.swarmId
    || value.baselineCommit !== plan.baselineCommit
    || !isNonEmptyText(value.admissionId)
    || typeof value.candidateId !== "string"
    || !isNonEmptyText(value.workspaceId)
    || !isNonEmptyText(value.childRunId)
    || !isNonEmptyText(value.agentId)
    || !isStringArray(value.taskIds, true)
    || !isStringArray(value.changedPaths)
    || !["admitted", "rejected"].includes(String(value.state))
    || !SWARM_ADMISSION_REASON_CODES.has(String(value.reasonCode))
    || (value.state === "admitted" && value.reasonCode !== "admitted")
    || (value.state === "rejected" && value.reasonCode === "admitted")
    || !RECEIPT_INTEGRITY_STATES.has(String(value.receiptIntegrity))
    || (value.state === "admitted" && value.receiptIntegrity !== "verified")
    || !isNonEmptyText(value.decidedAt)
    || !isOptionalText(value.preIntegrationTreeHash)
    || !isOptionalText(value.postIntegrationTreeHash)
    || !isOptionalText(value.diagnostic)
  ) return false;
  const expectedTypes = value.state === "admitted"
    ? ["CHILD_PATCH_ADMITTED"]
    : value.reasonCode === "integration_conflict" ? ["INTEGRATION_CONFLICT"] : ["CHILD_PATCH_REJECTED"];
  return events.some((event) => (
    expectedTypes.includes(event.type)
    && event.payload.candidateId === value.candidateId
    && event.swarmId === plan.swarmId
    && event.planHash === plan.planHash
    && event.parentPolicyVersion === plan.parentContract.policyVersion
    && event.taskId !== undefined
    && (value.taskIds as unknown[]).includes(event.taskId)
    && event.agentId === value.agentId
    && event.childRunId === value.childRunId
    && Number.isInteger(event.sequence)
    && event.sequence > 0
    && isNonEmptyText(event.idempotencyKey)
    && isNonEmptyText(event.timestamp)
  ));
}

function isCanonicalIntegrationEvent(
  candidateEvent: unknown,
  decision: Record<string, unknown>,
  plan: ReadAndSealSwarmEvidenceResult["model"]["plan"],
  events: readonly SwarmLiveEvent[]
): boolean {
  if (!isRecord(candidateEvent) || !isRecord(candidateEvent.payload)) return false;
  const expectedType = decision.state === "admitted"
    ? "CHILD_PATCH_ADMITTED"
    : decision.reasonCode === "integration_conflict" ? "INTEGRATION_CONFLICT" : "CHILD_PATCH_REJECTED";
  if (
    candidateEvent.type !== expectedType
    || candidateEvent.swarmId !== plan.swarmId
    || candidateEvent.parentPolicyVersion !== plan.parentContract.policyVersion
    || candidateEvent.payload.candidateId !== decision.candidateId
  ) return false;
  return events.some((event) => event.planHash === plan.planHash
    && Number.isInteger(event.sequence)
    && event.sequence > 0
    && isNonEmptyText(event.idempotencyKey)
    && stableJson(projectLiveEvent(event)) === stableJson(candidateEvent));
}

function isCanonicalReconstruction(
  value: Record<string, unknown>,
  plan: ReadAndSealSwarmEvidenceResult["model"]["plan"]
): boolean {
  return value.schemaVersion === SWARM_SCHEMA_VERSION
    && value.swarmId === plan.swarmId
    && value.baselineCommit === plan.baselineCommit
    && typeof value.reconstructionId === "string"
    && typeof value.failedCandidateId === "string"
    && typeof value.previousWorkspaceId === "string"
    && typeof value.replacementWorkspaceId === "string"
    && ["completed", "failed"].includes(String(value.state))
    && (value.state !== "completed" || value.expectedTreeHash === value.actualTreeHash);
}

function isCanonicalGlobalVerification(
  value: Record<string, unknown>,
  plan: ReadAndSealSwarmEvidenceResult["model"]["plan"],
  events: readonly SwarmLiveEvent[]
): boolean {
  if (
    value.schemaVersion !== SWARM_SCHEMA_VERSION
    || value.swarmId !== plan.swarmId
    || value.parentPolicyVersion !== plan.parentContract.policyVersion
    || value.baselineCommit !== plan.baselineCommit
    || typeof value.verificationId !== "string"
    || !isNonEmptyText(value.workspaceId)
    || typeof value.integratedTreeHash !== "string"
    || !isStringArray(value.commands)
    || stableJson(value.commands) !== stableJson(plan.parentContract.globalVerifierStack.map((step) => step.command))
    || !["pending", "passed", "failed", "unknown"].includes(String(value.commandState))
    || !["pending", "clean", "mutated", "unknown"].includes(String(value.mutationState))
    || !isNonEmptyText(value.startedAt)
    || !isOptionalText(value.completedAt)
    || (["passed", "failed"].includes(String(value.commandState)) && !isNonEmptyText(value.completedAt))
    || !Array.isArray(value.subprocessResults)
    || !value.subprocessResults.every(isCanonicalVerifierSubprocess)
  ) return false;
  const expectedType = value.commandState === "passed" && value.mutationState === "clean"
    ? "GLOBAL_VERIFIER_PASSED"
    : "GLOBAL_VERIFIER_FAILED";
  const matching = events.filter((event) => (
    (event.type === "GLOBAL_VERIFIER_PASSED" || event.type === "GLOBAL_VERIFIER_FAILED")
    && event.payload.verificationId === value.verificationId
    && event.payload.integratedTreeHash === value.integratedTreeHash
    && event.swarmId === plan.swarmId
    && event.planHash === plan.planHash
    && event.parentPolicyVersion === plan.parentContract.policyVersion
    && Number.isInteger(event.sequence)
    && event.sequence > 0
    && isNonEmptyText(event.idempotencyKey)
    && isNonEmptyText(event.timestamp)
  ));
  return matching.length === 1 && matching[0]?.type === expectedType;
}

function isCanonicalCleanup(
  value: Record<string, unknown>,
  plan: ReadAndSealSwarmEvidenceResult["model"]["plan"],
  artifacts: ReadAndSealSwarmEvidenceResult["model"]["artifacts"]
): boolean {
  if (
    value.schemaVersion !== SWARM_SCHEMA_VERSION
    || value.swarmId !== plan.swarmId
    || typeof value.cleanupId !== "string"
    || typeof value.workspaceId !== "string"
    || !["pending", "completed", "failed", "cleanup_pending"].includes(String(value.state))
    || !["child", "integration", "verifier"].includes(String(value.workspaceKind))
    || !["not_required", "pending", "closed", "failed"].includes(String(value.processCloseState))
    || !["pending", "removed", "failed"].includes(String(value.removalState))
    || typeof value.evidencePersisted !== "boolean"
    || !isNonEmptyText(value.attemptedAt)
    || !isOptionalText(value.completedAt)
    || !isOptionalText(value.errorCode)
    || (value.state === "completed" && (!isNonEmptyText(value.completedAt) || value.removalState !== "removed"))
    || (value.state !== "completed" && !isNonEmptyText(value.errorCode))
  ) return false;
  return artifacts.some((artifact) => {
    const completionCleanup = artifact.value.cleanup;
    return isRecord(completionCleanup)
      && stableJson(completionCleanup) === stableJson(value);
  });
}

function projectLiveEvent(event: SwarmLiveEvent): Record<string, unknown> {
  return {
    type: event.type,
    swarmId: event.swarmId,
    timestamp: event.timestamp,
    parentPolicyVersion: event.parentPolicyVersion,
    ...(event.taskId ? { taskId: event.taskId } : {}),
    ...(event.agentId ? { agentId: event.agentId } : {}),
    ...(event.childRunId ? { childRunId: event.childRunId } : {}),
    ...(event.failureClass ? { failureClass: event.failureClass } : {}),
    payload: structuredClone(event.payload)
  };
}

function isCanonicalVerifierSubprocess(value: unknown): boolean {
  return isRecord(value)
    && isNonEmptyText(value.command)
    && typeof value.launched === "boolean"
    && typeof value.completed === "boolean"
    && typeof value.timedOut === "boolean"
    && (value.exitCode === null || (typeof value.exitCode === "number" && Number.isInteger(value.exitCode)))
    && isOptionalText(value.signal)
    && isNonEmptyText(value.startedAt)
    && isOptionalText(value.completedAt);
}

function isStringArray(value: unknown, requireNonEmpty = false): value is string[] {
  return Array.isArray(value)
    && (!requireNonEmpty || value.length > 0)
    && value.every((item) => isNonEmptyText(item));
}

function isNonEmptyText(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isOptionalText(value: unknown): boolean {
  return value === undefined || isNonEmptyText(value);
}

const RECEIPT_INTEGRITY_STATES = new Set([
  "verified", "unsigned", "tamper_detected", "relocated", "material_missing", "selector_noncanonical"
]);

const SWARM_ADMISSION_REASON_CODES = new Set([
  "admitted", "child_not_terminal", "process_active", "identity_mismatch", "receipt_not_verified",
  "receipt_scope_mismatch", "stale_baseline", "git_inventory_failed", "invalid_concrete_path", "unsafe_path",
  "undeclared_path", "path_not_allowed", "path_denied", "task_scope_violation", "candidate_changed_during_capture",
  "empty_candidate", "patch_hash_mismatch", "integration_precondition_failed", "integration_conflict",
  "integration_apply_failed", "artifact_persistence_failed"
]);

function requiredNumber(value: unknown, code: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new SwarmParentReceiptError(code, "Persisted budget evidence is malformed.");
  }
  return value;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

export function verifyParentSwarmReceipt(receipt: SwarmParentReceipt): { ok: true } | { ok: false; reason: string } {
  if (receipt.schemaVersion !== SWARM_PARENT_RECEIPT_SCHEMA_VERSION) {
    return { ok: false, reason: "UNKNOWN_RECEIPT_SCHEMA" };
  }
  try {
    if (stableJson(receipt.blockedActions) !== stableJson(projectBlockedActions(receipt.events))) {
      return { ok: false, reason: "BLOCKED_ACTION_PROJECTION_MISMATCH" };
    }
    if (stableJson(receipt.reassignments) !== stableJson(projectReassignments(receipt.events))) {
      return { ok: false, reason: "REASSIGNMENT_PROJECTION_MISMATCH" };
    }
  } catch (error) {
    return { ok: false, reason: error instanceof SwarmParentReceiptError ? error.code : "INVALID_EVENT_PROJECTION" };
  }
  const { receiptId, receiptSha256, ...base } = receipt;
  const expectedHash = sha256(stableJson(base));
  if (receiptSha256 !== expectedHash || receiptId !== `swarm-receipt-${expectedHash.slice(0, 16)}`) {
    return { ok: false, reason: "RECEIPT_HASH_MISMATCH" };
  }
  return { ok: true };
}

function projectBlockedActions(events: readonly SwarmLiveEvent[]): SwarmReceiptBlockedAction[] {
  return events
    .filter((event) => event.type === "ACTION_BLOCKED")
    .map((event) => ({
      eventId: requiredText(event.idempotencyKey, "INVALID_BLOCKED_ACTION_EVENT"),
      sequence: event.sequence,
      agentId: requiredText(event.agentId, "INVALID_BLOCKED_ACTION_EVENT"),
      taskId: requiredText(event.taskId, "INVALID_BLOCKED_ACTION_EVENT"),
      attemptId: requiredText(event.payload.attemptId, "INVALID_BLOCKED_ACTION_EVENT"),
      action: requiredText(event.payload.action, "INVALID_BLOCKED_ACTION_EVENT"),
      reason: requiredText(event.payload.reason, "INVALID_BLOCKED_ACTION_EVENT"),
      timestamp: requiredText(event.timestamp, "INVALID_BLOCKED_ACTION_EVENT")
    }))
    .sort(bySequence);
}

function projectReassignments(events: readonly SwarmLiveEvent[]): SwarmReceiptReassignment[] {
  return events
    .filter((event) => event.type === "TASK_REASSIGNED")
    .map((event) => ({
      eventId: requiredText(event.idempotencyKey, "INVALID_REASSIGNMENT_EVENT"),
      sequence: event.sequence,
      taskId: requiredText(event.taskId, "INVALID_REASSIGNMENT_EVENT"),
      fromAgentId: requiredText(event.payload.fromAgentId, "INVALID_REASSIGNMENT_EVENT"),
      toAgentId: requiredText(event.payload.toAgentId, "INVALID_REASSIGNMENT_EVENT"),
      fromAttemptId: requiredText(event.payload.fromAttemptId, "INVALID_REASSIGNMENT_EVENT"),
      toAttemptId: requiredText(event.payload.toAttemptId, "INVALID_REASSIGNMENT_EVENT"),
      reason: requiredText(event.payload.reason, "INVALID_REASSIGNMENT_EVENT"),
      timestamp: requiredText(event.timestamp, "INVALID_REASSIGNMENT_EVENT")
    }))
    .sort(bySequence);
}

function projectChildReceipts(sealed: ReadAndSealSwarmEvidenceResult): SwarmParentReceipt["childReceipts"] {
  const startedChildRuns = new Set(sealed.model.events
    .filter((event) => event.type === "CHILD_STARTED" && event.childRunId)
    .map((event) => event.childRunId));
  const terminalChildren = sealed.model.events.filter((event) => (
    event.childRunId
    && startedChildRuns.has(event.childRunId)
    && ["CHILD_VERIFIED", "CHILD_STOPPED", "CHILD_NEEDS_REVIEW"].includes(event.type)
  ));
  return terminalChildren.map((event) => {
    const matches = sealed.model.artifacts.filter((artifact) => (
      artifact.path.startsWith("evidence/child-completions/") && artifact.value.childRunId === event.childRunId
    ));
    if (matches.length !== 1) {
      throw new SwarmParentReceiptError("MISSING_CHILD_EVIDENCE", "Terminal child evidence must have one completion artifact.");
    }
    const value = matches[0]!.value;
    const receipt = isRecord(value.receipt) ? value.receipt : undefined;
    const integrity = receipt && isRecord(receipt.integrity) ? receipt.integrity : undefined;
    if (integrity?.state !== "verified") {
      throw new SwarmParentReceiptError("UNVERIFIED_CHILD_EVIDENCE", "Child receipt integrity must be verified.");
    }
    const childRunId = requiredText(value.childRunId, "INVALID_CHILD_EVIDENCE");
    const integrityFile = sealed.index.files.find((file) => file.path === `${childRunId}/receipt-integrity.json`);
    if (!integrityFile) {
      throw new SwarmParentReceiptError("MISSING_CHILD_INTEGRITY_FILE", "Child receipt integrity material is absent from the sealed index.");
    }
    const taskIds = value.taskIds;
    if (!Array.isArray(taskIds) || taskIds.some((taskId) => typeof taskId !== "string" || taskId.length === 0)) {
      throw new SwarmParentReceiptError("INVALID_CHILD_EVIDENCE", "Child completion task IDs are malformed.");
    }
    return {
      childRunId,
      agentId: requiredText(value.agentId, "INVALID_CHILD_EVIDENCE"),
      attemptId: requiredText(value.attemptId, "INVALID_CHILD_EVIDENCE"),
      taskIds: [...taskIds],
      receiptIntegritySha256: integrityFile.sha256
    };
  }).sort((left, right) => left.childRunId.localeCompare(right.childRunId));
}

function requiredText(value: unknown, code: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new SwarmParentReceiptError(code, "Persisted receipt evidence is missing required identity.");
  }
  return value;
}

function optionalText(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function bySequence(left: { sequence: number }, right: { sequence: number }): number {
  return left.sequence - right.sequence;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function stableJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
