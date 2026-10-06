import { createHash } from "node:crypto";
import { lstat, mkdir, open, readFile, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

import {
  createSwarmRunRecord,
  validateSwarmLivePlan,
  type FailureClass,
  type ReceiptIntegritySummary,
  type SwarmAgentRecord,
  type SwarmBudgetLedger,
  type SwarmCleanupRecord,
  type SwarmEvent,
  type SwarmLiveEngineProfile,
  type SwarmLivePlan,
  type SwarmOutcome,
  type SwarmGlobalVerification,
  type SwarmPatchAdmission,
  type SwarmRunRecord,
  type SwarmTaskNode
} from "@martin/contracts";
import {
  runMartin,
  type MartinAdapter,
  type MartinObservedUsageGovernor,
  type RunMartinResult
} from "../index.js";
import { redactSecretsFromText } from "../leash.js";
import {
  createFileRunStore,
  runDir,
  verifyReceiptIntegrityFromFiles
} from "../persistence/index.js";
import {
  authenticateSwarmReceiptSealCommit,
  resolveSwarmReceiptIntegrityPath,
  verifySwarmReceiptIntegrityFromFiles,
  writeSwarmReceiptIntegrityMaterial,
} from "../persistence/swarm-integrity.js";
export {
  readSwarmReceiptProjection,
  verifySwarmReceiptProjection,
  type SwarmReceiptProjection,
} from "./receipt-projection.js";
import { readAndSealSwarmEvidence } from "./evidence.js";
import { buildParentSwarmReceipt } from "./parent-receipt.js";
import {
  captureAndAdmitSwarmCandidate,
  inventorySwarmCandidatePaths,
  type CaptureSwarmCandidateInput,
  type CaptureSwarmCandidateResult,
  type SwarmCandidateArtifactWriter,
  type PersistedSwarmCandidateArtifact,
  type SwarmProcessClosureEvidence
} from "./candidates.js";
import {
  runParentSwarmPipeline,
  type ParentSwarmPipelineEvidenceStore,
  type PersistedSwarmChildCompletionEvidence,
  type RunParentSwarmPipelineInput,
  type RunParentSwarmPipelineResult
} from "./index.js";
import type {
  SwarmChildLifecycleEvidenceWriter,
  SwarmLifecycleEvidenceStore,
  SwarmLifecyclePreCleanupEvidence
} from "./lifecycle.js";
import { createSwarmLiveStore, type SwarmLiveEventInput, type SwarmLiveStore } from "./live-store.js";
import type {
  SwarmIntegrationEvidenceBundle,
  SwarmIntegrationReconstruction
} from "./integration.js";
import {
  createSwarmBudgetLedger,
  extendSwarmBudgetLease,
  releaseSwarmBudgetLease,
  reserveSwarmBudgetLease,
  selectNextSwarmBatch,
  settleSwarmBudgetLease
} from "./scheduler.js";
import type { SwarmVerifierExecutor } from "./verification.js";
import {
  assertSwarmPathIdentifier,
  createSwarmWorkspaceManager,
  type SwarmWorkspaceManager,
  type SwarmWorkspaceRuntimeHandle
} from "./workspaces.js";

export interface SwarmChildAdapterFactoryInput {
  readonly engine: SwarmLiveEngineProfile;
  readonly task: SwarmTaskNode;
  readonly agent: SwarmAgentRecord;
  readonly childRunId: string;
  readonly workspace: SwarmWorkspaceRuntimeHandle;
  readonly budget: SwarmAgentRecord["contract"]["budget"];
}

export interface SwarmChildAdapterHandle {
  readonly adapter: MartinAdapter;
  /** Required for write tasks and must exactly match the Git-observed delta. */
  readonly declaredPaths: readonly string[];
}

export type SwarmChildAdapterFactory = (
  input: SwarmChildAdapterFactoryInput
) => MartinAdapter | SwarmChildAdapterHandle;

export interface SwarmLiveRuntimeEvidenceStore
  extends ParentSwarmPipelineEvidenceStore,
  SwarmCandidateArtifactWriter,
  SwarmLifecycleEvidenceStore,
  SwarmChildLifecycleEvidenceWriter {
  persistProcessClosure(evidence: SwarmProcessClosureEvidence): Promise<void>;
  persistChildCompletion(evidence: PersistedSwarmChildCompletionEvidence): Promise<void>;
}

export interface RunLiveSwarmInput {
  readonly plan: SwarmLivePlan;
  readonly liveStore: SwarmLiveStore;
  readonly workspaceManager: SwarmWorkspaceManager;
  readonly evidenceStore: SwarmLiveRuntimeEvidenceStore;
  readonly adapterFactory: SwarmChildAdapterFactory;
  readonly verifierExecutor: SwarmVerifierExecutor;
  readonly runsRoot: string;
  signal?: AbortSignal;
  readonly now?: () => string;
  readonly createId?: (prefix: string) => string;
  readonly nowMs?: () => number;
}

export interface RunLiveSwarmResult {
  readonly record: SwarmRunRecord;
  readonly outcome: SwarmOutcome;
  readonly candidateIds: readonly string[];
  readonly parent?: RunParentSwarmPipelineResult;
}

const authoritativeVerifiedResults = new WeakSet<object>();

/** Checks in-process Core authority; structurally forged CLI/test objects cannot pass. */
export function isAuthoritativeLiveSwarmVerified(result: RunLiveSwarmResult): boolean {
  if (!authoritativeVerifiedResults.has(result)) return false;
  const verifiedEvents = result.record.events.filter((event) => event.type === "SWARM_VERIFIED");
  return result.outcome.state === "verified"
    && result.parent?.outcome.state === "verified"
    && result.parent.disposition === "ready"
    && result.parent.blockingInvariants.length === 0
    && verifiedEvents.length === 1
    && verifiedEvents[0]?.swarmId === result.record.swarmId
    && verifiedEvents[0]?.parentPolicyVersion === result.record.parentContract.policyVersion;
}

export interface RunProductionLiveSwarmInput {
  readonly plan: SwarmLivePlan;
  readonly canonicalRoot: string;
  readonly ownedRoot: string;
  readonly storeRoot: string;
  readonly runsRoot: string;
  readonly workspaceIsolationMode?: "worktree" | "independent_clone";
  readonly adapterFactory: SwarmChildAdapterFactory;
  readonly verifierExecutor: SwarmVerifierExecutor;
  signal?: AbortSignal;
}

interface LiveRuntimeDependencies {
  captureCandidate(input: CaptureSwarmCandidateInput): Promise<CaptureSwarmCandidateResult>;
  inventoryCandidatePaths(workspacePath: string): Promise<string[]>;
  parentPipeline(input: RunParentSwarmPipelineInput): Promise<RunParentSwarmPipelineResult>;
  sealTerminal?(result: RunLiveSwarmResult): Promise<void>;
}

interface ActiveAttempt {
  task: SwarmTaskNode;
  agent: SwarmAgentRecord;
  childRunId: string;
  leaseId: string;
  workspace: SwarmWorkspaceRuntimeHandle;
  controller: AbortController;
  attemptId: string;
  proposalId: string;
  candidateId?: string;
  completion: Promise<AttemptCompletion>;
  settlement?: Promise<boolean>;
}

interface AttemptCompletion {
  active: ActiveAttempt;
  result?: RunMartinResult;
  error?: unknown;
}

const productionDependencies: LiveRuntimeDependencies = {
  captureCandidate: captureAndAdmitSwarmCandidate,
  inventoryCandidatePaths: inventorySwarmCandidatePaths,
  parentPipeline: runParentSwarmPipeline
};

/** Public high-level live entrypoint. Raw lifecycle and finalization authority stay internal. */
export function runLiveSwarm(input: RunLiveSwarmInput): Promise<RunLiveSwarmResult> {
  return runLiveSwarmWithDependencies(input, productionDependencies);
}

/**
 * Production composition boundary for CLI/operator callers. It accepts only
 * validated operator paths plus narrow child/verifier executors. Raw store,
 * worktree, evidence, lifecycle, and parent-finalization authority remain
 * inside Core and are never exported from the package root.
 */
export async function runProductionLiveSwarm(
  input: RunProductionLiveSwarmInput
): Promise<RunLiveSwarmResult> {
  const validation = validateSwarmLivePlan(input.plan);
  if (!validation.ok) throw codedRuntimeError("INVALID_LIVE_PLAN", "Core rejected the live swarm plan.");
  assertSwarmPathIdentifier(input.plan.swarmId, "swarm ID");
  const paths = await resolveProductionRuntimePaths(input);
  const storeRoot = paths.storeRoot;
  const liveStore = await createSwarmLiveStore({ rootDir: storeRoot, plan: input.plan });
  const workspaceManager = await createSwarmWorkspaceManager({
    canonicalRoot: resolve(input.canonicalRoot),
    ownedRoot: paths.ownedRoot,
    swarmId: input.plan.swarmId,
    ...(input.workspaceIsolationMode ? { isolationMode: input.workspaceIsolationMode } : {}),
  });
  if (workspaceManager.baselineCommit.toLowerCase() !== input.plan.baselineCommit.toLowerCase()) {
    throw codedRuntimeError("LIVE_PLAN_BASELINE_MISMATCH", "Live swarm plan baseline no longer matches the canonical repository.");
  }
  await liveStore.claimStart();
  const claimedSnapshot = await liveStore.readSnapshot();
  if (claimedSnapshot.eventCount > 0) {
    throw codedRuntimeError(
      "LIVE_SWARM_ALREADY_STARTED",
      "This live swarm contains pre-claim execution state; replay remains blocked before spend."
    );
  }
  const evidenceStore = new FileSwarmLiveRuntimeEvidenceStore(paths.evidenceRoot);
  return runLiveSwarmWithDependencies({
    plan: input.plan,
    liveStore,
    workspaceManager,
    evidenceStore,
    adapterFactory: input.adapterFactory,
    verifierExecutor: input.verifierExecutor,
    runsRoot: paths.runsRoot,
    ...(input.signal ? { signal: input.signal } : {}),
  }, {
    ...productionDependencies,
    sealTerminal: async (result) => {
      try {
        await sealProductionSwarmTerminal(paths, input.plan, result);
      } catch (error) {
        await persistSwarmSealFailure(paths.evidenceRoot, input.plan, "terminal_evidence_sealing_failed");
        throw error;
      }
    }
  });
}

async function resolveProductionRuntimePaths(input: RunProductionLiveSwarmInput): Promise<{
  runsRoot: string;
  storeRoot: string;
  ownedRoot: string;
  evidenceRoot: string;
}> {
  const runsRoot = await realpath(resolve(input.runsRoot));
  const requestedStoreRoot = resolve(input.storeRoot);
  assertContainedOrSame(runsRoot, requestedStoreRoot, "Live swarm store root escaped the caller runs root.");
  await mkdir(requestedStoreRoot, { recursive: true });
  const storeRoot = await realpath(requestedStoreRoot);
  assertContainedOrSame(runsRoot, storeRoot, "Live swarm store root escaped the real caller runs root.");

  const swarmsRoot = await resolveOrCreateStrictlyContained(storeRoot, join(storeRoot, "_swarms"));
  const swarmRoot = await resolveOrCreateStrictlyContained(swarmsRoot, join(swarmsRoot, input.plan.swarmId));
  const expectedOwnedRoot = join(swarmRoot, "worktrees");
  if (resolve(input.ownedRoot) !== resolve(expectedOwnedRoot)) {
    throw codedRuntimeError("LIVE_SWARM_PATH_ESCAPE", "Live swarm worktree root must use the governed run layout.");
  }
  const ownedRoot = await resolveOrCreateStrictlyContained(swarmRoot, expectedOwnedRoot);
  const evidenceRoot = await resolveOrCreateStrictlyContained(swarmRoot, join(swarmRoot, "evidence"));
  return { runsRoot, storeRoot, ownedRoot, evidenceRoot };
}

interface SwarmReceiptSealCommit {
  schemaVersion: "martin.swarm-receipt-seal.v1";
  swarmId: string;
  planHash: string;
  receiptSha256: string;
  evidenceIndexSha256: string;
  integrityMaterialSha256: string;
  committedAt: string;
  commitHmacSha256: string;
}

async function sealProductionSwarmTerminal(
  paths: { runsRoot: string; evidenceRoot: string },
  plan: SwarmLivePlan,
  result: RunLiveSwarmResult
): Promise<void> {
  const sealed = await readAndSealSwarmEvidence({ rootDir: paths.runsRoot, swarmId: plan.swarmId });
  const receipt = buildParentSwarmReceipt(sealed);
  if (receipt.parentOutcome.state !== result.outcome.state || receipt.planHash !== plan.planHash) {
    throw codedRuntimeError("SWARM_SEAL_OUTCOME_MISMATCH", "Sealed evidence disagrees with the terminal runtime outcome.");
  }
  const receiptPath = join(paths.evidenceRoot, "parent-receipt.json");
  const receiptBytes = `${JSON.stringify(receipt, null, 2)}\n`;
  await writeExclusiveIdempotent(receiptPath, receiptBytes);
  const integrity = await writeSwarmReceiptIntegrityMaterial({
    runsRoot: paths.runsRoot,
    swarmId: plan.swarmId,
    signedAt: sealed.index.sealedAt
  });
  if (!integrity) {
    throw codedRuntimeError("SWARM_SEAL_KEY_UNAVAILABLE", "Swarm receipt integrity key material was unavailable.");
  }
  const verified = await verifySwarmReceiptIntegrityFromFiles({ runsRoot: paths.runsRoot, swarmId: plan.swarmId });
  if (verified.state !== "verified") {
    throw codedRuntimeError("SWARM_SEAL_INTEGRITY_FAILED", "Swarm receipt integrity verification failed before commit.");
  }
  const integrityPath = resolveSwarmReceiptIntegrityPath(paths.runsRoot, plan.swarmId);
  const integrityBytes = await readFile(integrityPath, "utf8");
  const sealBase = {
    schemaVersion: "martin.swarm-receipt-seal.v1",
    swarmId: plan.swarmId,
    planHash: plan.planHash,
    receiptSha256: sha256Text(receiptBytes),
    evidenceIndexSha256: sha256Text(await readFile(sealed.indexPath, "utf8")),
    integrityMaterialSha256: sha256Text(integrityBytes),
    committedAt: sealed.index.sealedAt
  } satisfies import("../persistence/swarm-integrity.js").SwarmReceiptSealCommitBase;
  const seal: SwarmReceiptSealCommit = {
    ...sealBase,
    commitHmacSha256: await authenticateSwarmReceiptSealCommit({
      runsRoot: paths.runsRoot,
      swarmId: plan.swarmId,
      commit: sealBase
    })
  };
  await writeExclusiveIdempotent(
    join(paths.evidenceRoot, "swarm-receipt-seal.json"),
    `${JSON.stringify(seal, null, 2)}\n`
  );
}

async function persistSwarmSealFailure(
  evidenceRoot: string,
  plan: SwarmLivePlan,
  reason: string
): Promise<void> {
  await writeExclusiveIdempotent(join(evidenceRoot, "swarm-receipt-seal-status.json"), `${JSON.stringify({
    schemaVersion: "martin.swarm-receipt-seal-status.v1",
    swarmId: plan.swarmId,
    planHash: plan.planHash,
    state: "needs_review",
    reason
  }, null, 2)}\n`);
}

function sha256Text(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function resolveOrCreateStrictlyContained(parent: string, requested: string): Promise<string> {
  assertStrictlyContained(parent, requested, "Live swarm runtime path escaped its governed ancestor.");
  let resolved: string;
  try {
    resolved = await realpath(requested);
  } catch (error) {
    if (!isNodeError(error, "ENOENT")) throw error;
    await mkdir(requested, { recursive: true });
    resolved = await realpath(requested);
  }
  assertStrictlyContained(parent, resolved, "Live swarm runtime realpath escaped its governed ancestor.");
  return resolved;
}

function assertContainedOrSame(parent: string, candidate: string, message: string): void {
  const relation = relative(parent, candidate);
  if (relation === "") return;
  assertStrictlyContained(parent, candidate, message);
}

function assertStrictlyContained(parent: string, candidate: string, message: string): void {
  const relation = relative(parent, candidate);
  if (!relation || relation === ".." || relation.startsWith(`..${sep}`) || isAbsolute(relation)) {
    throw codedRuntimeError("LIVE_SWARM_PATH_ESCAPE", message);
  }
}

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === code;
}

function codedRuntimeError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

/** Internal test seam; intentionally not re-exported from the Core package root. */
export async function runLiveSwarmWithDependencies(
  input: RunLiveSwarmInput,
  dependencies: LiveRuntimeDependencies
): Promise<RunLiveSwarmResult> {
  assertRuntimeInput(input);
  const now = input.now ?? (() => new Date().toISOString());
  const nowMs = input.nowMs ?? (() => Date.now());
  const parentDeadlineMs = nowMs() + input.plan.parentContract.maxWallClockMs;
  const createId = input.createId ?? ((prefix: string) => `${prefix}-${Math.random().toString(36).slice(2, 10)}`);
  const parentController = new AbortController();
  const cancellationMonitorController = new AbortController();
  let schedulingOpen = true;
  const parentDeadlineTimer = setTimeout(() => {
    schedulingOpen = false;
    if (!parentController.signal.aborted) {
      parentController.abort(new Error("Parent swarm wall-clock deadline reached."));
    }
  }, Math.min(input.plan.parentContract.maxWallClockMs, 2_147_483_647));
  parentDeadlineTimer.unref();
  const abortParent = (): void => {
    schedulingOpen = false;
    if (!parentController.signal.aborted) parentController.abort(input.signal?.reason);
  };
  if (input.signal?.aborted) abortParent();
  else {
    input.signal?.addEventListener("abort", abortParent, { once: true });
    if (input.signal?.aborted) abortParent();
  }

  const observeDurableCancellation = async (): Promise<boolean> => {
    const snapshot = await input.liveStore.readSnapshot();
    if (!snapshot.cancellation) return false;
    schedulingOpen = false;
    if (!parentController.signal.aborted) {
      parentController.abort(new Error(`Durable swarm cancellation requested: ${snapshot.cancellation.reason}`));
    }
    return true;
  };
  let cancellationMonitorFailure: unknown;
  const cancellationMonitor = (async (): Promise<void> => {
    let revision = (await input.liveStore.readSnapshot()).revision;
    if (await observeDurableCancellation()) return;
    while (!cancellationMonitorController.signal.aborted && !parentController.signal.aborted) {
      const snapshot = await input.liveStore.waitForRevision(revision, cancellationMonitorController.signal);
      revision = snapshot.revision;
      if (snapshot.cancellation) {
        schedulingOpen = false;
        if (!parentController.signal.aborted) {
          parentController.abort(new Error(`Durable swarm cancellation requested: ${snapshot.cancellation.reason}`));
        }
        return;
      }
    }
  })().catch((error: unknown) => {
    if (cancellationMonitorController.signal.aborted) return;
    cancellationMonitorFailure = error;
    schedulingOpen = false;
    if (!parentController.signal.aborted) parentController.abort(error);
  });

  let record = createSwarmRunRecord({
    swarmId: input.plan.swarmId,
    workspaceId: input.plan.workspaceId,
    projectId: input.plan.projectId,
    parentContract: input.plan.parentContract,
    tasks: input.plan.tasks.map((task) => ({ ...task, status: "queued" })),
    agents: input.plan.agents.map((agent) => ({ ...agent, status: "queued", childRunId: undefined })),
    budgetLedger: createSwarmBudgetLedger({
      capUsd: input.plan.parentContract.budget.maxUsd,
      ...(input.plan.parentContract.budget.maxTokens === undefined
        ? {}
        : { capTokens: input.plan.parentContract.budget.maxTokens })
    }),
    createdAt: now(),
    updatedAt: now()
  }, { now: now() });
  const runStore = createFileRunStore({ runsRoot: input.runsRoot });
  const active = new Map<string, ActiveAttempt>();
  const candidateIds: string[] = [];
  const reassignmentCounts = new Map<string, number>();
  const preboundAttemptIds = new Map<string, string>();
  const observedUsageByLease = new Map<string, { usd: number; tokens: number }>();

  try {
    await appendEvent({
      idempotencyKey: `${input.plan.planHash}:created`,
      type: "SWARM_CREATED",
      timestamp: now(),
      payload: { engine: input.plan.engine.engine, model: input.plan.engine.model }
    });

    while (true) {
      await observeDurableCancellation();
      if (nowMs() >= parentDeadlineMs && !parentController.signal.aborted) {
        parentController.abort(new Error("Parent swarm wall-clock deadline reached."));
      }
      if (parentController.signal.aborted) {
        record = await cancelActiveChildren("cancelled");
        if (cancellationMonitorFailure !== undefined) {
          record = withTerminal(record, "needs_review", safeError(cancellationMonitorFailure), now());
        }
        const needsReview = record.outcome.state === "needs_review";
        const terminalReason = needsReview ? record.outcome.reason : "parent_cancelled";
        await appendEvent({
          idempotencyKey: `${input.plan.planHash}:${needsReview ? "needs-review" : "stopped"}:cancelled`,
          type: needsReview ? "SWARM_NEEDS_REVIEW" : "SWARM_STOPPED",
          timestamp: now(),
          payload: { reason: terminalReason }
        });
        return finalizeTerminalResult(needsReview
          ? { record, outcome: record.outcome, candidateIds: Object.freeze([...candidateIds]) }
          : terminalResult(record, candidateIds, "stopped", "Parent cancelled the live swarm."));
      }

      if (schedulingOpen) {
        const batch = selectNextSwarmBatch({
          swarmId: record.swarmId,
          tasks: record.tasks,
          maxConcurrency: record.parentContract.maxConcurrency,
          parentContract: record.parentContract
        });
        if (!batch.ok) {
          schedulingOpen = false;
          record = withTerminal(record, "needs_review", batch.errors.map((error) => error.code).join(","), now());
        } else {
          for (const task of batch.tasks) {
            await observeDurableCancellation();
            if (!schedulingOpen || parentController.signal.aborted) break;
            const launched = await launchTask(task);
            if (!launched) {
              schedulingOpen = false;
              break;
            }
          }
        }
      }

      if (parentController.signal.aborted) continue;

      if (active.size === 0) {
        const incompleteRequired = record.tasks.filter((task) => task.required && task.status !== "accepted");
        if (incompleteRequired.length > 0) {
          if (record.outcome.state === "running") {
            record = withTerminal(record, "needs_review", "Required tasks could not reach accepted state.", now());
          }
          return finalizeTerminalResult({ record, outcome: record.outcome, candidateIds: Object.freeze([...candidateIds]) });
        }
        break;
      }

      const completed = await Promise.race([...active.values()].map((attempt) => attempt.completion));
      const terminal = await settleAttemptOnce(completed, parentController.signal.aborted);
      if (terminal) schedulingOpen = false;
    }

    if (parentController.signal.aborted || record.outcome.state !== "running") {
      return finalizeTerminalResult({ record, outcome: record.outcome, candidateIds: Object.freeze([...candidateIds]) });
    }
    const parent = await dependencies.parentPipeline({
      record,
      candidateIds,
      workspaceManager: input.workspaceManager,
      evidenceStore: input.evidenceStore,
      integrationWorkspaceId: createId("integration-workspace"),
      verifierWorkspaceId: createId("verifier-workspace"),
      verifierExecutor: input.verifierExecutor,
      signal: parentController.signal,
      now,
      createId
    });
    const verifiedEvents = parent.record.events.filter((event) => (
      event.type === "SWARM_VERIFIED"
      && event.swarmId === record.swarmId
      && event.parentPolicyVersion === record.parentContract.policyVersion
    ));
    if (
      parent.outcome.state === "verified"
      && (
        parent.disposition !== "ready"
        || parent.blockingInvariants.length !== 0
        || verifiedEvents.length !== 1
      )
    ) {
      const rejected = withTerminal(parent.record, "needs_review", "Parent result lacked one exact SWARM_VERIFIED authority event.", now());
      await appendEvent({
        idempotencyKey: `${input.plan.planHash}:needs-review:parent-verified-event`,
        type: "SWARM_NEEDS_REVIEW",
        timestamp: now(),
        payload: { reason: rejected.outcome.reason }
      });
      return finalizeTerminalResult({ record: rejected, outcome: rejected.outcome, candidateIds: Object.freeze([...candidateIds]), parent });
    }
    try {
      const snapshot = await input.liveStore.readSnapshot();
      await input.liveStore.persistParentOutcome(parent, { expectedRevision: snapshot.revision });
    } catch {
      const rejected = withTerminal(
        parent.record,
        "needs_review",
        "Parent pipeline outcome lacked operational-store authority or could not be persisted.",
        now()
      );
      await appendEvent({
        idempotencyKey: `${input.plan.planHash}:needs-review:parent-outcome-authority`,
        type: "SWARM_NEEDS_REVIEW",
        timestamp: now(),
        payload: { reason: rejected.outcome.reason }
      });
      return finalizeTerminalResult({ record: rejected, outcome: rejected.outcome, candidateIds: Object.freeze([...candidateIds]), parent });
    }
    const result: RunLiveSwarmResult = {
      record: parent.record,
      outcome: parent.outcome,
      candidateIds: Object.freeze([...candidateIds]),
      parent
    };
    return finalizeTerminalResult(result);
  } finally {
    schedulingOpen = false;
    clearTimeout(parentDeadlineTimer);
    input.signal?.removeEventListener("abort", abortParent);
    cancellationMonitorController.abort("runtime closed");
    await cancellationMonitor;
  }

  async function launchTask(task: SwarmTaskNode): Promise<boolean> {
    if (await observeDurableCancellation()) return false;
    const agent = record.agents.find((candidate) => candidate.agentId === task.assignedAgentId);
    if (!agent) {
      record = withTerminal(record, "needs_review", `Task ${task.taskId} has no assigned agent.`, now());
      return false;
    }
    const leaseId = createId("lease");
    const attemptId = preboundAttemptIds.get(task.taskId) ?? createId("attempt");
    preboundAttemptIds.delete(task.taskId);
    const reservationBudget = {
      ...agent.contract.budget,
      maxIterations: Math.min(agent.contract.budget.maxIterations, input.plan.childMaxIterations)
    };
    const budget = {
      ...reservationBudget,
      maxUsd: agent.contract.hardMaxUsd ?? input.plan.parentContract.budget.maxUsd,
      softLimitUsd: agent.contract.hardMaxUsd ?? input.plan.parentContract.budget.maxUsd,
      ...(agent.contract.hardMaxTokens !== undefined
        ? { maxTokens: agent.contract.hardMaxTokens }
        : input.plan.parentContract.budget.maxTokens !== undefined
          ? { maxTokens: input.plan.parentContract.budget.maxTokens }
          : {})
    };
    const reservation = reserveSwarmBudgetLease(record.budgetLedger, {
      leaseId,
      agentId: agent.agentId,
      taskId: task.taskId,
      reservedUsd: reservationBudget.maxUsd,
      reservedTokens: reservationBudget.maxTokens ?? 0
    });
    if (!reservation.ok) {
      await appendBlockedAction({
        taskId: task.taskId,
        agentId: agent.agentId,
        attemptId,
        action: "budget_reservation",
        reason: reservation.errors.map((error) => error.code).join(",")
      });
      record = withTerminal(record, "stopped", reservation.errors.map((error) => error.code).join(","), now());
      return false;
    }
    record = { ...record, budgetLedger: reservation.ledger, updatedAt: now() };
    const childRunId = createId("child-run");
    const workspaceId = createId("child-workspace");
    const proposalId = createId("proposal");
    const candidateId = task.mutationMode === "write" ? createId("candidate") : undefined;
    let workspace: SwarmWorkspaceRuntimeHandle;
    try {
      workspace = await input.workspaceManager.createWorkspace({
        kind: "child",
        workspaceId,
        childRunId,
        agentId: agent.agentId,
        taskIds: [task.taskId]
      });
    } catch (error) {
      const released = releaseSwarmBudgetLease(record.budgetLedger, leaseId);
      if (released.ok) record = { ...record, budgetLedger: released.ledger };
      const lease = record.budgetLedger.leases.find((candidate) => candidate.leaseId === leaseId);
      await appendBlockedAction({
        taskId: task.taskId,
        agentId: agent.agentId,
        childRunId,
        attemptId,
        action: "workspace_creation",
        reason: safeError(error),
        details: {
          leaseId,
          leaseState: lease?.status,
          reservedUsd: lease?.reservedUsd,
          reservedTokens: lease?.reservedTokens,
          actualUsd: 0,
          actualTokens: 0
        }
      });
      record = withTerminal(record, "needs_review", safeError(error), now());
      return false;
    }
    let adapter: MartinAdapter;
    try {
      if (await observeDurableCancellation()) {
        await cancelPreparedLaunch({ task, agent, childRunId, leaseId, workspace, attemptId });
        return false;
      }
      const factoryResult = input.adapterFactory({
        engine: input.plan.engine,
        task,
        agent,
        childRunId,
        workspace,
        budget
      });
      adapter = isAdapterHandle(factoryResult) ? factoryResult.adapter : factoryResult;
      if (adapter.metadata.providerId !== input.plan.engine.engine) {
        throw new Error("LIVE_ENGINE_PROVIDER_MISMATCH: every child must use the parent-selected provider.");
      }
      if (adapter.metadata.model !== input.plan.engine.model) {
        throw new Error("LIVE_ENGINE_MODEL_MISMATCH: every child must use the parent-selected model.");
      }
    } catch (error) {
      await failPreparedLaunch({ task, agent, childRunId, leaseId, workspace, attemptId }, error);
      return false;
    }
    const controller = new AbortController();
    const relayAbort = () => controller.abort(parentController.signal.reason);
    if (parentController.signal.aborted) relayAbort();
    else {
      parentController.signal.addEventListener("abort", relayAbort, { once: true });
      if (parentController.signal.aborted) relayAbort();
    }
    record = updateTaskAndAgent(record, task.taskId, agent.agentId, childRunId, "running", "running", now());
    try {
      await appendEvent({
        idempotencyKey: `${childRunId}:started`,
        type: "CHILD_STARTED",
        timestamp: now(),
        taskId: task.taskId,
        agentId: agent.agentId,
        childRunId,
        payload: {
          attemptId,
          engine: input.plan.engine.engine,
          model: input.plan.engine.model,
          workspaceId,
          leaseId,
          reservedUsd: record.budgetLedger.leases.find((lease) => lease.leaseId === leaseId)?.reservedUsd,
          reservedTokens: record.budgetLedger.leases.find((lease) => lease.leaseId === leaseId)?.reservedTokens,
          maxIterations: budget.maxIterations
        }
      });
    } catch (error) {
      parentController.signal.removeEventListener("abort", relayAbort);
      await failPreparedLaunch({ task, agent, childRunId, leaseId, workspace, attemptId }, error);
      return false;
    }
    const effectiveWallClockMs = Math.max(
      1,
      Math.min(agent.contract.maxWallClockMs, parentDeadlineMs - nowMs()),
    );
    const childDeadlineTimer = setTimeout(() => {
      if (!controller.signal.aborted) {
        controller.abort(new Error("Child swarm wall-clock deadline reached."));
      }
    }, Math.min(effectiveWallClockMs, 2_147_483_647));
    childDeadlineTimer.unref();
    const observedUsageGovernor: MartinObservedUsageGovernor = (observation) => {
      const currentLease = record.budgetLedger.leases.find((lease) => lease.leaseId === leaseId);
      const prior = observedUsageByLease.get(leaseId) ?? { usd: 0, tokens: 0 };
      const grantedUsd = currentLease?.reservedUsd ?? 0;
      const grantedTokens = currentLease?.reservedTokens ?? 0;
      if (record.outcome.state !== "running" || currentLease?.status !== "reserved") {
        return { action: "terminate", grantedUsd, grantedTokens, reason: "parent_terminal" };
      }
      if (
        !Number.isFinite(observation.cumulativeUsd)
        || observation.cumulativeUsd < prior.usd
        || !Number.isInteger(observation.cumulativeTokens)
        || observation.cumulativeTokens < prior.tokens
      ) {
        return { action: "terminate", grantedUsd, grantedTokens, reason: "non_monotonic_usage_observation" };
      }
      if (
        (agent.contract.hardMaxUsd !== undefined && observation.cumulativeUsd > agent.contract.hardMaxUsd)
        || (agent.contract.hardMaxTokens !== undefined && observation.cumulativeTokens > agent.contract.hardMaxTokens)
      ) {
        return { action: "terminate", grantedUsd, grantedTokens, reason: "child_hard_cap_exceeded" };
      }
      const protectedUsage = Object.fromEntries(observedUsageByLease);
      protectedUsage[leaseId] = { usd: observation.cumulativeUsd, tokens: observation.cumulativeTokens };
      const extended = extendSwarmBudgetLease(record.budgetLedger, {
        leaseId,
        requiredUsd: observation.cumulativeUsd,
        requiredTokens: observation.cumulativeTokens,
        protectedUsage
      });
      if (!extended.ok) {
        return {
          action: "terminate",
          grantedUsd,
          grantedTokens,
          reason: extended.errors.map((error) => error.code).join(",")
        };
      }
      observedUsageByLease.set(leaseId, {
        usd: observation.cumulativeUsd,
        tokens: observation.cumulativeTokens
      });
      record = { ...record, budgetLedger: extended.ledger, updatedAt: now() };
      return {
        action: "continue",
        grantedUsd: extended.lease.reservedUsd,
        grantedTokens: extended.lease.reservedTokens
      };
    };
    const runPromise = runMartin({
      workspaceId,
      projectId: input.plan.projectId,
      task: {
        title: task.title,
        objective: task.objective,
        verificationPlan: agent.contract.permissions.commands,
        repoRoot: workspace.path,
        // Scope controls what the child may inspect; mutationMode controls
        // whether any of that scope may be changed. Keeping those concerns
        // separate lets CLI and remote/model adapters share one Swarm contract.
        allowedPaths: agent.contract.scope.allowedPaths,
        deniedPaths: agent.contract.scope.deniedPaths,
        allowedNetworkDomains: agent.contract.permissions.networkDomains,
        approvalPolicy: agent.contract.approvalPolicy,
        providerExecutionTimeoutMs: effectiveWallClockMs,
        mutationMode: task.mutationMode === "write" ? "edit" as const : "read_only" as const
      },
      budget,
      adapter,
      store: runStore,
      receiptScope: {
        repoRoot: workspace.path,
        workingDirectory: workspace.path,
        runsRoot: input.runsRoot,
        swarmChild: {
          parentSwarmId: record.swarmId,
          agentId: agent.agentId,
          attemptId,
          taskIds: [task.taskId]
        }
      },
      metadata: {
        "swarm.parentId": record.swarmId,
        "swarm.agentId": agent.agentId,
        "swarm.taskIds": JSON.stringify([task.taskId]),
        "swarm.attemptId": attemptId,
        "swarm.proposalId": proposalId,
        "swarm.baselineCommit": input.plan.baselineCommit,
        "swarm.engine": input.plan.engine.engine,
        "swarm.model": input.plan.engine.model
      },
      verificationExecutionOwner: "host_only",
      observedUsageGovernor,
      signal: controller.signal,
      now,
      idFactory: childIdFactory(childRunId, createId)
    });
    const activeAttempt = {} as ActiveAttempt;
    Object.assign(activeAttempt, {
      task,
      agent,
      childRunId,
      leaseId,
      workspace,
      controller,
      attemptId,
      proposalId,
      ...(candidateId ? { candidateId } : {}),
      completion: runPromise.then(
        (result) => ({ active: activeAttempt, result }),
        (error: unknown) => ({ active: activeAttempt, error })
      ).finally(() => {
        clearTimeout(childDeadlineTimer);
        parentController.signal.removeEventListener("abort", relayAbort);
      })
    });
    active.set(childRunId, activeAttempt);
    return true;
  }

  async function failPreparedLaunch(
    attempt: Pick<ActiveAttempt, "task" | "agent" | "childRunId" | "leaseId" | "workspace" | "attemptId">,
    error: unknown
  ): Promise<void> {
    const released = releaseSwarmBudgetLease(record.budgetLedger, attempt.leaseId);
    if (released.ok) record = { ...record, budgetLedger: released.ledger, updatedAt: now() };
    const closurePersisted = await persistProcessClosure(attempt);
    const cleanup = closurePersisted
      ? await cleanupWorkspace(attempt.workspace, true)
      : await preserveWorkspaceForMissingEvidence(attempt.workspace);
    record = updateTaskAndAgent(
      record,
      attempt.task.taskId,
      attempt.agent.agentId,
      attempt.childRunId,
      "needs_review",
      "needs_review",
      now()
    );
    const reason = !closurePersisted
      ? "process_closure_evidence_not_persisted"
      : cleanup.state === "completed" ? safeError(error) : "cleanup_pending";
    await appendBlockedAction({
      taskId: attempt.task.taskId,
      agentId: attempt.agent.agentId,
      childRunId: attempt.childRunId,
      attemptId: attempt.attemptId,
      action: "child_launch",
      reason
    });
    record = withTerminal(record, "needs_review", safeError(error), now());
    await appendEvent(childTerminalEvent(
      attempt,
      "CHILD_NEEDS_REVIEW",
      reason,
      now(),
      "environment_mismatch",
      budgetEventDetails(attempt)
    )).catch(() => undefined);
  }

  async function cancelPreparedLaunch(
    attempt: Pick<ActiveAttempt, "task" | "agent" | "childRunId" | "leaseId" | "workspace" | "attemptId">
  ): Promise<void> {
    const released = releaseSwarmBudgetLease(record.budgetLedger, attempt.leaseId);
    if (released.ok) record = { ...record, budgetLedger: released.ledger, updatedAt: now() };
    const closurePersisted = await persistProcessClosure(attempt);
    const cleanup = closurePersisted
      ? await cleanupWorkspace(attempt.workspace, true)
      : await preserveWorkspaceForMissingEvidence(attempt.workspace);
    const clean = closurePersisted && cleanup.state === "completed";
    record = updateTaskAndAgent(
      record,
      attempt.task.taskId,
      attempt.agent.agentId,
      attempt.childRunId,
      clean ? "stopped" : "needs_review",
      clean ? "stopped" : "needs_review",
      now()
    );
    if (!clean) record = withTerminal(record, "needs_review", "cleanup_pending", now());
    await appendEvent(childTerminalEvent(
      attempt,
      clean ? "CHILD_STOPPED" : "CHILD_NEEDS_REVIEW",
      clean ? "parent_cancelled" : "cleanup_pending",
      now(),
      undefined,
      budgetEventDetails(attempt)
    ));
  }

  function settleAttemptOnce(completed: AttemptCompletion, cancellationRequested: boolean): Promise<boolean> {
    const attempt = completed.active;
    if (!attempt.settlement) {
      attempt.settlement = settleAttempt(completed, cancellationRequested).finally(() => {
        active.delete(attempt.childRunId);
      });
    }
    return attempt.settlement;
  }

  async function settleAttempt(completed: AttemptCompletion, cancellationRequested = false): Promise<boolean> {
    const { active: attempt } = completed;
    const closurePersisted = await persistProcessClosure(attempt);
    if (completed.error || !completed.result) {
      const released = releaseSwarmBudgetLease(record.budgetLedger, attempt.leaseId);
      if (released.ok) record = { ...record, budgetLedger: released.ledger };
      const cleanup = closurePersisted
        ? await cleanupWorkspace(attempt.workspace, true)
        : await preserveWorkspaceForMissingEvidence(attempt.workspace);
      record = updateTaskAndAgent(record, attempt.task.taskId, attempt.agent.agentId, attempt.childRunId, "needs_review", "needs_review", now());
      await appendEvent(childTerminalEvent(
        attempt,
        "CHILD_NEEDS_REVIEW",
        !closurePersisted
          ? "process_closure_evidence_not_persisted"
          : cleanup.state === "completed" ? "child_crash" : "cleanup_pending",
        now(),
        "environment_mismatch",
        budgetEventDetails(attempt)
      ));
      record = withTerminal(
        record,
        "needs_review",
        completed.error ? safeError(completed.error) : "Child execution returned no result.",
        now()
      );
      return true;
    }

    const actualUsd = completed.result.loop.cost.actualUsd;
    const actualTokens = completed.result.loop.cost.tokensIn + completed.result.loop.cost.tokensOut;
    const childPassed = completed.result.loop.status === "completed"
      && completed.result.decision.lifecycleState === "completed";
    const withinExplicitChildCap = (
      (attempt.agent.contract.hardMaxUsd === undefined || actualUsd <= attempt.agent.contract.hardMaxUsd)
      && (attempt.agent.contract.hardMaxTokens === undefined || actualTokens <= attempt.agent.contract.hardMaxTokens)
    );
    if (withinExplicitChildCap) {
      const protectedUsage = Object.fromEntries(observedUsageByLease);
      const priorObserved = observedUsageByLease.get(attempt.leaseId) ?? { usd: 0, tokens: 0 };
      const finalObserved = {
        usd: Math.max(priorObserved.usd, actualUsd),
        tokens: Math.max(priorObserved.tokens, actualTokens)
      };
      protectedUsage[attempt.leaseId] = finalObserved;
      const reconciled = extendSwarmBudgetLease(record.budgetLedger, {
        leaseId: attempt.leaseId,
        requiredUsd: finalObserved.usd,
        requiredTokens: finalObserved.tokens,
        protectedUsage
      });
      if (reconciled.ok) {
        record = { ...record, budgetLedger: reconciled.ledger, updatedAt: now() };
      }
    }
    const settlement = settleSwarmBudgetLease(record.budgetLedger, {
      leaseId: attempt.leaseId,
      actualUsd,
      actualTokens,
      provenance: completed.result.loop.cost.provenance
    });
    observedUsageByLease.delete(attempt.leaseId);
    if (!settlement.ok) {
      const leaseOverspent = settlement.errors.some((error) => error.code === "LEASE_OVERSPEND");
      if (leaseOverspent) {
        record = { ...record, budgetLedger: settlement.ledger, updatedAt: now() };
      } else {
        const released = releaseSwarmBudgetLease(record.budgetLedger, attempt.leaseId);
        if (released.ok) record = { ...record, budgetLedger: released.ledger, updatedAt: now() };
      }
      if (!closurePersisted) {
        await terminalizeMissingClosureEvidence(attempt, { actualUsd, actualTokens });
        return true;
      }
      const cleanup = await cleanupWorkspace(attempt.workspace, true);
      if (leaseOverspent && cleanup.state === "completed") {
        await persistCompletion(attempt, completed.result, "overspent", cleanup);
      }
      record = updateTaskAndAgent(record, attempt.task.taskId, attempt.agent.agentId, attempt.childRunId, "stopped", "stopped", now());
      const originalFailureReason = completed.result.decision.reason;
      const originalFailureClass = childFailureClass(completed.result);
      // A completed child with no structural/provider failure that exits only
      // because accounting crossed its limit is a budget-primary failure.
      // Concrete provider/safety classes remain primary and are preserved.
      const budgetIsPrimary = childPassed
        || originalFailureClass === undefined
        || originalFailureClass === "budget_pressure";
      await appendEvent(childTerminalEvent(attempt, "CHILD_STOPPED", cleanup.state === "completed"
        ? (!budgetIsPrimary ? "child_terminal_failure" : leaseOverspent ? "lease_overage" : "budget_settlement_failed")
        : "cleanup_pending", now(), budgetIsPrimary ? "budget_pressure" : originalFailureClass, {
        actualUsd,
        actualTokens,
        reservedUsd: record.budgetLedger.leases.find((lease) => lease.leaseId === attempt.leaseId)?.reservedUsd,
        reservedTokens: record.budgetLedger.leases.find((lease) => lease.leaseId === attempt.leaseId)?.reservedTokens,
        leaseState: record.budgetLedger.leases.find((lease) => lease.leaseId === attempt.leaseId)?.status,
        budgetStatus: leaseOverspent ? "exceeded" : "settlement_failed",
        settlementStatus: "failed",
        ...(!budgetIsPrimary ? { originalFailureReason } : {})
      }));
      record = withTerminal(
        record,
        "stopped",
        !budgetIsPrimary
          ? originalFailureReason
          : leaseOverspent
          ? "Child actual usage exceeded its reserved lease."
          : "Child budget settlement failed.",
        now()
      );
      return true;
    }
    record = { ...record, budgetLedger: settlement.ledger, updatedAt: now() };
    if (!closurePersisted) {
      await terminalizeMissingClosureEvidence(attempt, { actualUsd, actualTokens });
      return true;
    }

    if (record.outcome.state !== "running" || !schedulingOpen) {
      const cleanup = await cleanupWorkspace(attempt.workspace, true);
      if (cleanup.state === "completed") {
        await persistCompletion(attempt, completed.result, "settled", cleanup);
      }
      record = updateTaskAndAgent(
        record,
        attempt.task.taskId,
        attempt.agent.agentId,
        attempt.childRunId,
        "stopped",
        "stopped",
        now()
      );
      await appendEvent(childTerminalEvent(
        attempt,
        "CHILD_STOPPED",
        cleanup.state === "completed" ? "parent_terminal_not_admitted" : "cleanup_pending",
        now(),
        childFailureClass(completed.result),
        budgetEventDetails(attempt, actualUsd, actualTokens)
      ));
      return true;
    }

    if (cancellationRequested || parentController.signal.aborted) {
      const cleanup = await cleanupWorkspace(attempt.workspace, true);
      if (cleanup.state === "completed") {
        await persistCompletion(attempt, completed.result, "settled", cleanup);
      }
      record = updateTaskAndAgent(record, attempt.task.taskId, attempt.agent.agentId, attempt.childRunId, "stopped", "stopped", now());
      await appendEvent(childTerminalEvent(
        attempt,
        "CHILD_STOPPED",
        cleanup.state === "completed" ? "parent_cancelled" : "cleanup_pending",
        now(),
        childFailureClass(completed.result),
        budgetEventDetails(attempt, actualUsd, actualTokens)
      ));
      return true;
    }

    if (!childPassed) {
      const cleanup = await cleanupWorkspace(attempt.workspace, true);
      if (cleanup.state === "completed") {
        await persistCompletion(attempt, completed.result, "settled", cleanup);
      }
      record = updateTaskAndAgent(record, attempt.task.taskId, attempt.agent.agentId, attempt.childRunId, "stopped", "stopped", now());
      await appendEvent(childTerminalEvent(
        attempt,
        "CHILD_STOPPED",
        "child_terminal_failure",
        now(),
        childFailureClass(completed.result),
        budgetEventDetails(attempt, actualUsd, actualTokens)
      ));
      if (cleanup.state !== "completed") return true;
      return await reassignTask(
        attempt.task.taskId,
        attempt.agent.agentId,
        attempt.attemptId,
        "child_terminal_failure"
      );
    }

    const integrity = await verifyChildReceipt(attempt);
    if (integrity.state !== "verified") {
      const cleanup = await cleanupWorkspace(attempt.workspace, true);
      if (cleanup.state === "completed") {
        await persistCompletion(attempt, completed.result, "settled", cleanup, integrity);
      }
      record = updateTaskAndAgent(record, attempt.task.taskId, attempt.agent.agentId, attempt.childRunId, "needs_review", "needs_review", now());
      await appendEvent(childTerminalEvent(
        attempt,
        "CHILD_NEEDS_REVIEW",
        cleanup.state === "completed" ? "receipt_not_verified" : "cleanup_pending",
        now(),
        undefined,
        budgetEventDetails(attempt, actualUsd, actualTokens)
      ));
      return true;
    }

    let candidateId: string | undefined;
    if (attempt.task.mutationMode === "write") {
      candidateId = attempt.candidateId;
      if (!candidateId) throw new Error("LIVE_CANDIDATE_ID_MISSING");
      const paths = runPaths(input.runsRoot, attempt.childRunId);
      let declaredPaths: string[];
      try {
        declaredPaths = await dependencies.inventoryCandidatePaths(attempt.workspace.path);
      } catch (error) {
        const cleanup = await cleanupWorkspace(attempt.workspace, true);
        record = updateTaskAndAgent(record, attempt.task.taskId, attempt.agent.agentId, attempt.childRunId, "needs_review", "needs_review", now());
        await appendEvent(childTerminalEvent(
          attempt,
          "CHILD_NEEDS_REVIEW",
          cleanup.state === "completed" ? "git_inventory_failed" : "cleanup_pending",
          now(),
          undefined,
          { ...budgetEventDetails(attempt, actualUsd, actualTokens), diagnostic: safeError(error) }
        ));
        return true;
      }
      const admission = await dependencies.captureCandidate({
        swarmRecord: record,
        canonicalRoot: input.workspaceManager.canonicalRoot,
        swarmId: record.swarmId,
        candidateId,
        admissionId: createId("admission"),
        attemptId: attempt.attemptId,
        proposalId: attempt.proposalId,
        childRunId: attempt.childRunId,
        agentId: attempt.agent.agentId,
        taskIds: [attempt.task.taskId],
        expectedBaselineCommit: input.plan.baselineCommit,
        workspace: attempt.workspace,
        childState: "verified",
        declaredPaths,
        childAllowedPaths: attempt.agent.contract.scope.allowedPaths,
        inheritedDeniedPaths: [...new Set([
          ...record.parentContract.scope.deniedPaths,
          ...attempt.agent.contract.scope.deniedPaths
        ])],
        taskWriteScope: attempt.task.writeScope,
        runsRoot: input.runsRoot,
        loopRecordPath: paths.loopRecord,
        ledgerPath: paths.ledger,
        artifactWriter: input.evidenceStore,
        now
      });
      if (admission.admission.state !== "admitted" || !admission.cleanupAuthorized) {
        const cleanup = admission.cleanupAuthorized
          ? await cleanupWorkspace(attempt.workspace, true)
          : undefined;
        record = updateTaskAndAgent(record, attempt.task.taskId, attempt.agent.agentId, attempt.childRunId, "needs_review", "needs_review", now());
        await appendBlockedAction({
          taskId: attempt.task.taskId,
          agentId: attempt.agent.agentId,
          childRunId: attempt.childRunId,
          attemptId: attempt.attemptId,
          action: "candidate_admission",
          reason: admission.admission.reasonCode
        });
        await appendEvent(childTerminalEvent(
          attempt,
          "CHILD_NEEDS_REVIEW",
          cleanup && cleanup.state !== "completed" ? "cleanup_pending" : admission.admission.reasonCode,
          now(),
          undefined,
          budgetEventDetails(attempt, actualUsd, actualTokens)
        ));
        return true;
      }
      candidateIds.push(candidateId);
    }
    const cleanup = await cleanupWorkspace(attempt.workspace, true, candidateId !== undefined);
    if (cleanup.state !== "completed") {
      record = updateTaskAndAgent(record, attempt.task.taskId, attempt.agent.agentId, attempt.childRunId, "needs_review", "needs_review", now());
      await appendEvent(childTerminalEvent(
        attempt,
        "CHILD_NEEDS_REVIEW",
        "cleanup_pending",
        now(),
        undefined,
        budgetEventDetails(attempt, actualUsd, actualTokens)
      ));
      return true;
    }
    await persistCompletion(attempt, completed.result, "settled", cleanup, integrity);
    record = updateTaskAndAgent(record, attempt.task.taskId, attempt.agent.agentId, attempt.childRunId, "accepted", "verified", now());
    await appendEvent({
      idempotencyKey: `${attempt.childRunId}:verified`,
      type: "CHILD_VERIFIED",
      timestamp: now(),
      taskId: attempt.task.taskId,
      agentId: attempt.agent.agentId,
      childRunId: attempt.childRunId,
      payload: {
        processCloseState: "closed",
        ...budgetEventDetails(attempt, actualUsd, actualTokens),
        cleanupState: cleanup.state,
        ...(candidateId ? { candidateId } : {})
      }
    });
    return false;
  }

  async function cleanupWorkspace(
    workspace: SwarmWorkspaceRuntimeHandle,
    evidencePersisted: boolean,
    force = false
  ): Promise<SwarmCleanupRecord> {
    let cleanup: SwarmCleanupRecord;
    try {
      cleanup = await input.workspaceManager.removeWorkspace(workspace, {
        evidencePersisted,
        processTreeClosed: true,
        ...(force ? { force: true } : {})
      });
    } catch (error) {
      cleanup = {
        schemaVersion: "martin.swarm.v1",
        cleanupId: createId("cleanup-pending"),
        swarmId: record.swarmId,
        workspaceId: workspace.record.workspaceId,
        workspaceKind: workspace.record.kind,
        evidencePersisted,
        processCloseState: "closed",
        removalState: "failed",
        state: "cleanup_pending",
        attemptedAt: now(),
        errorCode: safeErrorCode(error)
      };
    }
    try {
      await input.evidenceStore.persistCleanupEvidence(cleanup);
      return cleanup;
    } catch {
      return {
        ...cleanup,
        evidencePersisted: false,
        removalState: "failed",
        state: "cleanup_pending",
        completedAt: undefined,
        errorCode: "CLEANUP_EVIDENCE_NOT_PERSISTED"
      };
    }
  }

  async function persistProcessClosure(
    attempt: Pick<ActiveAttempt, "agent" | "childRunId" | "workspace">
  ): Promise<boolean> {
    const closure: SwarmProcessClosureEvidence = {
      swarmId: record.swarmId,
      workspaceId: attempt.workspace.record.workspaceId,
      childRunId: attempt.childRunId,
      agentId: attempt.agent.agentId,
      state: "closed",
      completedAt: now()
    };
    try {
      await input.evidenceStore.persistProcessClosure(closure);
      return true;
    } catch {
      return false;
    }
  }

  async function preserveWorkspaceForMissingEvidence(
    workspace: SwarmWorkspaceRuntimeHandle
  ): Promise<SwarmCleanupRecord> {
    const cleanup: SwarmCleanupRecord = {
      schemaVersion: "martin.swarm.v1",
      cleanupId: createId("cleanup-pending"),
      swarmId: record.swarmId,
      workspaceId: workspace.record.workspaceId,
      workspaceKind: workspace.record.kind,
      evidencePersisted: false,
      processCloseState: "closed",
      removalState: "failed",
      state: "cleanup_pending",
      attemptedAt: now(),
      errorCode: "PROCESS_CLOSURE_EVIDENCE_NOT_PERSISTED"
    };
    try {
      await input.evidenceStore.persistCleanupEvidence(cleanup);
      return cleanup;
    } catch {
      return {
        ...cleanup,
        errorCode: "CLEANUP_EVIDENCE_NOT_PERSISTED"
      };
    }
  }

  async function terminalizeMissingClosureEvidence(
    attempt: ActiveAttempt,
    usage: { readonly actualUsd: number; readonly actualTokens: number }
  ): Promise<void> {
    await preserveWorkspaceForMissingEvidence(attempt.workspace);
    record = updateTaskAndAgent(
      record,
      attempt.task.taskId,
      attempt.agent.agentId,
      attempt.childRunId,
      "needs_review",
      "needs_review",
      now()
    );
    record = withTerminal(
      record,
      "needs_review",
      "Child process-closure evidence could not be persisted; workspace retained.",
      now()
    );
    await appendEvent(childTerminalEvent(
      attempt,
      "CHILD_NEEDS_REVIEW",
      "process_closure_evidence_not_persisted",
      now(),
      "environment_mismatch",
      budgetEventDetails(attempt, usage.actualUsd, usage.actualTokens)
    )).catch(() => undefined);
  }

  async function verifyChildReceipt(attempt: ActiveAttempt): Promise<ReceiptIntegritySummary> {
    const paths = runPaths(input.runsRoot, attempt.childRunId);
    return verifyReceiptIntegrityFromFiles({
      runId: attempt.childRunId,
      runsRoot: input.runsRoot,
      loopRecordPath: paths.loopRecord,
      ledgerPath: paths.ledger
    });
  }

  function budgetEventDetails(
    attempt: Pick<ActiveAttempt, "leaseId">,
    actualUsd = 0,
    actualTokens = 0
  ): Record<string, unknown> {
    const lease = record.budgetLedger.leases.find((candidate) => candidate.leaseId === attempt.leaseId);
    return {
      leaseId: attempt.leaseId,
      leaseState: lease?.status,
      reservedUsd: lease?.reservedUsd,
      reservedTokens: lease?.reservedTokens,
      actualUsd,
      actualTokens
    };
  }

  async function persistCompletion(
    attempt: ActiveAttempt,
    result: RunMartinResult,
    leaseState: "settled" | "overspent" | "released",
    cleanup: SwarmCleanupRecord,
    preverifiedIntegrity?: ReceiptIntegritySummary
  ): Promise<void> {
    const integrity = preverifiedIntegrity ?? await verifyChildReceipt(attempt);
    const receiptId = `receipt-${attempt.childRunId}`;
    const receipt = {
      receiptId,
      swarmId: record.swarmId,
      childRunId: attempt.childRunId,
      agentId: attempt.agent.agentId,
      attemptId: attempt.attemptId,
      taskIds: [attempt.task.taskId],
      integrity,
      bindingSha256: receiptBindingSha256({
        receiptId,
        swarmId: record.swarmId,
        childRunId: attempt.childRunId,
        agentId: attempt.agent.agentId,
        attemptId: attempt.attemptId,
        taskIds: [attempt.task.taskId],
        integrity
      })
    };
    await input.evidenceStore.persistChildCompletion({
      swarmId: record.swarmId,
      childRunId: attempt.childRunId,
      agentId: attempt.agent.agentId,
      attemptId: attempt.attemptId,
      taskIds: [attempt.task.taskId],
      workspaceId: attempt.workspace.record.workspaceId,
      processCloseState: "closed",
      leaseState,
      receipt,
      evidencePersisted: true,
      workspaceCleanupState: "completed",
      cleanup
    });
    void result;
  }

  async function reassignTask(
    taskId: string,
    fromAgentId: string,
    fromAttemptId: string,
    reason: string
  ): Promise<boolean> {
    const used = reassignmentCounts.get(taskId) ?? 0;
    if (used >= record.parentContract.recoveryPolicy.maxReassignmentsPerTask) {
      record = withTerminal(record, "needs_review", `Reassignment cap reached for ${taskId}.`, now());
      return true;
    }
    const alternate = record.agents.find((agent) => (
      agent.agentId !== fromAgentId
      && agent.status === "queued"
      && agent.contract.taskIds.includes(taskId)
    ));
    if (!alternate) {
      record = withTerminal(record, "needs_review", `No eligible reassignment agent for ${taskId}.`, now());
      return true;
    }
    const toAttemptId = createId("attempt");
    preboundAttemptIds.set(taskId, toAttemptId);
    reassignmentCounts.set(taskId, used + 1);
    record = {
      ...record,
      tasks: record.tasks.map((task) => task.taskId === taskId
        ? { ...task, assignedAgentId: alternate.agentId, status: "queued" }
        : task),
      updatedAt: now()
    };
    await appendEvent({
      idempotencyKey: `${taskId}:reassigned:${used + 1}`,
      type: "TASK_REASSIGNED",
      timestamp: now(),
      taskId,
      agentId: alternate.agentId,
      payload: {
        fromAgentId,
        toAgentId: alternate.agentId,
        fromAttemptId,
        toAttemptId,
        reason,
        reassignment: used + 1
      }
    });
    return false;
  }

  async function appendBlockedAction(input: {
    taskId: string;
    agentId: string;
    childRunId?: string;
    attemptId: string;
    action: string;
    reason: string;
    details?: Record<string, unknown>;
  }): Promise<void> {
    await appendEvent({
      idempotencyKey: `${input.attemptId}:blocked:${input.action}`,
      type: "ACTION_BLOCKED",
      timestamp: now(),
      taskId: input.taskId,
      agentId: input.agentId,
      ...(input.childRunId ? { childRunId: input.childRunId } : {}),
      payload: {
        attemptId: input.attemptId,
        action: input.action,
        reason: input.reason,
        ...input.details
      }
    });
  }

  async function cancelActiveChildren(reason: "cancelled" | "child_terminal_failure"): Promise<SwarmRunRecord> {
    if (active.size === 0) {
      return record.outcome.state === "running" ? withTerminal(record, "stopped", reason, now()) : record;
    }
    const attempts = [...active.values()];
    for (const attempt of attempts) {
      if (!attempt.controller.signal.aborted) attempt.controller.abort(reason);
    }
    const completions = await Promise.all(attempts.map((attempt) => attempt.completion));
    await Promise.all(completions.map((completion) => settleAttemptOnce(completion, true)));
    return record.outcome.state === "running" ? withTerminal(record, "stopped", reason, now()) : record;
  }

  async function appendEvent(event: SwarmLiveEventInput): Promise<void> {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const snapshot = await input.liveStore.readSnapshot();
      try {
        const appended = await input.liveStore.append(event, { expectedRevision: snapshot.revision });
        const recordEvent: SwarmEvent = {
          type: appended.event.type,
          swarmId: appended.event.swarmId,
          timestamp: appended.event.timestamp,
          parentPolicyVersion: appended.event.parentPolicyVersion,
          ...(appended.event.taskId ? { taskId: appended.event.taskId } : {}),
          ...(appended.event.agentId ? { agentId: appended.event.agentId } : {}),
          ...(appended.event.childRunId ? { childRunId: appended.event.childRunId } : {}),
          ...(appended.event.failureClass ? { failureClass: appended.event.failureClass } : {}),
          payload: { ...appended.event.payload }
        };
        if (!record.events.some((candidate) => sameCanonicalSwarmEvent(candidate, recordEvent))) {
          record = { ...record, events: [...record.events, recordEvent], updatedAt: recordEvent.timestamp };
        }
        return;
      } catch (error) {
        if (!isStaleRevision(error) || parentController.signal.aborted) throw error;
      }
    }
    throw new Error("SWARM_LIVE_EVENT_CONTENTION: event revision did not settle.");
  }

  async function finalizeTerminalResult(proposed: RunLiveSwarmResult): Promise<RunLiveSwarmResult> {
    let canonical = proposed;
    let terminalEvents = (await input.liveStore.readEvents()).filter((event) => (
      event.type === "SWARM_STOPPED" || event.type === "SWARM_NEEDS_REVIEW" || event.type === "SWARM_VERIFIED"
    ));
    if (terminalEvents.length === 0) {
      if (canonical.outcome.state === "verified") {
        const rejected = withTerminal(
          canonical.record,
          "needs_review",
          "Parent verification lacked a durable terminal authority event.",
          now()
        );
        canonical = { ...canonical, record: rejected, outcome: rejected.outcome };
      } else if (canonical.outcome.state === "running") {
        const rejected = withTerminal(canonical.record, "needs_review", "Terminal outcome was incomplete.", now());
        canonical = { ...canonical, record: rejected, outcome: rejected.outcome };
      }
      const type = canonical.outcome.state === "stopped" ? "SWARM_STOPPED" : "SWARM_NEEDS_REVIEW";
      await appendEvent({
        idempotencyKey: `${input.plan.planHash}:terminal:${canonical.outcome.state}`,
        type,
        timestamp: now(),
        payload: { reason: canonical.outcome.reason }
      });
      terminalEvents = (await input.liveStore.readEvents()).filter((event) => (
        event.type === "SWARM_STOPPED" || event.type === "SWARM_NEEDS_REVIEW" || event.type === "SWARM_VERIFIED"
      ));
    }
    if (terminalEvents.length !== 1) {
      const rejected = withTerminal(canonical.record, "needs_review", "Parent terminal event cardinality is invalid.", now());
      return { ...canonical, record: rejected, outcome: rejected.outcome };
    }
    if (!dependencies.sealTerminal) {
      if (canonical.outcome.state !== "verified") return canonical;
      const rejected = withTerminal(canonical.record, "needs_review", "terminal_evidence_sealing_required", now());
      return { ...canonical, record: rejected, outcome: rejected.outcome };
    }
    try {
      await dependencies.sealTerminal(canonical);
    } catch {
      // A seal failure must never erase the primary stopped/needs-review
      // cause. VERIFIED still fails closed because no verified claim is
      // authoritative without its committed seal.
      if (canonical.outcome.state !== "verified") return canonical;
      const rejected = withTerminal(canonical.record, "needs_review", "terminal_evidence_sealing_failed", now());
      return { ...canonical, record: rejected, outcome: rejected.outcome };
    }
    if (canonical.outcome.state === "verified") authoritativeVerifiedResults.add(canonical);
    return canonical;
  }
}

