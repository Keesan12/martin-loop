import { randomUUID } from "node:crypto";
import { constants, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";

import {
  createCheckpointStore,
  type CheckpointStore
} from "../persistence/checkpoint-store.js";
import { assertMissionId, assertSafeMissionPath } from "./path-safety.js";

export type MissionWorkItemStatus =
  | "pending"
  | "running"
  | "succeeded"
  | "verified"
  | "failed"
  | "blocked"
  | "cancelled";

export interface MissionWorkItem {
  id: string;
  title: string;
  dependsOn: string[];
  status: MissionWorkItemStatus;
  attempts: number;
  maxAttempts: number;
  updatedAt: string;
  lastError?: string;
  verification?: WorkItemVerification;
  lastTransition?: WorkItemTransitionRecord;
}

export type WorkItemActorRole = "supervisor" | "executor" | "verifier" | "operator";

export interface WorkItemEvidence {
  hash: string;
  source: string;
  observedAt: string;
}

export interface WorkItemVerification {
  verifierId: string;
  evidenceHash: string;
  source: string;
  verifiedAt: string;
}

export interface WorkItemTransitionRecord {
  from: MissionWorkItemStatus;
  to: MissionWorkItemStatus;
  actorId: string;
  actorRole: WorkItemActorRole;
  at: string;
  evidenceHash?: string;
  evidenceSource?: string;
}

export type MissionStopCode =
  | "budget_exhausted"
  | "completed"
  | "integrity_failure"
  | "lease_lost"
  | "no_runnable_work"
  | "operator_stop"
  | "recovery_limit"
  | "verifier_failure"
  | "wall_clock_exhausted"
  | "no_progress"
  | "external_event"
  | "provider_failure"
  | "policy_blocked"
  | "scope_violation"
  | "approval_required"
  | "human_interrupt"
  | "security_risk"
  | "host_failure"
  | "corrupt_state";

export interface MissionStopReason {
  code: MissionStopCode;
  message: string;
  at: string;
  workItemId?: string;
}

export type RecoveryDecisionKind = "retry" | "skip" | "escalate" | "stop";

export interface MissionRecoveryDecision {
  decisionId: string;
  kind: RecoveryDecisionKind;
  workItemId: string;
  reason: string;
  at: string;
}

export interface MissionBudgetSnapshot {
  maxUsd: number;
  spentUsd: number;
  startedAt: string;
  wallClockDeadline: string;
  maxRuns: number;
  runsUsed: number;
  maxTokens: number;
  tokensUsed: number;
  maxConcurrency: number;
  activeConcurrency: number;
  maxNoProgressIntervals: number;
  noProgressIntervals: number;
}

export interface MissionAccountingOpening {
  spentUsd: number;
  runsUsed: number;
  tokensUsed: number;
}

export interface MissionSettlement {
  settlementId: string;
  runId: string;
  workItemId: string;
  receiptHash: string;
  actualUsd: number;
  tokens: number;
  settledAt: string;
  verifier: {
    passed: boolean;
    verifierId: string;
    evidenceHash: string;
    source: string;
  };
}

export type MissionBudgetInput = Pick<MissionBudgetSnapshot, "maxUsd" | "spentUsd"> &
  Partial<Omit<MissionBudgetSnapshot, "maxUsd" | "spentUsd">>;

export interface MissionSupervisorState {
  schemaVersion: "martin.mission-supervisor.v1";
  missionId: string;
  objective: string;
  createdAt: string;
  updatedAt: string;
  workItems: MissionWorkItem[];
  recoveryDecisions: MissionRecoveryDecision[];
  budget: MissionBudgetSnapshot;
  accountingOpening: MissionAccountingOpening;
  settlements: MissionSettlement[];
  stop?: MissionStopReason;
}

export type MissionSupervisorErrorCode =
  | "corrupt_lease"
  | "clock_anomaly"
  | "authority_mutation"
  | "dependency_cycle"
  | "duplicate_work_item"
  | "invalid_mission_state"
  | "invalid_stop_reason"
  | "lease_held"
  | "lease_lost"
  | "lease_lock_timeout"
  | "missing_dependency"
  | "missing_work_item"
  | "settlement_conflict"
  | "transition_not_authorized";

export class MissionSupervisorError extends Error {
  constructor(
    public readonly code: MissionSupervisorErrorCode,
    message: string,
    public readonly details: Readonly<Record<string, unknown>> = {}
  ) {
    super(message);
    this.name = "MissionSupervisorError";
  }
}

const STATE_SCHEMA_VERSION = "martin.mission-supervisor.v1" as const;
const VALID_STATUSES = new Set<MissionWorkItemStatus>([
  "pending",
  "running",
  "succeeded",
  "verified",
  "failed",
  "blocked",
  "cancelled"
]);
const VALID_STOP_CODES = new Set<MissionStopCode>([
  "budget_exhausted",
  "completed",
  "integrity_failure",
  "lease_lost",
  "no_runnable_work",
  "operator_stop",
  "recovery_limit",
  "verifier_failure",
  "wall_clock_exhausted",
  "no_progress",
  "external_event",
  "provider_failure",
  "policy_blocked",
  "scope_violation",
  "approval_required",
  "human_interrupt",
  "security_risk",
  "host_failure",
  "corrupt_state"
]);

export function validateWorkItemDag(workItems: readonly MissionWorkItem[]): void {
  if (!Array.isArray(workItems)) {
    throw new MissionSupervisorError("invalid_mission_state", "workItems must be an array");
  }
  const byId = new Map<string, MissionWorkItem>();
  for (const item of workItems) {
    if (item === null || typeof item !== "object" || typeof item.id !== "string" ||
        typeof item.title !== "string" || !Array.isArray(item.dependsOn) ||
        !item.dependsOn.every((id: unknown) => typeof id === "string" && id.trim().length > 0) ||
        new Set(item.dependsOn).size !== item.dependsOn.length ||
        typeof item.updatedAt !== "string" || !Number.isFinite(Date.parse(item.updatedAt))) {
      throw new MissionSupervisorError("invalid_mission_state", "malformed work item");
    }
    if (!item.id.trim() || !item.title.trim() || byId.has(item.id)) {
      throw new MissionSupervisorError(
        "duplicate_work_item",
        `work item id must be non-empty and unique: ${item.id}`,
        { workItemId: item.id }
      );
    }
    if (
      !VALID_STATUSES.has(item.status) ||
      !Number.isSafeInteger(item.attempts) ||
      item.attempts < 0 ||
      !Number.isSafeInteger(item.maxAttempts) ||
      item.maxAttempts < 1 ||
      item.attempts > item.maxAttempts
    ) {
      throw new MissionSupervisorError("invalid_mission_state", `invalid work item: ${item.id}`);
    }
    if (item.status === "verified") {
      if (
        item.verification === undefined ||
        !item.verification.verifierId.trim() ||
        !/^[a-f0-9]{64}$/u.test(item.verification.evidenceHash) ||
        !item.verification.source.trim() ||
        !Number.isFinite(Date.parse(item.verification.verifiedAt))
      ) {
        throw new MissionSupervisorError(
          "transition_not_authorized",
          `verified work item ${item.id} lacks verifier authority and evidence`
        );
      }
    } else if (item.verification !== undefined) {
      throw new MissionSupervisorError(
        "invalid_mission_state",
        `non-verified work item ${item.id} contains verification evidence`
      );
    }
    byId.set(item.id, item);
  }

  for (const item of workItems) {
    for (const dependency of item.dependsOn) {
      if (!byId.has(dependency)) {
        throw new MissionSupervisorError(
          "missing_dependency",
          `work item ${item.id} depends on missing work item ${dependency}`,
          { workItemId: item.id, dependency }
        );
      }
    }
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string): void => {
    if (visiting.has(id)) {
      throw new MissionSupervisorError("dependency_cycle", `work item dependency cycle includes ${id}`, {
        workItemId: id
      });
    }
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dependency of byId.get(id)?.dependsOn ?? []) visit(dependency);
    visiting.delete(id);
    visited.add(id);
  };
  for (const item of workItems) visit(item.id);
}

