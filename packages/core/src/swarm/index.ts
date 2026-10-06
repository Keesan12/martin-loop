import { createHash } from "node:crypto";

import {
  normalizeSwarmPathPattern,
  swarmPathPatternContains,
  validateSwarmDeterministicDemoReceiptEvidence,
  validateSwarmRunRecord
} from "@martin/contracts";
import type {
  SwarmCleanupRecord,
  ReceiptIntegritySummary,
  SwarmDeterministicDemoReceiptEvidence,
  SwarmEvent,
  SwarmGlobalVerification,
  SwarmOutcome,
  SwarmRunRecord
} from "@martin/contracts";
import {
  verifyPersistedSwarmCandidateArtifact,
  type PersistedSwarmCandidateArtifact
} from "./candidates.js";
import {
  integrateSwarmCandidates,
  type SwarmIntegrationEvidenceStore,
  type SwarmIntegrationResult
} from "./integration.js";
import {
  verifyIntegratedSwarmResult,
  type SwarmGlobalVerificationEvidenceStore,
  type SwarmVerifierExecutor
} from "./verification.js";
import {
  SwarmWorkspaceCreationError,
  type SwarmWorkspaceManager,
  type SwarmWorkspaceRuntimeHandle
} from "./workspaces.js";
import { validateSwarmTaskGraph } from "./scheduler.js";

export {
  createParentDependencyWaiverRegistry,
  createSwarmBudgetLedger,
  extendSwarmBudgetLease,
  issueParentDependencyWaiver,
  releaseSwarmBudgetLease,
  reserveSwarmBudgetLease,
  selectNextSwarmBatch,
  settleSwarmBudgetLease,
  tasksHaveScopeCollision,
  validateSwarmTaskGraph
} from "./scheduler.js";
export type {
  DependencyWaiverIssuanceResult,
  IssuedDependencyWaiverCapability,
  ParentDependencyWaiverRegistry,
  SwarmBatchResult,
  SwarmBudgetProtectedUsage,
  SwarmBudgetTransitionResult,
  SwarmGraphValidationResult,
  SwarmSchedulerError
} from "./scheduler.js";

export type ParentSwarmInvariantState = "passed" | "failed" | "unknown";

interface ParentSwarmOutcomeEvidence {
  record: ParentSwarmInvariantState;
  parentState: ParentSwarmInvariantState;
  requiredTasks: ParentSwarmInvariantState;
  admittedScope: ParentSwarmInvariantState;
  integration: ParentSwarmInvariantState;
  globalVerifier: ParentSwarmInvariantState;
  receiptBinding: ParentSwarmInvariantState;
  budget: ParentSwarmInvariantState;
  cleanup: ParentSwarmInvariantState;
  blockingFailures: "none" | "present" | "unknown";
}

export interface ParentSwarmOutcomeDecision {
  outcome: SwarmOutcome;
  blockingInvariants: string[];
  event?: SwarmEvent;
}

export interface ParentSwarmOutcomeAssessment {
  disposition: "ready" | "stopped" | "needs_review";
  eligibleForParentVerification: boolean;
  blockingInvariants: string[];
}

function assessSwarmOutcomeEvidence(
  evidence: ParentSwarmOutcomeEvidence
): ParentSwarmOutcomeAssessment {
  const invariantKeys = [
    "record",
    "parentState",
    "requiredTasks",
    "admittedScope",
    "integration",
    "globalVerifier",
    "receiptBinding",
    "budget",
    "cleanup"
  ] as const;
  const blockingInvariants: string[] = invariantKeys.filter((key) => evidence[key] !== "passed");
  if (evidence.blockingFailures !== "none") {
    blockingInvariants.push("blockingFailures");
  }
  if (blockingInvariants.length === 0) {
    return {
      disposition: "ready",
      eligibleForParentVerification: true,
      blockingInvariants: []
    };
  }
  const hasKnownFailure = invariantKeys.some((key) => evidence[key] === "failed")
    || evidence.blockingFailures === "present";
  return {
    disposition: hasKnownFailure ? "stopped" : "needs_review",
    eligibleForParentVerification: false,
    blockingInvariants
  };
}

function finalizeParentSwarmOutcome(input: {
  swarmId: string;
  parentPolicyVersion: string;
  evaluatedAt: string;
  evidence: ParentSwarmOutcomeEvidence;
}): ParentSwarmOutcomeDecision {
  const assessment = assessSwarmOutcomeEvidence(input.evidence);
  if (!assessment.eligibleForParentVerification) {
    return {
      outcome: {
        state: assessment.disposition === "stopped" ? "stopped" : "needs_review",
        reason: assessment.disposition === "stopped"
          ? "One or more parent swarm verification invariants failed."
          : "Parent swarm verification evidence is incomplete or unknown."
      },
      blockingInvariants: assessment.blockingInvariants
    };
  }

  return {
    outcome: {
      state: "verified",
      reason: "All parent swarm verification invariants passed.",
      verifiedAt: input.evaluatedAt
    },
    blockingInvariants: [],
    event: {
      type: "SWARM_VERIFIED",
      swarmId: input.swarmId,
      timestamp: input.evaluatedAt,
      parentPolicyVersion: input.parentPolicyVersion,
      payload: {}
    }
  };
}

export interface DeterministicDemoVerifierExecutionFacts {
  verifierId: string;
  swarmId: string;
  workspaceId: string;
  parentPolicyVersion: string;
  commands: string[];
  launched: boolean;
  completed: boolean;
  crashed: boolean;
  timedOut: boolean;
  exitCode: number | null;
  evaluatedAt: string;
}

export interface CompleteDeterministicDemoSwarmRunInput {
  record: SwarmRunRecord;
  verifier: DeterministicDemoVerifierExecutionFacts;
  receiptEvidence: SwarmDeterministicDemoReceiptEvidence[];
}

export interface CompleteDeterministicDemoSwarmRunResult extends ParentSwarmOutcomeDecision {
  record: SwarmRunRecord;
  receiptEvidence: SwarmDeterministicDemoReceiptEvidence[];
}

export interface ParentSwarmPipelineEvidenceStore
  extends SwarmIntegrationEvidenceStore, SwarmGlobalVerificationEvidenceStore {
  loadPersistedChildCompletion(childRunId: string): Promise<PersistedSwarmChildCompletionEvidence | undefined>;
  persistWorkspaceFailureEvidence(evidence: SwarmPipelineWorkspaceFailureEvidence): Promise<void>;
  persistCleanupEvidence(cleanup: SwarmCleanupRecord): Promise<void>;
}

export interface SwarmPipelineWorkspaceFailureEvidence {
  readonly failureId: string;
  readonly swarmId: string;
  readonly workspaceId: string;
  readonly workspaceKind: "integration" | "verifier";
  readonly phase: "integration" | "verification";
  readonly errorCode: string;
  readonly recordedAt: string;
}