function assertRuntimeInput(input: RunLiveSwarmInput): void {
  const validation = validateSwarmLivePlan(input.plan);
  if (!validation.ok) throw new Error("INVALID_LIVE_SWARM_PLAN");
  if (input.liveStore.plan.planHash !== input.plan.planHash) throw new Error("LIVE_PLAN_STORE_MISMATCH");
  if (input.workspaceManager.baselineCommit !== input.plan.baselineCommit) throw new Error("LIVE_BASELINE_MISMATCH");
}

class FileSwarmLiveRuntimeEvidenceStore implements SwarmLiveRuntimeEvidenceStore {
  constructor(private readonly root: string) {}

  async loadProcessClosure(childRunId: string): Promise<SwarmProcessClosureEvidence | undefined> {
    return this.readJson<SwarmProcessClosureEvidence>("process-closures", childRunId);
  }

  async persistProcessClosure(evidence: SwarmProcessClosureEvidence): Promise<void> {
    await this.writeJson("process-closures", evidence.childRunId, evidence);
  }

  async persistCandidate(artifact: PersistedSwarmCandidateArtifact): Promise<void> {
    const path = await this.resolvePath("candidates", artifact.candidate.candidateId);
    const payload = JSON.stringify({
      ...artifact,
      patch: artifact.patch.toString("base64"),
      manifest: artifact.manifest.toString("base64"),
    });
    await writeExclusive(path, payload);
  }