function normalizeBudget(input: MissionBudgetInput, now: string): MissionBudgetSnapshot {
  return {
    maxUsd: input.maxUsd,
    spentUsd: input.spentUsd,
    startedAt: input.startedAt ?? now,
    wallClockDeadline: input.wallClockDeadline ?? "9999-12-31T23:59:59.999Z",
    maxRuns: input.maxRuns ?? Number.MAX_SAFE_INTEGER,
    runsUsed: input.runsUsed ?? 0,
    maxTokens: input.maxTokens ?? Number.MAX_SAFE_INTEGER,
    tokensUsed: input.tokensUsed ?? 0,
    maxConcurrency: input.maxConcurrency ?? 1,
    activeConcurrency: input.activeConcurrency ?? 0,
    maxNoProgressIntervals: input.maxNoProgressIntervals ?? Number.MAX_SAFE_INTEGER,
    noProgressIntervals: input.noProgressIntervals ?? 0
  };
}

function validateState(state: MissionSupervisorState, missionId?: string): void {
  if (
    state === null || typeof state !== "object" ||
    state.schemaVersion !== STATE_SCHEMA_VERSION ||
    typeof state.missionId !== "string" || typeof state.objective !== "string" ||
    !Number.isFinite(Date.parse(state.createdAt)) || !Number.isFinite(Date.parse(state.updatedAt)) ||
    state.budget === null || typeof state.budget !== "object" ||
    !Array.isArray(state.recoveryDecisions) ||
    state.accountingOpening === null || typeof state.accountingOpening !== "object" ||
    !Array.isArray(state.settlements) ||
    !state.missionId.trim() ||
    (missionId !== undefined && state.missionId !== missionId) ||
    !state.objective.trim() ||
    !Number.isFinite(state.budget.maxUsd) ||
    state.budget.maxUsd < 0 ||
    !Number.isFinite(state.budget.spentUsd) ||
    state.budget.spentUsd < 0 ||
    !Number.isFinite(Date.parse(state.budget.startedAt)) ||
    !Number.isFinite(Date.parse(state.budget.wallClockDeadline)) ||
    Date.parse(state.budget.wallClockDeadline) <= Date.parse(state.budget.startedAt) ||
    !Number.isSafeInteger(state.budget.maxRuns) || state.budget.maxRuns < 1 ||
    !Number.isSafeInteger(state.budget.runsUsed) || state.budget.runsUsed < 0 ||
    !Number.isSafeInteger(state.budget.maxTokens) || state.budget.maxTokens < 1 ||
    !Number.isSafeInteger(state.budget.tokensUsed) || state.budget.tokensUsed < 0 ||
    !Number.isSafeInteger(state.budget.maxConcurrency) || state.budget.maxConcurrency < 1 ||
    !Number.isSafeInteger(state.budget.activeConcurrency) || state.budget.activeConcurrency < 0 ||
    state.budget.activeConcurrency > state.budget.maxConcurrency ||
    !Number.isSafeInteger(state.budget.maxNoProgressIntervals) ||
    state.budget.maxNoProgressIntervals < 1 ||
    !Number.isSafeInteger(state.budget.noProgressIntervals) || state.budget.noProgressIntervals < 0
  ) {
    throw new MissionSupervisorError("invalid_mission_state", "mission supervisor state is invalid");
  }
  validateWorkItemDag(state.workItems);
  const decisionIds = new Set<string>();
  for (const decision of state.recoveryDecisions) {
    if (decision === null || typeof decision !== "object" ||
        typeof decision.decisionId !== "string" || !decision.decisionId.trim() ||
        decisionIds.has(decision.decisionId) ||
        !["retry", "skip", "escalate", "stop"].includes(decision.kind) ||
        !state.workItems.some((item) => item.id === decision.workItemId) ||
        typeof decision.reason !== "string" || !decision.reason.trim() ||
        !Number.isFinite(Date.parse(decision.at))) {
      throw new MissionSupervisorError("invalid_mission_state", "invalid recovery decision");
    }
    decisionIds.add(decision.decisionId);
  }
  if (
    !Number.isFinite(state.accountingOpening.spentUsd) || state.accountingOpening.spentUsd < 0 ||
    !Number.isSafeInteger(state.accountingOpening.runsUsed) || state.accountingOpening.runsUsed < 0 ||
    !Number.isSafeInteger(state.accountingOpening.tokensUsed) || state.accountingOpening.tokensUsed < 0
  ) {
    throw new MissionSupervisorError("invalid_mission_state", "invalid accounting opening balance");
  }
  const settlementIds = new Set<string>();
  const settlementRunIds = new Set<string>();
  let settledUsd = state.accountingOpening.spentUsd;
  let settledRuns = state.accountingOpening.runsUsed;
  let settledTokens = state.accountingOpening.tokensUsed;
  for (const settlement of state.settlements) {
    if (
      settlement === null || typeof settlement !== "object" ||
      !settlement.settlementId?.trim() || settlementIds.has(settlement.settlementId) ||
      !settlement.runId?.trim() || settlementRunIds.has(settlement.runId) ||
      !state.workItems.some((item) => item.id === settlement.workItemId) ||
      !/^[a-f0-9]{64}$/u.test(settlement.receiptHash) ||
      !Number.isFinite(settlement.actualUsd) || settlement.actualUsd < 0 ||
      !Number.isSafeInteger(settlement.tokens) || settlement.tokens < 0 ||
      !Number.isFinite(Date.parse(settlement.settledAt)) ||
      typeof settlement.verifier?.passed !== "boolean" ||
      !settlement.verifier.verifierId?.trim() ||
      !/^[a-f0-9]{64}$/u.test(settlement.verifier.evidenceHash) ||
      !settlement.verifier.source?.trim()
    ) {
      throw new MissionSupervisorError("invalid_mission_state", "invalid or duplicate settlement");
    }
    settlementIds.add(settlement.settlementId);
    settlementRunIds.add(settlement.runId);
    settledUsd += settlement.actualUsd;
    settledRuns += 1;
    settledTokens += settlement.tokens;
  }
  if (
    Math.abs(state.budget.spentUsd - settledUsd) > 1e-9 ||
    state.budget.runsUsed !== settledRuns ||
    state.budget.tokensUsed !== settledTokens
  ) {
    throw new MissionSupervisorError(
      "authority_mutation",
      "budget accounting does not match the exactly-once settlement ledger"
    );
  }
  if (state.stop !== undefined && (state.stop === null || !VALID_STOP_CODES.has(state.stop.code) ||
      typeof state.stop.message !== "string" || !state.stop.message.trim() ||
      !Number.isFinite(Date.parse(state.stop.at)))) {
    throw new MissionSupervisorError("invalid_stop_reason", `unknown stop reason: ${state.stop.code}`);
  }
}