export interface PersistedSwarmChildCompletionEvidence {
  readonly swarmId: string;
  readonly childRunId: string;
  readonly agentId: string;
  readonly attemptId: string;
  readonly taskIds: readonly string[];
  readonly workspaceId?: string;
  readonly processCloseState: "closed";
  readonly leaseState: "settled" | "overspent" | "released";
  readonly receipt: {
    readonly receiptId: string;
    readonly swarmId: string;
    readonly childRunId: string;
    readonly agentId: string;
    readonly attemptId: string;
    readonly taskIds: readonly string[];
    readonly integrity: ReceiptIntegritySummary;
    readonly bindingSha256: string;
  };
  readonly evidencePersisted: true;
  readonly workspaceCleanupState: "completed" | "not_required";
  readonly cleanup?: SwarmCleanupRecord;
}

export interface RunParentSwarmPipelineInput {
  readonly record: SwarmRunRecord;
  readonly candidateIds: readonly string[];
  readonly workspaceManager: SwarmWorkspaceManager;
  readonly evidenceStore: ParentSwarmPipelineEvidenceStore;
  readonly integrationWorkspaceId: string;
  readonly verifierWorkspaceId: string;
  readonly verifierExecutor: SwarmVerifierExecutor;
  readonly signal: AbortSignal;
  readonly now?: () => string;
  readonly createId?: (prefix: string) => string;
}

export interface RunParentSwarmPipelineResult {
  readonly record: SwarmRunRecord;
  readonly outcome: SwarmOutcome;
  readonly disposition: ParentSwarmOutcomeAssessment["disposition"];
  readonly blockingInvariants: readonly string[];
  readonly integration: {
    readonly completed: boolean;
    readonly finalTreeHash: string;
    readonly admittedCandidateIds: readonly string[];
  };
  readonly verification?: SwarmGlobalVerification;
  readonly cleanup: readonly SwarmCleanupRecord[];
}

const authorizedParentPipelineResults = new WeakSet<object>();

function freezeParentPipelineResult<T>(value: T, seen = new WeakSet<object>()): T {
  if (value === null || typeof value !== "object") return value;
  const object = value as object;
  if (seen.has(object)) return value;
  seen.add(object);
  for (const key of Reflect.ownKeys(object)) {
    const descriptor = Object.getOwnPropertyDescriptor(object, key);
    if (descriptor && "value" in descriptor) {
      freezeParentPipelineResult(descriptor.value, seen);
    }
  }
  return Object.freeze(value);
}

/** Internal authority check for operational persistence; not re-exported from Core root. */
export function isAuthorizedParentSwarmPipelineResult(
  result: RunParentSwarmPipelineResult
): boolean {
  return authorizedParentPipelineResults.has(result as object);
}

/**
 * The only public live Phase 3 completion boundary. It derives integration,
 * verifier, receipt, budget, conflict, and cleanup truth from concrete runtime
 * evidence; callers cannot supply invariant booleans or a desired outcome.
 */
export async function runParentSwarmPipeline(
  input: RunParentSwarmPipelineInput
): Promise<RunParentSwarmPipelineResult> {
  const result = freezeParentPipelineResult(await runParentSwarmPipelineInternal(input));
  authorizedParentPipelineResults.add(result as object);
  return result;
}