  async loadPersistedCandidate(candidateId: string): Promise<PersistedSwarmCandidateArtifact | undefined> {
    const stored = await this.readJson<Record<string, unknown>>("candidates", candidateId);
    if (!stored) return undefined;
    return {
      ...(stored as unknown as PersistedSwarmCandidateArtifact),
      patch: Buffer.from(String(stored.patch ?? ""), "base64"),
      manifest: Buffer.from(String(stored.manifest ?? ""), "base64"),
    };
  }

  async persistDecision(decision: SwarmPatchAdmission): Promise<void> {
    await this.writeJson("decisions", decision.candidateId, decision);
  }

  async loadPersistedAdmission(candidateId: string): Promise<SwarmPatchAdmission | undefined> {
    const integrated = await this.readJson<SwarmIntegrationEvidenceBundle>("integration-outcomes", candidateId);
    if (integrated !== undefined) return integrated.decision;
    return this.readJson<SwarmPatchAdmission>("decisions", candidateId);
  }

  async claimCandidateIntegration(input: {
    swarmId: string;
    candidateId: string;
    identitySha256: string;
  }): Promise<"claimed" | "already_claimed"> {
    const path = await this.resolvePath("integration-claims", `${input.swarmId}:${input.candidateId}`);
    try {
      await writeExclusive(path, JSON.stringify(input));
      return "claimed";
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return "already_claimed";
      throw error;
    }
  }