export interface MissionProgressSnapshot {
  total: number;
  pending: number;
  running: number;
  succeeded: number;
  verified: number;
  failed: number;
  blocked: number;
  cancelled: number;
  terminal: number;
  completionRatio: number;
  runnableWorkItemIds: string[];
}

export function getProgressSnapshot(state: MissionSupervisorState): MissionProgressSnapshot {
  validateState(state);
  const counts: Record<MissionWorkItemStatus, number> = {
    pending: 0,
    running: 0,
    succeeded: 0,
    verified: 0,
    failed: 0,
    blocked: 0,
    cancelled: 0
  };
  const byId = new Map(state.workItems.map((item) => [item.id, item]));
  for (const item of state.workItems) counts[item.status] += 1;
  const terminal = counts.verified + counts.failed + counts.blocked + counts.cancelled;
  return {
    total: state.workItems.length,
    ...counts,
    terminal,
    completionRatio: state.workItems.length === 0 ? 1 : terminal / state.workItems.length,
    runnableWorkItemIds: state.workItems
      .filter(
        (item) =>
          item.status === "pending" && item.attempts < item.maxAttempts &&
          state.stop === undefined && state.budget.spentUsd < state.budget.maxUsd &&
          state.budget.runsUsed < state.budget.maxRuns &&
          state.budget.tokensUsed < state.budget.maxTokens &&
          state.budget.activeConcurrency < state.budget.maxConcurrency &&
          state.budget.noProgressIntervals < state.budget.maxNoProgressIntervals &&
          item.dependsOn.every((dependency) => byId.get(dependency)?.status === "verified")
      )
      .map((item) => item.id)
  };
}

export interface WorkItemTransitionRequest {
  workItemId: string;
  to: MissionWorkItemStatus;
  actor: { id: string; role: WorkItemActorRole };
  evidence?: WorkItemEvidence;
  at?: string;
}

function authorizeTransition(
  from: MissionWorkItemStatus,
  request: WorkItemTransitionRequest
): void {
  const evidenceValid =
    request.evidence !== undefined &&
    /^[a-f0-9]{64}$/u.test(request.evidence.hash) &&
    request.evidence.source.trim().length > 0 &&
    Number.isFinite(Date.parse(request.evidence.observedAt));
  const allowed =
    (from === "pending" && request.to === "running" &&
      (request.actor.role === "supervisor" || request.actor.role === "executor")) ||
    (from === "running" && request.to === "succeeded" &&
      request.actor.role === "executor" && evidenceValid) ||
    (from === "succeeded" && request.to === "verified" &&
      request.actor.role === "verifier" && evidenceValid) ||
    (from === "succeeded" && request.to === "blocked" &&
      request.actor.role === "supervisor" && request.actor.id === "mission-runtime" && evidenceValid) ||
    (from === "running" && (request.to === "failed" || request.to === "blocked") &&
      (request.actor.role === "executor" || request.actor.role === "supervisor") && evidenceValid) ||
    ((from === "failed" || from === "blocked") && request.to === "pending" &&
      request.actor.role === "supervisor") ||
    ((from === "pending" || from === "running") && request.to === "cancelled" &&
      request.actor.role === "operator");
  if (!request.actor.id.trim() || !allowed) {
    throw new MissionSupervisorError(
      "transition_not_authorized",
      `${request.actor.role} is not authorized for ${from} -> ${request.to}`,
      { from, to: request.to, actorRole: request.actor.role }
    );
  }
}