async function runParentSwarmPipelineInternal(
  input: RunParentSwarmPipelineInput
): Promise<RunParentSwarmPipelineResult> {
  const now = input.now ?? (() => new Date().toISOString());
  const createId = input.createId ?? ((prefix: string) => `${prefix}-${Math.random().toString(36).slice(2, 10)}`);
  const record = cloneSwarmRunRecord(input.record);
  if (!validateSwarmRunRecord(record).ok || !validateSwarmTaskGraph(record.tasks).ok || record.outcome.state !== "running") {
    return failedPipelineResult(record, "record", now());
  }
  if (record.events.some((event) => event.type === "SWARM_VERIFIED")) {
    return failedPipelineResult(record, "parentState", now());
  }
  if (input.signal.aborted) return failedPipelineResult(record, "parentState", now());

  let integration: SwarmIntegrationResult;
  let activeIntegrationWorkspace: SwarmWorkspaceRuntimeHandle | undefined;
  try {
    integration = await integrateSwarmCandidates({
      swarmRecord: record,
      workspaceManager: input.workspaceManager,
      integrationWorkspaceId: input.integrationWorkspaceId,
      candidates: input.candidateIds.map((candidateId) => ({ candidateId })),
      evidenceStore: input.evidenceStore,
      conflictPolicy: "stop",
      now,
      createId,
      onWorkspaceCreated: (workspace) => { activeIntegrationWorkspace = workspace; }
    });
  } catch (error) {
    const cleanup = await retainOrCleanupExceptionalWorkspace(
      input,
      activeIntegrationWorkspace,
      error,
      "integration",
      now,
      createId,
      true
    );
    return failedPipelineResult(record, "integration", now(), cleanup ? [cleanup] : []);
  }

  const recordWithIntegration: SwarmRunRecord = {
    ...record,
    events: [...record.events, ...integration.events.map(cloneEvent)],
    conflicts: [...record.conflicts, ...integration.conflicts.map((conflict) => ({ ...conflict, taskIds: [...conflict.taskIds], paths: [...conflict.paths] }))],
    updatedAt: now()
  };

  let verificationResult: Awaited<ReturnType<typeof verifyIntegratedSwarmResult>> | undefined;
  const cleanup: SwarmCleanupRecord[] = [];
  let cleanupPersisted = true;
  if (integration.completed && integration.cleanupAuthorized && !input.signal.aborted) {
    try {
      verificationResult = await verifyIntegratedSwarmResult({
        swarmRecord: recordWithIntegration,
        workspaceManager: input.workspaceManager,
        verifierWorkspaceId: input.verifierWorkspaceId,
        admittedCandidateIds: integration.admittedCandidateIds,
        integratedTreeHash: integration.finalTreeHash,
        evidenceStore: input.evidenceStore,
        executor: input.verifierExecutor,
        signal: input.signal,
        now,
        createVerificationId: () => createId("global-verification")
      });
    } catch (error) {
      if (error instanceof SwarmWorkspaceCreationError) {
        cleanup.push(error.cleanup);
        try {
          await input.evidenceStore.persistCleanupEvidence(error.cleanup);
        } catch {
          cleanupPersisted = false;
        }
      }
    }
  }

  if (verificationResult?.cleanupAuthorized) {
    const result = await removePipelineWorkspace(
      input,
      verificationResult.workspace,
      now,
      createId,
      verificationResult.processCloseState === "closed"
    );
    cleanup.push(result.cleanup);
    cleanupPersisted &&= result.persisted;
  }
  if (integration.cleanupAuthorized) {
    const result = await removePipelineWorkspace(input, integration.workspace, now, createId, true);
    cleanup.push(result.cleanup);
    cleanupPersisted &&= result.persisted;
  }

  const artifacts: PersistedSwarmCandidateArtifact[] = [];
  for (const candidateId of integration.admittedCandidateIds) {
    const artifact = await input.evidenceStore.loadPersistedCandidate(candidateId);
    if (artifact) artifacts.push(artifact);
  }
  const receiptPassed = artifacts.length === integration.admittedCandidateIds.length
    && artifacts.every((artifact) => verifyPersistedSwarmCandidateArtifact(artifact) && artifact.receiptIntegrity.state === "verified");
  const childCompletionPassed = await persistedChildCompletionPassed(record, artifacts, input.evidenceStore);
  const candidateCoveragePassed = hasExactRequiredWriteTaskCoverage(record, artifacts);
  const integrationPassed = integration.completed
    && integration.cleanupAuthorized
    && integration.conflicts.length === 0
    && integration.admittedCandidateIds.length === input.candidateIds.length
    && candidateCoveragePassed
    && integration.decisions.every((decision) => decision.state === "admitted");
  const verifierPassed = verificationResult?.passed === true
    && verificationResult.evidence.commandState === "passed"
    && verificationResult.evidence.mutationState === "clean"
    && verificationResult.reconstructedTreeHash === integration.finalTreeHash;
  const cleanupPassed = childCompletionPassed
    && cleanupPersisted
    && cleanup.length === (verificationResult?.cleanupAuthorized ? 2 : 1)
    && cleanup.every((entry) => entry.state === "completed");
  const hasPipelineBlocker = recordWithIntegration.conflicts.some((conflict) => conflict.state === "blocking")
    || recordWithIntegration.events.some((event) => (
      event.type === "SWARM_STOPPED"
      || event.type === "SWARM_NEEDS_REVIEW"
      || event.type === "CHILD_NEEDS_REVIEW"
    ))
    || recordWithIntegration.agents.some((agent) => agent.status === "needs_review")
    || recordWithIntegration.tasks.some((task) => task.status === "needs_review")
    || integration.conflicts.length > 0;
  const evidence: ParentSwarmOutcomeEvidence = {
    record: "passed",
    parentState: input.signal.aborted ? "failed" : "passed",
    requiredTasks: record.tasks.filter((task) => task.required).every((task) => task.status === "accepted") ? "passed" : "failed",
    admittedScope: integrationPassed ? "passed" : "failed",
    integration: integrationPassed ? "passed" : "failed",
    globalVerifier: verifierPassed ? "passed" : verificationResult ? "failed" : "unknown",
    receiptBinding: receiptPassed ? "passed" : "failed",
    budget: evaluateBudget(record),
    cleanup: cleanupPassed && !input.signal.aborted ? "passed" : "failed",
    blockingFailures: hasPipelineBlocker ? "present" : "none"
  };
  const evaluatedAt = now();
  if (input.signal.aborted) evidence.parentState = "failed";
  const decision = finalizeParentSwarmOutcome({
    swarmId: record.swarmId,
    parentPolicyVersion: record.parentContract.policyVersion,
    evaluatedAt,
    evidence
  });
  const canonicalOutcome = verificationResult && !verifierPassed
    ? { state: "needs_review" as const, reason: decision.outcome.reason }
    : decision.outcome;
  const canonicalDecisionEvent = verificationResult && !verifierPassed
    ? {
        type: "SWARM_NEEDS_REVIEW" as const,
        swarmId: record.swarmId,
        timestamp: evaluatedAt,
        parentPolicyVersion: record.parentContract.policyVersion,
        payload: { reason: canonicalOutcome.reason }
      }
    : decision.event;
  const verifierEvent: SwarmEvent | undefined = verificationResult
    ? {
        type: verifierPassed ? "GLOBAL_VERIFIER_PASSED" : "GLOBAL_VERIFIER_FAILED",
        swarmId: record.swarmId,
        timestamp: verificationResult.evidence.completedAt ?? evaluatedAt,
        parentPolicyVersion: record.parentContract.policyVersion,
        payload: {
          verificationId: verificationResult.evidence.verificationId,
          integratedTreeHash: integration.finalTreeHash
        }
      }
    : undefined;
  const finalRecord = cloneSwarmRunRecord({
    ...recordWithIntegration,
    verification: verificationResult ? [...record.verification, {
      verifierId: verificationResult.evidence.verificationId,
      scope: "parent_global",
      state: verifierPassed ? "passed" : "failed",
      steps: record.parentContract.globalVerifierStack.map((step) => ({ ...step })),
      boundAt: verificationResult.evidence.completedAt
    }] : record.verification,
    outcome: { ...canonicalOutcome },
    events: [
      ...recordWithIntegration.events,
      ...(verifierEvent ? [verifierEvent] : []),
      ...(canonicalDecisionEvent ? [canonicalDecisionEvent] : [])
    ],
    updatedAt: evaluatedAt
  });
  const assessment = assessSwarmOutcomeEvidence(evidence);
  return Object.freeze({
    record: finalRecord,
    outcome: { ...canonicalOutcome },
    disposition: verificationResult && !verifierPassed ? "needs_review" : assessment.disposition,
    blockingInvariants: Object.freeze([...decision.blockingInvariants]),
    integration: Object.freeze({
      completed: integration.completed,
      finalTreeHash: integration.finalTreeHash,
      admittedCandidateIds: Object.freeze([...integration.admittedCandidateIds])
    }),
    ...(verificationResult ? { verification: verificationResult.evidence } : {}),
    cleanup: Object.freeze(cleanup)
  });
}

function hasExactRequiredWriteTaskCoverage(
  record: SwarmRunRecord,
  artifacts: readonly PersistedSwarmCandidateArtifact[]
): boolean {
  const requiredWriteTaskIds = record.tasks
    .filter((task) => task.required && task.mutationMode === "write" && task.status === "accepted")
    .map((task) => task.taskId);
  const counts = new Map<string, number>();
  for (const artifact of artifacts) {
    if (artifact.candidate.taskIds.length !== 1) return false;
    const taskId = artifact.candidate.taskIds[0]!;
    const task = record.tasks.find((candidate) => candidate.taskId === taskId);
    const agent = record.agents.find((candidate) => candidate.agentId === artifact.candidate.agentId);
    if (
      !task
      || !agent
      || task.mutationMode !== "write"
      || task.status !== "accepted"
      || task.assignedAgentId !== artifact.candidate.agentId
      || agent.childRunId !== artifact.candidate.childRunId
      || !agent.contract.taskIds.includes(taskId)
    ) return false;
    counts.set(taskId, (counts.get(taskId) ?? 0) + 1);
  }
  return requiredWriteTaskIds.every((taskId) => counts.get(taskId) === 1)
    && [...counts.values()].every((count) => count === 1);
}