  async persistOutcome(bundle: SwarmIntegrationEvidenceBundle): Promise<void> {
    await this.writeJson("integration-outcomes", bundle.decision.candidateId, bundle);
  }

  async persistReconstruction(record: SwarmIntegrationReconstruction): Promise<void> {
    await this.writeJson("integration-reconstructions", record.reconstructionId, record);
  }

  async persistGlobalVerification(evidence: SwarmGlobalVerification): Promise<void> {
    await this.writeJson("global-verification", evidence.verificationId, evidence);
  }

  async persistChildCompletion(evidence: PersistedSwarmChildCompletionEvidence): Promise<void> {
    await this.writeJson("child-completions", evidence.childRunId, evidence);
  }

  async loadPersistedChildCompletion(
    childRunId: string
  ): Promise<PersistedSwarmChildCompletionEvidence | undefined> {
    return this.readJson<PersistedSwarmChildCompletionEvidence>("child-completions", childRunId);
  }

  async persistWorkspaceFailureEvidence(evidence: import("./index.js").SwarmPipelineWorkspaceFailureEvidence): Promise<void> {
    await this.writeJson("workspace-failures", evidence.failureId, evidence);
  }

  async persistCleanupEvidence(cleanup: SwarmCleanupRecord): Promise<void> {
    await this.writeJson("cleanup", cleanup.cleanupId, cleanup);
  }