export function transitionWorkItem(
  state: MissionSupervisorState,
  request: WorkItemTransitionRequest
): MissionSupervisorState {
  validateState(state);
  const current = state.workItems.find((item) => item.id === request.workItemId);
  if (current === undefined) {
    throw new MissionSupervisorError("missing_work_item", `unknown work item: ${request.workItemId}`);
  }
  authorizeTransition(current.status, request);
  const at = request.at ?? request.evidence?.observedAt ?? new Date().toISOString();
  if (!Number.isFinite(Date.parse(at))) throw new TypeError("transition timestamp must be valid");
  const transition: WorkItemTransitionRecord = {
    from: current.status,
    to: request.to,
    actorId: request.actor.id,
    actorRole: request.actor.role,
    at,
    ...(request.evidence === undefined
      ? {}
      : { evidenceHash: request.evidence.hash, evidenceSource: request.evidence.source })
  };
  const updatedItem: MissionWorkItem = {
    ...current,
    status: request.to,
    updatedAt: at,
    attempts: current.status === "pending" && request.to === "running"
      ? current.attempts + 1
      : current.attempts,
    lastTransition: transition,
    ...(request.to === "verified" && request.evidence !== undefined
      ? {
          verification: {
            verifierId: request.actor.id,
            evidenceHash: request.evidence.hash,
            source: request.evidence.source,
            verifiedAt: at
          }
        }
      : { verification: undefined })
  };
  const updated: MissionSupervisorState = {
    ...state,
    updatedAt: at,
    workItems: state.workItems.map((item) => item.id === current.id ? updatedItem : item)
  };
  validateState(updated);
  return updated;
}

export function stopMission(
  state: MissionSupervisorState,
  reason: MissionStopReason
): MissionSupervisorState {
  validateState(state);
  if (!VALID_STOP_CODES.has(reason.code)) {
    throw new MissionSupervisorError("invalid_stop_reason", `unknown stop reason: ${String(reason.code)}`);
  }
  const stopped = { ...state, updatedAt: reason.at, stop: { ...reason } };
  validateState(stopped);
  return stopped;
}

export function evaluateMissionStop(
  state: MissionSupervisorState,
  at: string = new Date().toISOString()
): MissionStopReason | null {
  validateState(state);
  if (state.stop !== undefined) return { ...state.stop };
  if (Date.parse(at) >= Date.parse(state.budget.wallClockDeadline)) {
    return { code: "wall_clock_exhausted", message: "mission wall-clock deadline is exhausted", at };
  }
  if (state.budget.spentUsd >= state.budget.maxUsd) {
    return { code: "budget_exhausted", message: "mission budget is exhausted", at };
  }
  if (state.budget.runsUsed >= state.budget.maxRuns) {
    return { code: "budget_exhausted", message: "mission run budget is exhausted", at };
  }
  if (state.budget.tokensUsed >= state.budget.maxTokens) {
    return { code: "budget_exhausted", message: "mission token budget is exhausted", at };
  }
  if (state.budget.noProgressIntervals >= state.budget.maxNoProgressIntervals) {
    return { code: "no_progress", message: "mission no-progress limit is exhausted", at };
  }
  if (state.workItems.every((item) => item.status === "verified")) {
    return { code: "completed", message: "all mission work items are verified", at };
  }
  const progress = getProgressSnapshot(state);
  if (progress.running === 0 && progress.runnableWorkItemIds.length === 0) {
    return {
      code: "no_runnable_work",
      message: "no pending work item has satisfied dependencies",
      at
    };
  }
  return null;
}

export function decideRecovery(
  state: MissionSupervisorState,
  workItemId: string,
  options: { maxRecoveryDecisions: number; now?: string }
): { state: MissionSupervisorState; decision: MissionRecoveryDecision } {
  validateState(state);
  if (!Number.isSafeInteger(options.maxRecoveryDecisions) || options.maxRecoveryDecisions < 1) {
    throw new RangeError("maxRecoveryDecisions must be a positive safe integer");
  }
  const item = state.workItems.find((candidate) => candidate.id === workItemId);
  if (item === undefined) {
    throw new MissionSupervisorError("missing_work_item", `unknown work item: ${workItemId}`);
  }
  const at = options.now ?? new Date().toISOString();
  const recoveryLimitReached = state.recoveryDecisions.length >= options.maxRecoveryDecisions;
  const evaluatedStop = evaluateMissionStop(state, at);
  const budgetStop = evaluatedStop !== null && [
    "budget_exhausted",
    "wall_clock_exhausted",
    "no_progress"
  ].includes(evaluatedStop.code)
    ? evaluatedStop
    : null;
  const retryAllowed =
    state.stop === undefined && !recoveryLimitReached &&
    budgetStop === null &&
    (item.status === "failed" || item.status === "blocked") &&
    item.attempts < item.maxAttempts &&
    state.budget.activeConcurrency < state.budget.maxConcurrency;
  const kind: RecoveryDecisionKind = state.stop !== undefined || recoveryLimitReached || budgetStop !== null
    ? "stop"
    : retryAllowed
      ? "retry"
      : "escalate";
  const reason = recoveryLimitReached
    ? "recovery decision limit reached"
    : budgetStop !== null
      ? budgetStop.message
    : retryAllowed
      ? "bounded retry remains within work-item and budget limits"
      : "automatic retry is not authorized by current state";
  const decision: MissionRecoveryDecision = {
    decisionId: randomUUID(),
    kind,
    workItemId,
    reason,
    at
  };
  const recoveryDecisions = recoveryLimitReached
    ? state.recoveryDecisions.slice(-options.maxRecoveryDecisions)
    : [...state.recoveryDecisions, decision];
  let updated: MissionSupervisorState = { ...state, updatedAt: at, recoveryDecisions };
  if (kind === "stop" && state.stop === undefined) {
    updated = stopMission(updated, {
      code: budgetStop?.code ?? "recovery_limit",
      message: reason,
      at,
      workItemId
    });
  }
  return { state: updated, decision };
}