async function persistedChildCompletionPassed(
  record: SwarmRunRecord,
  artifacts: readonly PersistedSwarmCandidateArtifact[],
  store: ParentSwarmPipelineEvidenceStore
): Promise<boolean> {
  const artifactByTaskId = new Map<string, PersistedSwarmCandidateArtifact>();
  for (const artifact of artifacts) {
    if (artifact.candidate.taskIds.length !== 1) return false;
    const taskId = artifact.candidate.taskIds[0]!;
    if (artifactByTaskId.has(taskId)) return false;
    artifactByTaskId.set(taskId, artifact);
  }
  const taskIds = new Set(record.tasks.filter((task) => task.required).map((task) => task.taskId));
  for (const taskId of artifactByTaskId.keys()) taskIds.add(taskId);
  for (const taskId of taskIds) {
    const task = record.tasks.find((candidate) => candidate.taskId === taskId);
    const agent = task ? record.agents.find((candidate) => candidate.agentId === task.assignedAgentId) : undefined;
    if (!task || !agent?.childRunId) return false;
    const completion = await store.loadPersistedChildCompletion(agent.childRunId);
    if (
      !completion
      || completion.swarmId !== record.swarmId
      || completion.childRunId !== agent.childRunId
      || completion.agentId !== agent.agentId
      || !completion.taskIds.includes(taskId)
      || !sameStringSet(completion.taskIds, agent.contract.taskIds)
      || completion.evidencePersisted !== true
      || completion.processCloseState !== "closed"
      || (completion.leaseState !== "settled" && completion.leaseState !== "released")
      || !validChildReceiptBinding(completion)
    ) return false;
    const artifact = artifactByTaskId.get(taskId);
    if (task.mutationMode === "write") {
      if (
        !artifact
        || completion.workspaceCleanupState !== "completed"
        || completion.workspaceId !== artifact.candidate.workspaceId
        || !completion.cleanup
        || completion.cleanup.swarmId !== record.swarmId
        || completion.cleanup.workspaceId !== artifact.candidate.workspaceId
        || completion.cleanup.workspaceKind !== "child"
        || completion.cleanup.evidencePersisted !== true
        || completion.cleanup.state !== "completed"
        || completion.cleanup.removalState !== "removed"
      ) return false;
    } else if (completion.workspaceCleanupState === "completed") {
      if (
        !completion.cleanup
        || !completion.workspaceId
        || completion.cleanup.swarmId !== record.swarmId
        || completion.cleanup.workspaceId !== completion.workspaceId
        || completion.cleanup.workspaceKind !== "child"
        || completion.cleanup.evidencePersisted !== true
        || completion.cleanup.state !== "completed"
        || completion.cleanup.removalState !== "removed"
      ) return false;
    } else if (completion.workspaceId !== undefined || completion.cleanup !== undefined) return false;
  }
  return true;
}

function validChildReceiptBinding(completion: PersistedSwarmChildCompletionEvidence): boolean {
  const receipt = completion.receipt;
  if (
    receipt.receiptId.trim().length === 0
    || receipt.swarmId !== completion.swarmId
    || receipt.childRunId !== completion.childRunId
    || receipt.agentId !== completion.agentId
    || receipt.attemptId.trim().length === 0
    || receipt.attemptId !== completion.attemptId
    || !sameStringSet(receipt.taskIds, completion.taskIds)
    || receipt.integrity.state !== "verified"
    || !receipt.integrity.keyId
    || !isSha256(receipt.integrity.loopRecordSha256)
    || !isSha256(receipt.integrity.ledgerSha256)
    || !isSha256(receipt.integrity.ledgerHeadHash)
  ) return false;
  const canonical = JSON.stringify({
    receiptId: receipt.receiptId,
    swarmId: receipt.swarmId,
    childRunId: receipt.childRunId,
    agentId: receipt.agentId,
    attemptId: receipt.attemptId,
    taskIds: [...receipt.taskIds].sort(),
    integrity: {
      state: receipt.integrity.state,
      keyId: receipt.integrity.keyId,
      loopRecordSha256: receipt.integrity.loopRecordSha256,
      ledgerSha256: receipt.integrity.ledgerSha256,
      ledgerHeadHash: receipt.integrity.ledgerHeadHash
    }
  });
  return createHash("sha256").update(canonical, "utf8").digest("hex") === receipt.bindingSha256;
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/u.test(value);
}

async function retainOrCleanupExceptionalWorkspace(
  input: RunParentSwarmPipelineInput,
  workspace: SwarmWorkspaceRuntimeHandle | undefined,
  error: unknown,
  phase: SwarmPipelineWorkspaceFailureEvidence["phase"],
  now: () => string,
  createId: (prefix: string) => string,
  processTreeClosed: boolean
): Promise<SwarmCleanupRecord | undefined> {
  if (!workspace) {
    if (error instanceof SwarmWorkspaceCreationError) {
      await input.evidenceStore.persistCleanupEvidence(error.cleanup).catch(() => undefined);
      return error.cleanup;
    }
    return undefined;
  }
  const errorCode = safePipelineErrorCode(error);
  try {
    await input.evidenceStore.persistWorkspaceFailureEvidence({
      failureId: createId("workspace-failure"),
      swarmId: input.record.swarmId,
      workspaceId: workspace.record.workspaceId,
      workspaceKind: workspace.record.kind === "verifier" ? "verifier" : "integration",
      phase,
      errorCode,
      recordedAt: now()
    });
  } catch {
    return {
      schemaVersion: "martin.swarm.v1",
      cleanupId: createId("pipeline-cleanup-pending"),
      swarmId: input.record.swarmId,
      workspaceId: workspace.record.workspaceId,
      workspaceKind: workspace.record.kind,
      evidencePersisted: false,
      processCloseState: processTreeClosed ? "closed" : "failed",
      removalState: "failed",
      state: "cleanup_pending",
      attemptedAt: now(),
      errorCode: "WORKSPACE_FAILURE_EVIDENCE_NOT_PERSISTED"
    };
  }
  const result = await removePipelineWorkspace(input, workspace, now, createId, processTreeClosed);
  return result.cleanup;
}

function safePipelineErrorCode(error: unknown): string {
  if (error instanceof Error && "code" in error) {
    const code = String((error as Error & { code?: unknown }).code ?? "PIPELINE_WORKSPACE_FAILURE");
    return code.slice(0, 96);
  }
  return "PIPELINE_WORKSPACE_FAILURE";
}

async function removePipelineWorkspace(
  input: RunParentSwarmPipelineInput,
  workspace: import("./workspaces.js").SwarmWorkspaceRuntimeHandle,
  now: () => string,
  createId: (prefix: string) => string,
  processTreeClosed: boolean
): Promise<{ cleanup: SwarmCleanupRecord; persisted: boolean }> {
  let cleanup: SwarmCleanupRecord;
  try {
    cleanup = await input.workspaceManager.removeWorkspace(workspace, {
      evidencePersisted: true,
      processTreeClosed,
      force: true
    });
  } catch (error) {
    const code = typeof error === "object" && error !== null && "code" in error
      ? String((error as { code?: unknown }).code ?? "WORKSPACE_REMOVE_FAILED")
      : "WORKSPACE_REMOVE_FAILED";
    cleanup = {
      schemaVersion: "martin.swarm.v1",
      cleanupId: createId("pipeline-cleanup"),
      swarmId: input.record.swarmId,
      workspaceId: workspace.record.workspaceId,
      workspaceKind: workspace.record.kind,
      evidencePersisted: true,
      processCloseState: processTreeClosed ? "closed" : "failed",
      removalState: "failed",
      state: code === "EPERM" || code === "EBUSY" ? "cleanup_pending" : "failed",
      attemptedAt: now(),
      errorCode: code
    };
  }
  try {
    await input.evidenceStore.persistCleanupEvidence(cleanup);
    return { cleanup, persisted: true };
  } catch {
    return { cleanup, persisted: false };
  }
}