  async persistTerminalRecord(record: SwarmRunRecord): Promise<void> {
    await this.writeJson("terminal", record.swarmId, record);
  }

  async persistBeforeCleanup(evidence: SwarmLifecyclePreCleanupEvidence): Promise<void> {
    await this.writeJson("pre-cleanup", evidence.terminal.childRunId, evidence);
  }

  private async writeJson(directory: string, id: string, value: unknown): Promise<void> {
    const path = await this.resolvePath(directory, id);
    await writeExclusiveIdempotent(path, JSON.stringify(value, null, 2));
  }

  private async readJson<T>(directory: string, id: string): Promise<T | undefined> {
    const path = await this.resolvePath(directory, id);
    try {
      return JSON.parse(await readFile(path, "utf8")) as T;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  private async resolvePath(directory: string, id: string): Promise<string> {
    const targetDirectory = join(this.root, directory);
    await mkdir(targetDirectory, { recursive: true });
    return join(targetDirectory, `${createHash("sha256").update(id).digest("hex")}.json`);
  }
}

async function writeExclusive(path: string, contents: string): Promise<void> {
  const handle = await open(path, "wx");
  try {
    await handle.writeFile(contents, "utf8");
  } finally {
    await handle.close();
  }
}

async function writeExclusiveIdempotent(path: string, contents: string): Promise<void> {
  const existing = await lstat(path).catch((error: unknown) => {
    if (isNodeError(error, "ENOENT")) return undefined;
    throw error;
  });
  if (existing?.isSymbolicLink() || (existing && !existing.isFile())) {
    throw codedRuntimeError("SWARM_SEAL_PATH_ALIAS", "Immutable evidence output path is not an exact regular file.");
  }
  try {
    await writeExclusive(path, contents);
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  if (await readFile(path, "utf8") === contents) return;
  throw Object.assign(new Error("Evidence identity already contains different immutable bytes."), {
    code: "SWARM_EVIDENCE_IDENTITY_CONFLICT",
  });
}

function updateTaskAndAgent(
  record: SwarmRunRecord,
  taskId: string,
  agentId: string,
  childRunId: string,
  taskStatus: SwarmTaskNode["status"],
  agentStatus: SwarmAgentRecord["status"],
  updatedAt: string
): SwarmRunRecord {
  return {
    ...record,
    tasks: record.tasks.map((task) => task.taskId === taskId ? { ...task, status: taskStatus, assignedAgentId: agentId } : task),
    agents: record.agents.map((agent) => agent.agentId === agentId ? { ...agent, status: agentStatus, childRunId } : agent),
    updatedAt
  };
}

function childTerminalEvent(
  attempt: Pick<ActiveAttempt, "task" | "agent" | "childRunId" | "attemptId">,
  type: "CHILD_STOPPED" | "CHILD_NEEDS_REVIEW",
  reason: string,
  timestamp: string,
  failureClass?: FailureClass,
  details: Record<string, unknown> = {}
): SwarmLiveEventInput {
  return {
    idempotencyKey: `${attempt.childRunId}:${type.toLowerCase()}`,
    type,
    timestamp,
    taskId: attempt.task.taskId,
    agentId: attempt.agent.agentId,
    childRunId: attempt.childRunId,
    ...(failureClass ? { failureClass } : {}),
    payload: { reason, ...(failureClass ? { failureClass } : {}), ...details, attemptId: attempt.attemptId }
  };
}

function withTerminal(
  record: SwarmRunRecord,
  state: "stopped" | "needs_review",
  reason: string,
  updatedAt: string
): SwarmRunRecord {
  return { ...record, outcome: { state, reason }, updatedAt };
}

function terminalResult(
  record: SwarmRunRecord,
  candidateIds: readonly string[],
  state: "stopped" | "needs_review",
  reason: string
): RunLiveSwarmResult {
  const finalRecord = withTerminal(record, state, reason, record.updatedAt);
  return { record: finalRecord, outcome: finalRecord.outcome, candidateIds: Object.freeze([...candidateIds]) };
}

function runPaths(runsRoot: string, childRunId: string): { loopRecord: string; ledger: string } {
  const directory = runDir(runsRoot, childRunId);
  return { loopRecord: join(directory, "loop-record.json"), ledger: join(directory, "ledger.jsonl") };
}

function receiptBindingSha256(
  input: Omit<PersistedSwarmChildCompletionEvidence["receipt"], "bindingSha256">
): string {
  return createHash("sha256").update(JSON.stringify({
    receiptId: input.receiptId,
    swarmId: input.swarmId,
    childRunId: input.childRunId,
    agentId: input.agentId,
    attemptId: input.attemptId,
    taskIds: [...input.taskIds].sort(),
    integrity: {
      state: input.integrity.state,
      keyId: input.integrity.keyId,
      loopRecordSha256: input.integrity.loopRecordSha256,
      ledgerSha256: input.integrity.ledgerSha256,
      ledgerHeadHash: input.integrity.ledgerHeadHash
    }
  }), "utf8").digest("hex");
}

function childIdFactory(childRunId: string, createId: (prefix: string) => string): (prefix: string) => string {
  let issuedLoop = false;
  return (prefix) => {
    if (prefix === "loop" && !issuedLoop) {
      issuedLoop = true;
      return childRunId;
    }
    return createId(prefix);
  };
}

function isAdapterHandle(value: MartinAdapter | SwarmChildAdapterHandle): value is SwarmChildAdapterHandle {
  return typeof value === "object" && value !== null && "adapter" in value;
}

function isStaleRevision(error: unknown): boolean {
  return (typeof error === "object" && error !== null && "code" in error && error.code === "STALE_REVISION")
    || (error instanceof Error && error.message.includes("STALE_REVISION"));
}

/** Internal production identity seam; intentionally not exported from the Core root. */
export function sameCanonicalSwarmEvent(left: SwarmEvent, right: SwarmEvent): boolean {
  const leftFailureClass = (left as SwarmEvent & { failureClass?: FailureClass }).failureClass;
  const rightFailureClass = (right as SwarmEvent & { failureClass?: FailureClass }).failureClass;
  return left.type === right.type
    && left.swarmId === right.swarmId
    && left.parentPolicyVersion === right.parentPolicyVersion
    && left.taskId === right.taskId
    && left.agentId === right.agentId
    && left.childRunId === right.childRunId
    && left.timestamp === right.timestamp
    && leftFailureClass === rightFailureClass
    && JSON.stringify(left.payload) === JSON.stringify(right.payload);
}

function safeError(error: unknown): string {
  return redactSecretsFromText(error instanceof Error ? error.message : String(error));
}

function safeErrorCode(error: unknown): string {
  if (error instanceof Error && "code" in error) {
    const code = String((error as Error & { code?: unknown }).code ?? "WORKSPACE_CLEANUP_FAILED");
    return redactSecretsFromText(code).slice(0, 96);
  }
  return "WORKSPACE_CLEANUP_FAILED";
}

function childFailureClass(result: RunMartinResult): FailureClass | undefined {
  return result.decision.failureClass ?? result.loop.attempts.at(-1)?.failureClass;
}