export interface MorningDossier {
  schemaVersion: "martin.morning-dossier.v1";
  missionId: string;
  objective: string;
  updatedAt: string;
  progress: MissionProgressSnapshot;
  budget: MissionBudgetSnapshot & {
    remainingUsd: number;
    remainingRuns: number;
    remainingTokens: number;
    availableConcurrency: number;
    remainingNoProgressIntervals: number;
  };
  recoveryDecisionCount: number;
  stop?: MissionStopReason;
  blockers: Array<{ workItemId: string; title: string; reason: string }>;
  workItems: MissionWorkItem[];
  truncatedWorkItemCount: number;
}

export function buildMorningDossier(
  state: MissionSupervisorState,
  options: { maxItems?: number } = {}
): MorningDossier {
  validateState(state);
  const maxItems = options.maxItems ?? 100;
  if (!Number.isSafeInteger(maxItems) || maxItems < 1) {
    throw new RangeError("maxItems must be a positive safe integer");
  }
  const workItems = state.workItems.slice(0, maxItems).map((item) => ({
    ...item,
    dependsOn: [...item.dependsOn]
  }));
  return {
    schemaVersion: "martin.morning-dossier.v1",
    missionId: state.missionId,
    objective: state.objective,
    updatedAt: state.updatedAt,
    progress: getProgressSnapshot(state),
    budget: {
      ...state.budget,
      remainingUsd: Math.max(0, state.budget.maxUsd - state.budget.spentUsd),
      remainingRuns: Math.max(0, state.budget.maxRuns - state.budget.runsUsed),
      remainingTokens: Math.max(0, state.budget.maxTokens - state.budget.tokensUsed),
      availableConcurrency: Math.max(0, state.budget.maxConcurrency - state.budget.activeConcurrency),
      remainingNoProgressIntervals: Math.max(
        0,
        state.budget.maxNoProgressIntervals - state.budget.noProgressIntervals
      )
    },
    recoveryDecisionCount: state.recoveryDecisions.length,
    ...(state.stop === undefined ? {} : { stop: { ...state.stop } }),
    blockers: state.workItems
      .filter((item) => item.status === "blocked" || item.status === "failed")
      .slice(0, maxItems)
      .map((item) => ({
        workItemId: item.id,
        title: item.title,
        reason: item.lastError ?? item.status
      })),
    workItems,
    truncatedWorkItemCount: Math.max(0, state.workItems.length - workItems.length)
  };
}

export interface SupervisorLease {
  schemaVersion: "martin.supervisor-lease.v1";
  missionId: string;
  holderId: string;
  token: string;
  acquiredAt: string;
  heartbeatAt: string;
  expiresAt: string;
}

export interface MissionSupervisor {
  initialize(options: {
    objective: string;
    workItems: MissionWorkItem[];
    budget: MissionBudgetInput;
    checkpointId: string;
    writerId: string;
    now?: string;
  }): Promise<{ state: MissionSupervisorState; checkpointHash: string }>;
  load(): Promise<MissionSupervisorState | null>;
  acquireLease(options: { holderId: string; ttlMs: number; now?: string }): Promise<SupervisorLease>;
  renewLease(options: { leaseToken: string; ttlMs: number; now?: string }): Promise<SupervisorLease>;
  releaseLease(leaseToken: string): Promise<void>;
  transitionWorkItem(
    request: WorkItemTransitionRequest,
    options: MissionAuthorityWriteOptions
  ): Promise<{ state: MissionSupervisorState; checkpointHash: string }>;
  recordSettlement(
    settlement: MissionSettlement,
    options: MissionAuthorityWriteOptions
  ): Promise<{ state: MissionSupervisorState; checkpointHash: string }>;
  save(
    state: MissionSupervisorState,
    options: {
      checkpointId: string;
      expectedHeadHash: string;
      leaseToken: string;
      now?: string;
    }
  ): Promise<{ state: MissionSupervisorState; checkpointHash: string }>;
}

export interface MissionAuthorityWriteOptions {
  checkpointId: string;
  expectedHeadHash: string;
  leaseToken: string;
  now?: string;
}