function failedPipelineResult(
  record: SwarmRunRecord,
  invariant: keyof Omit<ParentSwarmOutcomeEvidence, "blockingFailures">,
  evaluatedAt: string,
  cleanup: readonly SwarmCleanupRecord[] = []
): RunParentSwarmPipelineResult {
  const evidence = failedEvidence(invariant);
  const decision = finalizeParentSwarmOutcome({
    swarmId: record.swarmId,
    parentPolicyVersion: record.parentContract.policyVersion,
    evaluatedAt,
    evidence
  });
  const assessment = assessSwarmOutcomeEvidence(evidence);
  return Object.freeze({
    record: cloneSwarmRunRecord({ ...record, outcome: { ...decision.outcome }, updatedAt: evaluatedAt }),
    outcome: { ...decision.outcome },
    disposition: assessment.disposition,
    blockingInvariants: Object.freeze([...decision.blockingInvariants]),
    integration: Object.freeze({ completed: false, finalTreeHash: "", admittedCandidateIds: Object.freeze([]) }),
    cleanup: Object.freeze([...cleanup])
  });
}

export function completeDeterministicDemoSwarmRun(
  input: CompleteDeterministicDemoSwarmRunInput
): CompleteDeterministicDemoSwarmRunResult {
  const recordSnapshot = cloneSwarmRunRecord(input.record);
  const verifierSnapshot: DeterministicDemoVerifierExecutionFacts = {
    ...input.verifier,
    commands: [...input.verifier.commands]
  };
  const receiptEvidence = input.receiptEvidence.map((evidence) => ({
    ...evidence,
    taskIds: [...evidence.taskIds]
  }));
  const snapshot: CompleteDeterministicDemoSwarmRunInput = {
    record: recordSnapshot,
    verifier: verifierSnapshot,
    receiptEvidence
  };
  const evidence = deriveParentOutcomeEvidence(snapshot, receiptEvidence);
  const decision = finalizeParentSwarmOutcome({
    swarmId: recordSnapshot.swarmId,
    parentPolicyVersion: recordSnapshot.parentContract.policyVersion,
    evaluatedAt: verifierSnapshot.evaluatedAt,
    evidence
  });
  const record: SwarmRunRecord = {
    ...recordSnapshot,
    outcome: { ...decision.outcome },
    events: decision.event
      ? [...recordSnapshot.events.map(cloneEvent), cloneEvent(decision.event)]
      : recordSnapshot.events.map(cloneEvent),
    updatedAt: verifierSnapshot.evaluatedAt
  };
  return {
    ...decision,
    record,
    receiptEvidence
  };
}

function deriveParentOutcomeEvidence(
  input: CompleteDeterministicDemoSwarmRunInput,
  receiptEvidence: SwarmDeterministicDemoReceiptEvidence[]
): ParentSwarmOutcomeEvidence {
  const record = input.record;
  const recordValid = validateSwarmRunRecord(record).ok
    && validateSwarmTaskGraph(record.tasks).ok
    && hasConsistentRecordBindings(record)
    && hasCanonicalDemoRoster(record);
  if (!recordValid) {
    return failedEvidence("record");
  }
  if (record.outcome.state !== "running") {
    return failedEvidence("parentState");
  }

  return {
    record: "passed",
    parentState: "passed",
    requiredTasks: record.tasks.filter((task) => task.required).every((task) => task.status === "accepted")
      ? "passed"
      : "failed",
    admittedScope: evaluateAdmittedScope(record),
    integration: hasBoundEvent(record, "INTEGRATION_COMPLETED") ? "passed" : "unknown",
    globalVerifier: evaluateGlobalVerifier(record, input.verifier),
    receiptBinding: evaluateReceiptBinding(record, receiptEvidence),
    budget: evaluateBudget(record),
    cleanup: "passed",
    blockingFailures: hasBlockingFailure(record) ? "present" : "none"
  };
}

function failedEvidence(key: keyof Omit<ParentSwarmOutcomeEvidence, "blockingFailures">): ParentSwarmOutcomeEvidence {
  const evidence: ParentSwarmOutcomeEvidence = {
    record: "passed",
    parentState: "passed",
    requiredTasks: "passed",
    admittedScope: "passed",
    integration: "passed",
    globalVerifier: "passed",
    receiptBinding: "passed",
    budget: "passed",
    cleanup: "passed",
    blockingFailures: "none"
  };
  evidence[key] = "failed";
  return evidence;
}

function hasConsistentRecordBindings(record: SwarmRunRecord): boolean {
  if (record.budgetLedger.capUsd !== record.parentContract.budget.maxUsd) return false;
  if (record.budgetLedger.capTokens !== record.parentContract.budget.maxTokens) return false;
  if (record.events.some((event) => (
    event.swarmId !== record.swarmId
    || event.parentPolicyVersion !== record.parentContract.policyVersion
  ))) return false;

  const tasks = new Map(record.tasks.map((task) => [task.taskId, task]));
  const agents = new Map(record.agents.map((agent) => [agent.agentId, agent]));
  for (const agent of record.agents) {
    if (agent.contract.agentId !== agent.agentId) return false;
    if (agent.contract.taskIds.some((taskId) => !tasks.has(taskId))) return false;
  }
  return record.tasks.every((task) => {
    if (!task.assignedAgentId) return task.status !== "accepted";
    const agent = agents.get(task.assignedAgentId);
    return agent !== undefined && agent.contract.taskIds.includes(task.taskId);
  });
}

function evaluateAdmittedScope(record: SwarmRunRecord): ParentSwarmInvariantState {
  const counts = new Map<string, number>();
  for (const admitted of record.events.filter((event) => event.type === "CHILD_PATCH_ADMITTED")) {
    const task = admitted.taskId
      ? record.tasks.find((candidate) => candidate.taskId === admitted.taskId)
      : undefined;
    if (!task || task.status !== "accepted" || task.mutationMode !== "write" || !task.assignedAgentId) {
      return "failed";
    }
    const agent = record.agents.find((candidate) => candidate.agentId === task.assignedAgentId);
    if (
      !agent
      || admitted.agentId !== task.assignedAgentId
      || admitted.childRunId !== agent.childRunId
      || !hasBoundEventIdentity(record, admitted)
      || !isAuthorizedTaskScope(record, agent.agentId, task.writeScope)
    ) return "failed";
    const paths = admitted.payload.paths;
    if (
      !Array.isArray(paths)
      || paths.length === 0
      || paths.some((path) => !isContainedAdmittedPath(record, agent.agentId, path, task.writeScope))
    ) {
      return "failed";
    }
    counts.set(task.taskId, (counts.get(task.taskId) ?? 0) + 1);
  }

  for (const task of record.tasks.filter((candidate) => candidate.status === "accepted" && candidate.mutationMode === "write")) {
    const count = counts.get(task.taskId) ?? 0;
    if (count === 0) return "unknown";
    if (count !== 1) return "failed";
  }
  return "passed";
}

function evaluateGlobalVerifier(
  record: SwarmRunRecord,
  verifier: DeterministicDemoVerifierExecutionFacts
): ParentSwarmInvariantState {
  if (
    !hasText(record.workspaceId)
    || !hasText(record.projectId)
    || !hasText(verifier.verifierId)
    || !hasText(verifier.swarmId)
    || !hasText(verifier.workspaceId)
    || !hasText(verifier.parentPolicyVersion)
    || !isCanonicalIsoDate(verifier.evaluatedAt)
  ) return "failed";
  const expectedCommands = record.parentContract.globalVerifierStack.map((step) => step.command);
  const parentVerifierRecords = record.verification.filter((candidate) => candidate.scope === "parent_global");
  const boundRecord = parentVerifierRecords.length === 1
    && parentVerifierRecords[0]?.verifierId === verifier.verifierId
    ? parentVerifierRecords[0]
    : undefined;
  const passedEvent = record.events.find((event) => (
    event.type === "GLOBAL_VERIFIER_PASSED"
    && event.payload.verifierId === verifier.verifierId
    && event.timestamp === verifier.evaluatedAt
    && hasBoundEventIdentity(record, event)
  ));
  const identityMatches = verifier.swarmId === record.swarmId
    && verifier.workspaceId === record.workspaceId
    && verifier.parentPolicyVersion === record.parentContract.policyVersion
    && sameStrings(verifier.commands, expectedCommands)
    && boundRecord !== undefined
    && sameStrings(boundRecord.steps.map((step) => step.command), expectedCommands)
    && boundRecord.boundAt === verifier.evaluatedAt
    && passedEvent !== undefined;
  if (!identityMatches || boundRecord?.state === "failed") return "failed";
  if (verifier.crashed || verifier.timedOut || (verifier.completed && verifier.exitCode !== 0)) return "failed";
  const executionPassed = verifier.launched
    && verifier.completed
    && !verifier.crashed
    && !verifier.timedOut
    && verifier.exitCode === 0;
  return executionPassed && boundRecord.state === "passed" ? "passed" : "unknown";
}

function evaluateReceiptBinding(
  record: SwarmRunRecord,
  receiptEvidence: SwarmDeterministicDemoReceiptEvidence[]
): ParentSwarmInvariantState {
  if (record.agents.length !== 15 || receiptEvidence.length !== 15) return "failed";
  const expected = record.agents.map((agent) => ({
    swarmId: record.swarmId,
    agentId: agent.agentId,
    taskIds: [...agent.contract.taskIds],
    childRunId: agent.childRunId
  }));
  const seen = new Set<string>();
  let unknown = false;
  for (const evidence of receiptEvidence) {
    if (!validateSwarmDeterministicDemoReceiptEvidence(evidence).ok) return "failed";
    const key = `${evidence.swarmId}\u0000${evidence.agentId}\u0000${evidence.childRunId}`;
    if (seen.has(key)) return "failed";
    seen.add(key);
    const binding = expected.find((candidate) => (
      candidate.swarmId === evidence.swarmId
      && candidate.agentId === evidence.agentId
      && candidate.childRunId === evidence.childRunId
      && sameStringSet(candidate.taskIds, evidence.taskIds)
    ));
    if (!binding || evidence.referentialBinding === "failed") return "failed";
    if (evidence.referentialBinding === "unknown") unknown = true;
  }
  return unknown ? "unknown" : "passed";
}

function evaluateBudget(record: SwarmRunRecord): ParentSwarmInvariantState {
  const ledger = record.budgetLedger;
  if (!isValidTerminalBudgetLedger(record)) return "failed";
  if (
    ledger.leases.some((lease) => lease.status === "overspent")
    || ledger.settledUsd > ledger.capUsd
    || (ledger.capTokens !== undefined && ledger.settledTokens > ledger.capTokens)
  ) return "failed";
  if (ledger.leases.some((lease) => lease.status === "reserved")) return "unknown";
  return "passed";
}

function hasBlockingFailure(record: SwarmRunRecord): boolean {
  return record.conflicts.some((conflict) => conflict.state === "blocking")
    || record.agents.some((agent) => (
      agent.agentId === "agent-06"
        ? agent.status !== "stopped" || !hasCanonicalDemoRecovery(record)
        : agent.status !== "verified"
    ))
    || record.events.some((event) => (
      event.type === "GLOBAL_VERIFIER_FAILED"
      || event.type === "SWARM_STOPPED"
      || event.type === "SWARM_NEEDS_REVIEW"
    ));
}

function hasCanonicalDemoRecovery(record: SwarmRunRecord): boolean {
  const task = record.tasks.find((candidate) => candidate.taskId === "task-06");
  const agent06 = record.agents.find((agent) => agent.agentId === "agent-06");
  const agent10 = record.agents.find((agent) => agent.agentId === "agent-10");
  if (
    !task
    || !agent06?.childRunId
    || !agent10?.childRunId
    || task.status !== "accepted"
    || task.assignedAgentId !== "agent-10"
    || !agent06.contract.taskIds.includes("task-06")
    || !agent10.contract.taskIds.includes("task-06")
  ) return false;

  const recoveryTypes = [
    "CHILD_PATCH_REJECTED",
    "CHILD_STOPPED",
    "TASK_REASSIGNED",
    "CHILD_PATCH_ADMITTED"
  ] as const;
  if (recoveryTypes.some((type) => (
    record.events.filter((event) => event.type === type && event.taskId === "task-06").length !== 1
  ))) return false;

  const rejected = matchingEvents(record, "CHILD_PATCH_REJECTED", "task-06", "agent-06", agent06.childRunId)
    .filter((event) => event.payload.reason === "scope_creep");
  const stopped = matchingEvents(record, "CHILD_STOPPED", "task-06", "agent-06", agent06.childRunId)
    .filter((event) => event.payload.reason === "scope_creep");
  const reassigned = matchingEvents(record, "TASK_REASSIGNED", "task-06", "agent-10", agent10.childRunId)
    .filter((event) => event.payload.fromAgentId === "agent-06");
  const admitted = matchingEvents(record, "CHILD_PATCH_ADMITTED", "task-06", "agent-10", agent10.childRunId);
  const integrated = record.events.filter((event) => event.type === "INTEGRATION_COMPLETED" && hasBoundEventIdentity(record, event));
  const verified = record.events.filter((event) => event.type === "GLOBAL_VERIFIER_PASSED" && hasBoundEventIdentity(record, event));
  if (
    rejected.length !== 1
    || stopped.length !== 1
    || reassigned.length !== 1
    || admitted.length !== 1
    || integrated.length !== 1
    || verified.length !== 1
  ) return false;

  const chain = [rejected[0]!, stopped[0]!, reassigned[0]!, admitted[0]!, integrated[0]!, verified[0]!];
  const positions = chain.map((event) => record.events.indexOf(event));
  const timestamps = chain.map((event) => Date.parse(event.timestamp));
  return positions.every((position, index) => index === 0 || position > positions[index - 1]!)
    && timestamps.every((timestamp, index) => (
      Number.isFinite(timestamp)
      && (index === 0 || timestamp > timestamps[index - 1]!)
    ));
}