function isFileSystemError(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

export function createMissionSupervisor(options: {
  root: string;
  missionId: string;
  maxArrayEntries?: number;
  leaseLockTimeoutMs?: number;
  leaseLockStaleMs?: number;
}): MissionSupervisor {
  assertMissionId(options.missionId);
  const maxArrayEntries = options.maxArrayEntries ?? 500;
  if (!Number.isSafeInteger(maxArrayEntries) || maxArrayEntries < 1) {
    throw new RangeError("maxArrayEntries must be a positive safe integer");
  }
  function validatePersistedState(state: MissionSupervisorState): void {
    validateState(state, options.missionId);
    // Authority-bearing arrays must never be silently compacted.
    if (state.workItems.length > maxArrayEntries ||
        state.recoveryDecisions.length > maxArrayEntries ||
        state.settlements.length > maxArrayEntries ||
        state.workItems.some((item) => item.dependsOn.length > maxArrayEntries)) {
      throw new MissionSupervisorError("invalid_mission_state", "mission arrays exceed durable state limits");
    }
  }

  function validatePersistedTransitions(
    current: MissionSupervisorState,
    next: MissionSupervisorState
  ): void {
    const currentById = new Map(current.workItems.map((item) => [item.id, item]));
    if (
      current.workItems.length !== next.workItems.length ||
      next.workItems.some((item) => !currentById.has(item.id))
    ) {
      throw new MissionSupervisorError(
        "transition_not_authorized",
        "work-item DAG membership is immutable after mission initialization"
      );
    }
    for (const item of next.workItems) {
      const previous = currentById.get(item.id)!;
      if (item.status === previous.status) {
        if (
          item.title !== previous.title ||
          item.maxAttempts !== previous.maxAttempts ||
          JSON.stringify(item.dependsOn) !== JSON.stringify(previous.dependsOn)
        ) {
          throw new MissionSupervisorError(
            "transition_not_authorized",
            `work-item DAG definition changed after initialization for ${item.id}`
          );
        }
        if (item.attempts !== previous.attempts) {
          throw new MissionSupervisorError(
            "transition_not_authorized",
            `attempt count changed without a status transition for ${item.id}`
          );
        }
        continue;
      }
      const record = item.lastTransition;
      if (
        record === undefined ||
        record.from !== previous.status ||
        record.to !== item.status ||
        record.at !== item.updatedAt
      ) {
        throw new MissionSupervisorError(
          "transition_not_authorized",
          `work item ${item.id} lacks a matching transition record`
        );
      }
      authorizeTransition(previous.status, {
        workItemId: item.id,
        to: item.status,
        actor: { id: record.actorId, role: record.actorRole },
        at: record.at,
        ...(record.evidenceHash === undefined || record.evidenceSource === undefined
          ? {}
          : {
              evidence: {
                hash: record.evidenceHash,
                source: record.evidenceSource,
                observedAt: record.at
              }
            })
      });
      const expectedAttempts = previous.status === "pending" && item.status === "running"
        ? previous.attempts + 1
        : previous.attempts;
      if (item.attempts !== expectedAttempts) {
        throw new MissionSupervisorError(
          "transition_not_authorized",
          `work item ${item.id} has an invalid attempt count for its transition`
        );
      }
    }
  }
  const missionRoot = assertSafeMissionPath(options.root, options.missionId);
  const checkpointStore: CheckpointStore<MissionSupervisorState> = createCheckpointStore({
    root: join(missionRoot, "state"),
    maxArrayEntries
  });
  const leasePath = join(missionRoot, "supervisor-lease.json");
  const leaseLockPath = join(missionRoot, ".supervisor-lease.lock");
  const leaseLockTimeoutMs = options.leaseLockTimeoutMs ?? 3_000;
  const leaseLockStaleMs = options.leaseLockStaleMs ?? 30_000;
  if (!Number.isFinite(leaseLockTimeoutMs) || leaseLockTimeoutMs < 0) {
    throw new RangeError("leaseLockTimeoutMs must be finite and non-negative");
  }
  if (!Number.isFinite(leaseLockStaleMs) || leaseLockStaleMs < 1) {
    throw new RangeError("leaseLockStaleMs must be finite and positive");
  }

  async function readLease(): Promise<SupervisorLease | null> {
    let raw: string;
    try {
      raw = await readFile(leasePath, "utf8");
    } catch (error) {
      if (isFileSystemError(error, "ENOENT")) return null;
      throw error;
    }
    try {
      const lease = JSON.parse(raw) as SupervisorLease;
      if (
        lease.schemaVersion !== "martin.supervisor-lease.v1" ||
        lease.missionId !== options.missionId ||
        typeof lease.holderId !== "string" || !lease.holderId.trim() ||
        typeof lease.token !== "string" || !lease.token.trim() ||
        !Number.isFinite(Date.parse(lease.heartbeatAt)) ||
        Date.parse(lease.heartbeatAt) < Date.parse(lease.acquiredAt) ||
        Date.parse(lease.heartbeatAt) >= Date.parse(lease.expiresAt) ||
        Date.parse(lease.expiresAt) <= Date.parse(lease.acquiredAt) ||
        !Number.isFinite(Date.parse(lease.acquiredAt)) ||
        !Number.isFinite(Date.parse(lease.expiresAt))
      ) {
        throw new Error("invalid lease shape");
      }
      return lease;
    } catch (error) {
      throw new MissionSupervisorError("corrupt_lease", "supervisor lease is malformed", {
        cause: error instanceof Error ? error.message : String(error)
      });
    }
  }

  async function withLeaseLock<T>(fn: () => Promise<T>): Promise<T> {
    assertSafeMissionPath(options.root, options.missionId);
    await mkdir(missionRoot, { recursive: true });
    const startedAt = Date.now();
    const lockOwner = {
      token: randomUUID(),
      pid: process.pid,
      acquiredAt: new Date().toISOString()
    };
    let handle;
    while (Date.now() - startedAt <= leaseLockTimeoutMs) {
      try {
        handle = await open(leaseLockPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY);
        break;
      } catch (error) {
        if (!isFileSystemError(error, "EEXIST")) throw error;
        await reclaimStaleLeaseLock();
        await new Promise<void>((resolve) => setTimeout(resolve, 20));
      }
    }
    if (handle === undefined) {
      throw new MissionSupervisorError("lease_lock_timeout", "supervisor lease lock is held");
    }
    try {
      await handle.writeFile(`${JSON.stringify(lockOwner)}\n`, "utf8");
      await handle.close();
      return await fn();
    } finally {
      await handle.close().catch(() => {});
      const raw = await readFile(leaseLockPath, "utf8").catch(() => null);
      if (raw !== null) {
        try {
          const current = JSON.parse(raw) as { token?: string };
          if (current.token === lockOwner.token) await rm(leaseLockPath, { force: true });
        } catch {
          // Fail closed: never delete a lock whose owner cannot be proven.
        }
      }
    }
  }

  function isProcessAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return !isFileSystemError(error, "ESRCH");
    }
  }

  async function reclaimStaleLeaseLock(): Promise<void> {
    const reclaimPath = `${leaseLockPath}.reclaim`;
    const reclaimOwner = {
      token: randomUUID(),
      pid: process.pid,
      acquiredAt: new Date().toISOString()
    };
    let handle;
    try {
      handle = await open(reclaimPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY);
    } catch (error) {
      if (isFileSystemError(error, "EEXIST")) {
        await removeDeadOwnerFile(reclaimPath, leaseLockStaleMs);
        return;
      }
      throw error;
    }
    try {
      await handle.writeFile(`${JSON.stringify(reclaimOwner)}\n`, "utf8");
      const raw = await readFile(leaseLockPath, "utf8").catch(() => null);
      if (raw === null) return;
      let owner: { token: string; pid: number; acquiredAt: string };
      try {
        owner = JSON.parse(raw) as typeof owner;
      } catch {
        return;
      }
      if (
        typeof owner.token !== "string" || !owner.token ||
        !Number.isSafeInteger(owner.pid) || owner.pid < 1 ||
        !Number.isFinite(Date.parse(owner.acquiredAt)) ||
        Date.now() - Date.parse(owner.acquiredAt) < leaseLockStaleMs ||
        isProcessAlive(owner.pid)
      ) {
        return;
      }
      const current = await readFile(leaseLockPath, "utf8").catch(() => null);
      if (current === raw) await rm(leaseLockPath, { force: true });
    } finally {
      await handle.close().catch(() => {});
      await rm(reclaimPath, { force: true });
    }
  }

  async function removeDeadOwnerFile(path: string, staleMs: number): Promise<void> {
    const raw = await readFile(path, "utf8").catch(() => null);
    if (raw === null) return;
    let owner: { token: string; pid: number; acquiredAt: string };
    try {
      owner = JSON.parse(raw) as typeof owner;
    } catch {
      return;
    }
    if (
      typeof owner.token !== "string" || !owner.token ||
      !Number.isSafeInteger(owner.pid) || owner.pid < 1 ||
      !Number.isFinite(Date.parse(owner.acquiredAt)) ||
      Date.now() - Date.parse(owner.acquiredAt) < staleMs ||
      isProcessAlive(owner.pid)
    ) {
      return;
    }
    const current = await readFile(path, "utf8").catch(() => null);
    if (current === raw) await rm(path, { force: true });
  }

  async function writeLease(lease: SupervisorLease): Promise<void> {
    const tempPath = join(missionRoot, `.supervisor-lease.${lease.token}.tmp`);
    const handle = await open(tempPath, "wx");
    try {
      await handle.writeFile(`${JSON.stringify(lease, null, 2)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(tempPath, leasePath);
  }

  async function assertLease(token: string, now: string): Promise<SupervisorLease> {
    if (!Number.isFinite(Date.parse(now))) throw new TypeError("lease timestamp must be valid");
    const lease = await readLease();
    if (lease !== null && Date.parse(now) < Date.parse(lease.heartbeatAt)) {
      throw new MissionSupervisorError("clock_anomaly", "lease clock moved backward", {
        heartbeatAt: lease.heartbeatAt,
        observedAt: now
      });
    }
    if (lease === null || lease.token !== token || Date.parse(lease.expiresAt) <= Date.parse(now)) {
      throw new MissionSupervisorError("lease_lost", "supervisor does not hold the active mission lease");
    }
    return lease;
  }

  async function acquireLease(input: {
    holderId: string;
    ttlMs: number;
    now?: string;
  }): Promise<SupervisorLease> {
    if (!input.holderId.trim()) throw new TypeError("holderId must not be empty");
    if (!Number.isSafeInteger(input.ttlMs) || input.ttlMs < 1) {
      throw new RangeError("ttlMs must be a positive safe integer");
    }
    return await withLeaseLock(async () => {
      const now = input.now ?? new Date().toISOString();
      if (!Number.isFinite(Date.parse(now))) throw new TypeError("lease timestamp must be valid");
      const current = await readLease();
      if (current !== null && Date.parse(now) < Date.parse(current.heartbeatAt)) {
        throw new MissionSupervisorError("clock_anomaly", "lease acquisition clock moved backward");
      }
      if (current !== null && Date.parse(current.expiresAt) > Date.parse(now)) {
        throw new MissionSupervisorError("lease_held", "mission supervisor lease is already held", {
          holderId: current.holderId,
          expiresAt: current.expiresAt
        });
      }
      const lease: SupervisorLease = {
        schemaVersion: "martin.supervisor-lease.v1",
        missionId: options.missionId,
        holderId: input.holderId,
        token: randomUUID(),
        acquiredAt: now,
        heartbeatAt: now,
        expiresAt: new Date(Date.parse(now) + input.ttlMs).toISOString()
      };
      await writeLease(lease);
      return lease;
    });
  }

  function withoutUpdatedAt(state: MissionSupervisorState): Omit<MissionSupervisorState, "updatedAt"> {
    const { updatedAt: _updatedAt, ...authorityState } = state;
    return authorityState;
  }

  async function writeAuthorizedState(
    input: MissionAuthorityWriteOptions,
    transform: (current: MissionSupervisorState) => MissionSupervisorState
  ): Promise<{ state: MissionSupervisorState; checkpointHash: string }> {
    const now = input.now ?? new Date().toISOString();
    return await withLeaseLock(async () => {
      const lease = await assertLease(input.leaseToken, now);
      const currentCheckpoint = await checkpointStore.loadHead();
      if (currentCheckpoint === null || currentCheckpoint.hash !== input.expectedHeadHash) {
        throw new MissionSupervisorError(
          "authority_mutation",
          "authority write is not bound to the expected durable head"
        );
      }
      const state = transform(structuredClone(currentCheckpoint.state));
      validatePersistedState(state);
      const appended = await checkpointStore.append(state, {
        checkpointId: input.checkpointId,
        writerId: lease.holderId,
        expectedHeadHash: input.expectedHeadHash,
        now
      });
      return { state: appended.checkpoint.state, checkpointHash: appended.checkpoint.hash };
    });
  }

  return {
    async initialize(input) {
      assertSafeMissionPath(options.root, options.missionId);
      validateWorkItemDag(input.workItems);
      if (input.workItems.some((item) => item.status !== "pending" || item.attempts !== 0)) {
        throw new MissionSupervisorError(
          "transition_not_authorized",
          "fresh missions must initialize work items as pending with zero attempts"
        );
      }
      const now = input.now ?? new Date().toISOString();
      const state: MissionSupervisorState = {
        schemaVersion: STATE_SCHEMA_VERSION,
        missionId: options.missionId,
        objective: input.objective,
        createdAt: now,
        updatedAt: now,
        workItems: input.workItems.map((item) => ({ ...item, dependsOn: [...item.dependsOn] })),
        recoveryDecisions: [],
        budget: normalizeBudget(input.budget, now),
        accountingOpening: {
          spentUsd: input.budget.spentUsd,
          runsUsed: input.budget.runsUsed ?? 0,
          tokensUsed: input.budget.tokensUsed ?? 0
        },
        settlements: []
      };
      validatePersistedState(state);
      const appended = await checkpointStore.append(state, {
        checkpointId: input.checkpointId,
        writerId: input.writerId,
        expectedHeadHash: null,
        now
      });
      return { state: appended.checkpoint.state, checkpointHash: appended.checkpoint.hash };
    },

    async load() {
      assertSafeMissionPath(options.root, options.missionId);
      const checkpoint = await checkpointStore.loadHead();
      if (checkpoint === null) return null;
      validatePersistedState(checkpoint.state);
      return checkpoint.state;
    },

    acquireLease,

    async renewLease(input) {
      if (!Number.isSafeInteger(input.ttlMs) || input.ttlMs < 1) {
        throw new RangeError("ttlMs must be a positive safe integer");
      }
      return await withLeaseLock(async () => {
        const now = input.now ?? new Date().toISOString();
        const current = await assertLease(input.leaseToken, now);
        const renewed: SupervisorLease = {
          ...current,
          heartbeatAt: now,
          expiresAt: new Date(Date.parse(now) + input.ttlMs).toISOString()
        };
        await writeLease(renewed);
        return renewed;
      });
    },

    async releaseLease(leaseToken) {
      await withLeaseLock(async () => {
        const current = await readLease();
        if (current !== null && current.token === leaseToken) {
          await rm(leasePath, { force: true });
        }
      });
    },

    async transitionWorkItem(request, input) {
      if (request.to === "verified") {
        throw new MissionSupervisorError(
          "authority_mutation",
          "verified state can only be produced by an exactly-once verifier settlement"
        );
      }
      return await writeAuthorizedState(input, (current) => transitionWorkItem(current, request));
    },

    async recordSettlement(settlement, input) {
      const now = input.now ?? settlement.settledAt;
      return await withLeaseLock(async () => {
        const lease = await assertLease(input.leaseToken, now);
        const currentCheckpoint = await checkpointStore.loadHead();
        if (currentCheckpoint === null || currentCheckpoint.hash !== input.expectedHeadHash) {
          throw new MissionSupervisorError(
            "authority_mutation",
            "settlement is not bound to the expected durable head"
          );
        }
        const current = structuredClone(currentCheckpoint.state);
        const duplicate = current.settlements.find(
          (entry) => entry.settlementId === settlement.settlementId || entry.runId === settlement.runId
        );
        if (duplicate !== undefined) {
          if (!isDeepStrictEqual(duplicate, settlement)) {
            throw new MissionSupervisorError(
              "settlement_conflict",
              "settlement id or run id was already recorded with different evidence"
            );
          }
          return { state: current, checkpointHash: currentCheckpoint.hash };
        }
        const item = current.workItems.find((candidate) => candidate.id === settlement.workItemId);
        const isFailedAttemptAccounting = item?.status === "running" && settlement.verifier.passed === false;
        if (item === undefined || (item.status !== "succeeded" && !isFailedAttemptAccounting)) {
          throw new MissionSupervisorError(
            "settlement_conflict",
            "settlement requires a running failed attempt or an unverified succeeded work item"
          );
        }
        if (settlement.verifier.passed && (
          current.budget.spentUsd + settlement.actualUsd > current.budget.maxUsd
          || current.budget.tokensUsed + settlement.tokens > current.budget.maxTokens
          || current.budget.runsUsed + 1 > current.budget.maxRuns
        )) {
          throw new MissionSupervisorError(
            "settlement_conflict",
            "verified settlement exceeds the remaining mission budget"
          );
        }
        let next: MissionSupervisorState = {
          ...current,
          updatedAt: settlement.settledAt,
          settlements: [...current.settlements, structuredClone(settlement)],
          budget: {
            ...current.budget,
            spentUsd: current.budget.spentUsd + settlement.actualUsd,
            runsUsed: current.budget.runsUsed + 1,
            tokensUsed: current.budget.tokensUsed + settlement.tokens
          }
        };
        validatePersistedState(next);
        if (settlement.verifier.passed) {
          next = transitionWorkItem(next, {
            workItemId: settlement.workItemId,
            to: "verified",
            actor: { id: settlement.verifier.verifierId, role: "verifier" },
            evidence: {
              hash: settlement.verifier.evidenceHash,
              source: settlement.verifier.source,
              observedAt: settlement.settledAt
            }
          });
        }
        const appended = await checkpointStore.append(next, {
          checkpointId: input.checkpointId,
          writerId: lease.holderId,
          expectedHeadHash: input.expectedHeadHash,
          now
        });
        return { state: appended.checkpoint.state, checkpointHash: appended.checkpoint.hash };
      });
    },

    async save(state, input) {
      state = structuredClone(state);
      const now = input.now ?? new Date().toISOString();
      return await withLeaseLock(async () => {
        const lease = await assertLease(input.leaseToken, now);
        const currentCheckpoint = await checkpointStore.loadHead();
        if (currentCheckpoint === null || currentCheckpoint.hash !== input.expectedHeadHash) {
          throw new MissionSupervisorError(
            "authority_mutation",
            "raw state save is not bound to the expected durable head"
          );
        }
        if (!isDeepStrictEqual(
          withoutUpdatedAt(currentCheckpoint.state),
          withoutUpdatedAt(state)
        )) {
          throw new MissionSupervisorError(
            "authority_mutation",
            "raw save cannot mutate mission authority, accounting, or outcome state"
          );
        }
        validatePersistedState(state);
        const appended = await checkpointStore.append(state, {
          checkpointId: input.checkpointId,
          writerId: lease.holderId,
          expectedHeadHash: input.expectedHeadHash,
          now
        });
        return { state: appended.checkpoint.state, checkpointHash: appended.checkpoint.hash };
      });
    }
  };
}