const DETERMINISTIC_DEMO_ROLES = [
  "Planner",
  "Data",
  "API",
  "Validation",
  "UI",
  "State",
  "Unit Tests",
  "Integration Tests",
  "Accessibility",
  "Error Handling",
  "Docs",
  "Scope Reviewer",
  "Test Reviewer",
  "Integrator",
  "Final Verifier"
] as const;

function hasCanonicalDemoRoster(record: SwarmRunRecord): boolean {
  if (record.agents.length !== DETERMINISTIC_DEMO_ROLES.length) return false;
  return DETERMINISTIC_DEMO_ROLES.every((role, index) => {
    const expectedId = `agent-${String(index + 1).padStart(2, "0")}`;
    const agent = record.agents[index];
    return agent?.agentId === expectedId && agent.role === role;
  });
}

function isAuthorizedTaskScope(record: SwarmRunRecord, agentId: string, writeScope: string[]): boolean {
  const agent = record.agents.find((candidate) => candidate.agentId === agentId);
  if (!agent || writeScope.length === 0) return false;
  return writeScope.every((path) => {
    const normalized = normalizeSwarmPathPattern(path);
    if (!normalized.ok) return false;
    const value = normalized.value;
    const allowedByParent = record.parentContract.scope.allowedPaths.some((allowed) => swarmPathPatternContains(allowed, value));
    const allowedByChild = agent.contract.scope.allowedPaths.some((allowed) => swarmPathPatternContains(allowed, value));
    return allowedByParent && allowedByChild;
  });
}

function isContainedAdmittedPath(
  record: SwarmRunRecord,
  agentId: string,
  path: unknown,
  writeScope: string[]
): boolean {
  if (typeof path !== "string") return false;
  const agent = record.agents.find((candidate) => candidate.agentId === agentId);
  if (!agent) return false;
  const normalized = normalizeSwarmPathPattern(path);
  if (!normalized.ok) return false;
  const value = normalized.value;
  if (value.split("/").some((segment) => segment === "*" || segment === "**")) return false;
  const denied = [...record.parentContract.scope.deniedPaths, ...agent.contract.scope.deniedPaths];
  return writeScope.some((scope) => swarmPathPatternContains(scope, value))
    && record.parentContract.scope.allowedPaths.some((allowed) => swarmPathPatternContains(allowed, value))
    && agent.contract.scope.allowedPaths.some((allowed) => swarmPathPatternContains(allowed, value))
    && denied.every((blocked) => !swarmPathPatternContains(blocked, value));
}

function hasBoundHistoricalReassignment(
  record: SwarmRunRecord,
  leaseId: string,
  taskId: string,
  priorAgentId: string
): boolean {
  const task = record.tasks.find((candidate) => candidate.taskId === taskId);
  const priorAgent = record.agents.find((candidate) => candidate.agentId === priorAgentId);
  const currentAgent = record.agents.find((candidate) => candidate.agentId === task?.assignedAgentId);
  if (
    !task
    || !priorAgent?.childRunId
    || !currentAgent?.childRunId
    || currentAgent.agentId === priorAgent.agentId
    || currentAgent.childRunId === priorAgent.childRunId
    || !priorAgent.contract.taskIds.includes(taskId)
    || !currentAgent.contract.taskIds.includes(taskId)
  ) return false;

  const priorStarted = matchingEvents(record, "CHILD_STARTED", taskId, priorAgentId, priorAgent.childRunId)
    .filter((event) => event.payload.leaseId === leaseId);
  const priorTerminal = matchingEvents(record, "CHILD_STOPPED", taskId, priorAgentId, priorAgent.childRunId);
  const reassigned = record.events.filter((event) => (
    event.type === "TASK_REASSIGNED"
    && event.taskId === taskId
    && event.agentId === currentAgent.agentId
    && (event.childRunId === undefined || event.childRunId === currentAgent.childRunId)
    && event.payload.fromAgentId === priorAgentId
    && event.payload.toAgentId === currentAgent.agentId
    && hasText(event.payload.fromAttemptId)
    && hasText(event.payload.toAttemptId)
    && event.payload.fromAttemptId !== event.payload.toAttemptId
    && hasBoundEventIdentity(record, event)
  ));
  const currentStarted = matchingEvents(record, "CHILD_STARTED", taskId, currentAgent.agentId, currentAgent.childRunId);
  if (
    priorStarted.length !== 1
    || priorTerminal.length !== 1
    || reassigned.length !== 1
    || currentStarted.length !== 1
  ) return false;

  const fromAttemptId = reassigned[0]!.payload.fromAttemptId;
  const toAttemptId = reassigned[0]!.payload.toAttemptId;
  if (
    !hasText(fromAttemptId)
    || !hasText(toAttemptId)
    || priorStarted[0]!.payload.attemptId !== fromAttemptId
    || priorTerminal[0]!.payload.attemptId !== fromAttemptId
    || currentStarted[0]!.payload.attemptId !== toAttemptId
  ) return false;

  const chain = [priorStarted[0]!, priorTerminal[0]!, reassigned[0]!, currentStarted[0]!];
  const positions = chain.map((event) => record.events.indexOf(event));
  const timestamps = chain.map((event) => Date.parse(event.timestamp));
  return positions.every((position, index) => index === 0 || position > positions[index - 1]!)
    && timestamps.every((timestamp, index) => (
      Number.isFinite(timestamp)
      && (index === 0 || timestamp > timestamps[index - 1]!)
    ));
}

function isValidTerminalBudgetLedger(record: SwarmRunRecord): boolean {
  const ledger = record.budgetLedger;
  if (
    !isNonnegativeFinite(ledger.capUsd)
    || (ledger.capTokens !== undefined && !isNonnegativeInteger(ledger.capTokens))
    || !isNonnegativeFinite(ledger.settledUsd)
    || !isNonnegativeInteger(ledger.settledTokens)
  ) return false;

  const leaseIds = new Set<string>();
  const agentIds = new Set(record.agents.map((agent) => agent.agentId));
  const taskIds = new Set(record.tasks.map((task) => task.taskId));
  let settledUsd = 0;
  let settledTokens = 0;
  let reservedUsd = 0;
  let reservedTokens = 0;
  let hasOverspentLease = false;
  const childUsage = new Map<string, { usd: number; tokens: number }>();
  for (const lease of ledger.leases) {
    const agent = record.agents.find((candidate) => candidate.agentId === lease.agentId);
    const task = record.tasks.find((candidate) => candidate.taskId === lease.taskId);
    const currentAssignment = task?.assignedAgentId === lease.agentId;
    const historicalAssignment = hasBoundHistoricalReassignment(
      record,
      lease.leaseId,
      lease.taskId,
      lease.agentId
    );
    if (
      !hasText(lease.leaseId)
      || leaseIds.has(lease.leaseId)
      || !hasText(lease.agentId)
      || !agentIds.has(lease.agentId)
      || !agent
      || !hasText(lease.taskId)
      || !taskIds.has(lease.taskId)
      || !task
      || !agent.contract.taskIds.includes(lease.taskId)
      || (!currentAssignment && !historicalAssignment)
      || !(lease.status === "reserved" || lease.status === "settled" || lease.status === "overspent" || lease.status === "released")
      || !isNonnegativeFinite(lease.reservedUsd)
      || !isNonnegativeInteger(lease.reservedTokens)
    ) return false;
    leaseIds.add(lease.leaseId);
    if (lease.status === "settled" || lease.status === "overspent") {
      if (
        !lease.actualUsage
        || !isNonnegativeFinite(lease.actualUsage.usd)
        || !isNonnegativeInteger(lease.actualUsage.tokens)
      ) return false;
      const exceededReservation = lease.actualUsage.usd > lease.reservedUsd
        || lease.actualUsage.tokens > lease.reservedTokens;
      if ((lease.status === "settled" && exceededReservation)
        || (lease.status === "overspent" && !exceededReservation)) return false;
      if (lease.status === "overspent") hasOverspentLease = true;
      settledUsd += lease.actualUsage.usd;
      settledTokens += lease.actualUsage.tokens;
      const usage = childUsage.get(lease.agentId) ?? { usd: 0, tokens: 0 };
      usage.usd += lease.actualUsage.usd;
      usage.tokens += lease.actualUsage.tokens;
      childUsage.set(lease.agentId, usage);
    } else if (lease.actualUsage !== undefined) {
      return false;
    }
    if (lease.status === "reserved") {
      reservedUsd += lease.reservedUsd;
      reservedTokens += lease.reservedTokens;
      const usage = childUsage.get(lease.agentId) ?? { usd: 0, tokens: 0 };
      usage.usd += lease.reservedUsd;
      usage.tokens += lease.reservedTokens;
      childUsage.set(lease.agentId, usage);
    }
  }
  for (const agent of record.agents) {
    const usage = childUsage.get(agent.agentId) ?? { usd: 0, tokens: 0 };
    if (
      usage.usd > agent.contract.budget.maxUsd
      || (agent.contract.budget.maxTokens !== undefined && usage.tokens > agent.contract.budget.maxTokens)
    ) return false;
  }
  return nearlyEqual(ledger.settledUsd, settledUsd)
    && ledger.settledTokens === settledTokens
    && (hasOverspentLease || settledUsd + reservedUsd <= ledger.capUsd)
    && (ledger.capTokens === undefined || hasOverspentLease || settledTokens + reservedTokens <= ledger.capTokens);
}

function matchingEvents(
  record: SwarmRunRecord,
  type: SwarmEvent["type"],
  taskId: string,
  agentId: string,
  childRunId: string
): SwarmEvent[] {
  return record.events.filter((event) => (
    event.type === type
    && event.taskId === taskId
    && event.agentId === agentId
    && event.childRunId === childRunId
    && hasBoundEventIdentity(record, event)
  ));
}

function hasBoundEvent(record: SwarmRunRecord, type: SwarmEvent["type"]): boolean {
  return record.events.some((event) => event.type === type && hasBoundEventIdentity(record, event));
}

function hasBoundEventIdentity(record: SwarmRunRecord, event: SwarmEvent): boolean {
  return event.swarmId === record.swarmId
    && event.parentPolicyVersion === record.parentContract.policyVersion;
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value) => right.includes(value));
}

function cloneEvent(event: SwarmEvent): SwarmEvent {
  return { ...event, payload: cloneValue(event.payload) };
}

function cloneSwarmRunRecord(record: SwarmRunRecord): SwarmRunRecord {
  return {
    ...record,
    parentContract: {
      ...record.parentContract,
      definitionOfDone: [...record.parentContract.definitionOfDone],
      budget: { ...record.parentContract.budget },
      scope: {
        allowedPaths: [...record.parentContract.scope.allowedPaths],
        deniedPaths: [...record.parentContract.scope.deniedPaths]
      },
      permissions: {
        networkDomains: [...record.parentContract.permissions.networkDomains],
        commands: [...record.parentContract.permissions.commands]
      },
      globalVerifierStack: record.parentContract.globalVerifierStack.map((step) => ({ ...step })),
      stopPolicy: { ...record.parentContract.stopPolicy },
      recoveryPolicy: { ...record.parentContract.recoveryPolicy },
      approvalPolicy: { ...record.parentContract.approvalPolicy }
    },
    tasks: record.tasks.map((task) => ({
      ...task,
      dependsOn: [...task.dependsOn],
      writeScope: [...task.writeScope]
    })),
    agents: record.agents.map((agent) => ({
      ...agent,
      contract: {
        ...agent.contract,
        taskIds: [...agent.contract.taskIds],
        scope: {
          allowedPaths: [...agent.contract.scope.allowedPaths],
          deniedPaths: [...agent.contract.scope.deniedPaths]
        },
        budget: { ...agent.contract.budget },
        permissions: {
          networkDomains: [...agent.contract.permissions.networkDomains],
          commands: [...agent.contract.permissions.commands]
        },
        approvalPolicy: { ...agent.contract.approvalPolicy }
      }
    })),
    dependencyWaivers: record.dependencyWaivers.map((waiver) => ({ ...waiver })),
    budgetLedger: {
      ...record.budgetLedger,
      leases: record.budgetLedger.leases.map((lease) => ({
        ...lease,
        ...(lease.actualUsage ? { actualUsage: { ...lease.actualUsage } } : {})
      }))
    },
    conflicts: record.conflicts.map((conflict) => ({
      ...conflict,
      taskIds: [...conflict.taskIds],
      paths: [...conflict.paths]
    })),
    verification: record.verification.map((verification) => ({
      ...verification,
      steps: verification.steps.map((step) => ({ ...step }))
    })),
    outcome: { ...record.outcome },
    events: record.events.map(cloneEvent)
  };
}

function cloneValue<T>(value: T): T {
  if (Array.isArray(value)) return value.map((item) => cloneValue(item)) as T;
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, cloneValue(item)])
    ) as T;
  }
  return value;
}

function hasText(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isNonnegativeFinite(value: number): boolean {
  return Number.isFinite(value) && value >= 0;
}

function isNonnegativeInteger(value: number): boolean {
  return Number.isInteger(value) && value >= 0;
}

function nearlyEqual(left: number, right: number): boolean {
  return Math.abs(left - right) <= Number.EPSILON * Math.max(1, Math.abs(left), Math.abs(right));
}

function isCanonicalIsoDate(value: unknown): value is string {
  if (!hasText(value)) return false;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}
