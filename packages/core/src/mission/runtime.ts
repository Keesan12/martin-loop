import { createHash } from "node:crypto";
import { mkdir, open, readFile, rename } from "node:fs/promises";
import { join } from "node:path";
import type { ContextHandoffReceipt } from "@martin/contracts";

import { verifyContextHandoff } from "../context-handoff.js";
import { createCheckpointStore, type CheckpointStore } from "../persistence/checkpoint-store.js";
import {
  memoryApprovalActionSourceHashV2,
  MemoryStoreV2,
  type MemoryApprovalAuthorityV2,
  type MemoryApprovalReceiptV2,
  type MemoryRecordV2,
  type MemoryStoreV2Options
} from "../persistence/memory-store-v2.js";
import type { MissionIntegrationAdapter } from "./integration.js";
import { assertSafeMissionPath } from "./path-safety.js";
import type { MissionPlan, MissionProviderPolicy } from "./planner.js";
import { classifyMissionRecovery } from "./recovery.js";
import {
  buildMorningDossier,
  createMissionSupervisor,
  evaluateMissionStop,
  getProgressSnapshot,
  type MissionBudgetSnapshot,
  type MissionSupervisor,
  type MissionSupervisorState,
  type MissionWorkItem
} from "./supervisor.js";
import {
  createReadyDagQueue,
  hashMissionWorkQueue,
  refreshReadyDagQueue,
  type MissionQueueEntry
} from "./work-queue.js";

export type { MissionIntegrationAdapter } from "./integration.js";
export type { MissionPlan, MissionProviderPolicy } from "./planner.js";
export type { MissionQueueEntry, MissionQueuePhase } from "./work-queue.js";

export interface MissionChildRunInput {
  missionId: string;
  workItemId: string;
  runId: string;
  idempotencyKey: string;
  provider: string;
  budget: { maxUsd: number; maxTokens: number };
  context: { manifestHash: string; summary?: string };
}

export interface MissionChildCandidate {
  kind: "candidate";
  runId: string;
  receiptHash: string;
  candidateHash: string;
  actualUsd: number;
  tokens: number;
  handoff: {
    manifestHash: string;
    summary: string;
    tokenCount: number;
    receipt: ContextHandoffReceipt;
    producerReceiptVerified: boolean;
    availableArtifactHashes: string[];
  };
}

export interface MissionChildFailure {
  kind: "failed";
  runId: string;
  receiptHash: string;
  actualUsd: number;
  tokens: number;
  code: "provider_failure" | "scope_violation" | "host_failure" | "policy_blocked" | "budget_exhausted";
  message: string;
}

export type MissionChildRunResult = MissionChildCandidate | MissionChildFailure;
export interface MissionChildRunAdapter {
  launch(input: MissionChildRunInput): Promise<MissionChildRunResult>;
  recover(input: MissionChildRunInput): Promise<MissionChildRunResult | null>;
}

export interface MissionVerificationResult {
  passed: boolean;
  verifierId: string;
  evidenceHash: string;
  source: string;
  reason?: string;
}
export interface MissionVerificationAdapter {
  verify(input: {
    missionId: string;
    workItemId: string;
    runId: string;
    candidateHash: string;
    receiptHash: string;
  }): Promise<MissionVerificationResult>;
}

export type MissionRuntimeBlockerCode =
  | "child_recovery_unavailable" | "integration_recovery_unavailable" | "verifier_rejected"
  | "provider_failure" | "scope_violation" | "host_failure" | "policy_blocked" | "corrupt_state"
  | "operator_pause" | "operator_cancel"
  | "budget_exhausted" | "wall_clock_exhausted" | "no_progress" | "no_runnable_work" | "concurrency_exhausted";
export interface MissionRuntimeBlocker {
  code: MissionRuntimeBlockerCode;
  workItemId: string;
  message: string;
  at: string;
}

export interface MissionFailedCandidate {
  workItemId: string;
  runId: string;
  candidateHash: string;
  receiptHash: string;
  verifierEvidenceHash: string;
  reason: string;
  retainedAt: string;
}

export interface MissionRuntimeState {
  schemaVersion: "martin.mission-runtime.v1";
  missionId: string;
  objective: string;
  createdAt: string;
  updatedAt: string;
  sequence: number;
  bindings: {
    sourceSha: string;
    workspaceId: string;
    workspaceIdentityHash: string;
    missionLedgerHeadHash: string;
    workQueueHash: string;
    contextManifestHash: string;
    memoryLedgerHeadHash: string | null;
    memorySnapshotHash: string | null;
  };
  context: { manifestHash: string; tokenCount: number; compactAtTokens: number; summary?: string };
  providerPolicy: MissionProviderPolicy;
  queue: MissionQueueEntry[];
  candidates: Record<string, MissionChildCandidate>;
  verifications: Record<string, MissionVerificationResult>;
  failedCandidates: MissionFailedCandidate[];
  blockers: MissionRuntimeBlocker[];
  settlement: { budget: MissionBudgetSnapshot; settlementIds: string[] };
}

export interface MissionRuntime {
  initialize(plan: MissionPlan): Promise<MissionRuntimeState>;
  load(): Promise<MissionRuntimeState | null>;
  step(options?: { stopAfter?: "launch-intent" | "recovery-rebind" | "failed-settlement" | "settlement" | "integration-intent" }): Promise<MissionRuntimeState>;
  runUntilBlocked(): Promise<MissionRuntimeState>;
  morningDossier(): Promise<MissionRuntimeMorningDossier>;
}

export interface MissionRuntimeMorningDossier {
  schemaVersion: "martin.mission-runtime-dossier.v1";
  state: MissionRuntimeState;
  supervisor: ReturnType<typeof buildMorningDossier>;
}

export interface MissionHostApprovalReceipt {
  schemaVersion: "martin.host-approval.v1";
  approvalId: string;
  missionId: string;
  action: "pause" | "cancel";
  actorId: string;
  issuedAt: string;
  expiresAt: string;
  signature: string;
}
export interface MissionHostApprovalAuthority {
  authorityId: string;
  verify(receipt: MissionHostApprovalReceipt): boolean;
}
export interface MissionRuntimeBindingAuthority {
  authorityId: string;
  verify(binding: Pick<MissionRuntimeState["bindings"], "sourceSha" | "workspaceId" | "workspaceIdentityHash">): Promise<boolean>;
}
export interface MissionControlIntent {
  schemaVersion: "martin.mission-control-intent.v1";
  intentId: string;
  missionId: string;
  action: "pause" | "cancel";
  reason: string;
  requestedAt: string;
  approval: MissionHostApprovalReceipt;
  verifiedBy: string;
}
export interface MissionControlIntentInput {
  intentId: string;
  action: "pause" | "cancel";
  reason: string;
  requestedAt: string;
  approval: MissionHostApprovalReceipt;
}

export type MissionMemoryCandidateStatus = "candidate" | "active" | "revoked" | "expired";
export interface MissionMemoryCandidateClassification {
  record: MemoryRecordV2;
  status: MissionMemoryCandidateStatus;
}

export function createMissionRuntime(options: {
  root: string;
  missionId: string;
  childRuns: MissionChildRunAdapter;
  verifier: MissionVerificationAdapter;
  integrator: MissionIntegrationAdapter;
  bindingAuthority: MissionRuntimeBindingAuthority;
  controlAuthority?: MissionHostApprovalAuthority;
  now?: () => string;
}): MissionRuntime {
  const missionRoot = assertSafeMissionPath(options.root, options.missionId);
  const now = options.now ?? (() => new Date().toISOString());
  const runtimeStore: CheckpointStore<MissionRuntimeState> = createCheckpointStore({
    root: join(missionRoot, "runtime"), maxArrayEntries: 1_000
  });
  const supervisorStore: CheckpointStore<MissionSupervisorState> = createCheckpointStore({
    root: join(missionRoot, "state"), maxArrayEntries: 1_000
  });
  const supervisor = createMissionSupervisor({ root: options.root, missionId: options.missionId, maxArrayEntries: 1_000 });

  async function verifyMemoryBindings(expectedHead: string | null, expectedSnapshot: string | null): Promise<boolean> {
    const memory = new MemoryStoreV2(options.root);
    let records: MemoryRecordV2[];
    try { records = await memory.readAll(); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT" || (error as { code?: string }).code === "not_found") {
        return expectedHead === null && expectedSnapshot === null;
      }
      throw error;
    }
    if ((records.at(-1)?.entryHash ?? null) !== expectedHead) return false;
    if (expectedSnapshot === null) return true;
    const raw = await readFile(memory.paths.compaction, "utf8").catch(() => null);
    if (raw === null) return false;
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const claimed = parsed.snapshotHash;
    delete parsed.snapshotHash;
    if (claimed !== expectedSnapshot || canonicalHash(parsed) !== expectedSnapshot) return false;
    const sourceHeadHash = typeof parsed.sourceHeadHash === "string" ? parsed.sourceHeadHash : null;
    return sourceHeadHash === null || records.some((record) => record.entryHash === sourceHeadHash);
  }

  async function loadEnvelope() {
    assertSafeMissionPath(options.root, options.missionId);
    return await runtimeStore.loadHead();
  }
  async function persist(
    state: MissionRuntimeState,
    expectedHeadHash: string,
    authorizedSupervisorHeadHash: string
  ): Promise<MissionRuntimeState> {
    assertSafeMissionPath(options.root, options.missionId);
    const supervisorHead = await requiredSupervisorHead();
    if (supervisorHead.hash !== authorizedSupervisorHeadHash) {
      throw new Error("supervisor head changed after runtime authorization");
    }
    const queue = refreshReadyDagQueue(state.queue, supervisorHead.state.workItems);
    const next: MissionRuntimeState = {
      ...state,
      updatedAt: now(),
      sequence: state.sequence + 1,
      queue,
      bindings: {
        ...state.bindings,
        missionLedgerHeadHash: supervisorHead.hash,
        workQueueHash: hashMissionWorkQueue(queue),
        contextManifestHash: state.context.manifestHash
      },
      settlement: {
        budget: structuredClone(supervisorHead.state.budget),
        settlementIds: supervisorHead.state.settlements.map((item) => item.settlementId)
      }
    };
    const appended = await runtimeStore.append(next, {
      checkpointId: `runtime-${String(next.sequence).padStart(8, "0")}`,
      writerId: "mission-runtime",
      expectedHeadHash,
      now: next.updatedAt
    });
    return appended.checkpoint.state;
  }
  async function requiredSupervisorHead() {
    assertSafeMissionPath(options.root, options.missionId);
    const head = await supervisorStore.loadHead();
    if (head === null) throw new Error("mission supervisor is not initialized");
    return head;
  }
  async function withLease<T>(operation: (leaseToken: string) => Promise<T>): Promise<T> {
    const lease = await supervisor.acquireLease({ holderId: "mission-runtime", ttlMs: 60_000, now: now() });
    try { return await operation(lease.token); } finally { await supervisor.releaseLease(lease.token); }
  }
  const runInput = (state: MissionRuntimeState, entry: MissionQueueEntry): MissionChildRunInput => ({
    missionId: state.missionId,
    workItemId: entry.workItemId,
    runId: entry.childRunId!,
    idempotencyKey: entry.launchKey!,
    provider: entry.selectedProvider ?? state.providerPolicy.primary,
    budget: {
      maxUsd: Math.max(0, state.settlement.budget.maxUsd - state.settlement.budget.spentUsd),
      maxTokens: Math.max(0, state.settlement.budget.maxTokens - state.settlement.budget.tokensUsed)
    },
    context: { manifestHash: state.context.manifestHash, ...(state.context.summary ? { summary: state.context.summary } : {}) }
  });

  async function initialize(plan: MissionPlan): Promise<MissionRuntimeState> {
    assertSafeMissionPath(options.root, options.missionId);
    assertHash(plan.sourceSha, "sourceSha");
    assertHash(plan.workspace.identityHash, "workspace identityHash");
    assertHash(plan.context.manifestHash, "context manifestHash");
    if (plan.memory.ledgerHeadHash !== null) assertHash(plan.memory.ledgerHeadHash, "memory ledgerHeadHash");
    if (plan.memory.snapshotHash !== null) assertHash(plan.memory.snapshotHash, "memory snapshotHash");
    if (!await options.bindingAuthority.verify({
      sourceSha: plan.sourceSha, workspaceId: plan.workspace.workspaceId,
      workspaceIdentityHash: plan.workspace.identityHash
    })) throw new Error("source/workspace binding authority rejected the mission plan");
    // If a memory ledger exists, bind only to its verified head. Approval authority remains injected into that store.
    if (!await verifyMemoryBindings(plan.memory.ledgerHeadHash, plan.memory.snapshotHash)) {
      throw new Error("memory ledger head binding does not match verified memory state");
    }
    const createdAt = plan.now ?? now();
    const workItems: MissionWorkItem[] = plan.workItems.map((item) => ({
      id: item.id, title: item.title, dependsOn: [...item.dependsOn], status: "pending", attempts: 0,
      maxAttempts: item.maxAttempts, updatedAt: createdAt
    }));
    const initialized = await supervisor.initialize({
      objective: plan.objective, workItems, budget: plan.budget, checkpointId: "supervisor-00000000",
      writerId: plan.writerId, now: createdAt
    });
    const queue = createReadyDagQueue(initialized.state.workItems);
    const state: MissionRuntimeState = {
      schemaVersion: "martin.mission-runtime.v1", missionId: options.missionId, objective: plan.objective,
      createdAt, updatedAt: createdAt, sequence: 0,
      bindings: {
        sourceSha: plan.sourceSha, workspaceId: plan.workspace.workspaceId,
        workspaceIdentityHash: plan.workspace.identityHash, missionLedgerHeadHash: initialized.checkpointHash,
        workQueueHash: hashMissionWorkQueue(queue), contextManifestHash: plan.context.manifestHash,
        memoryLedgerHeadHash: plan.memory.ledgerHeadHash, memorySnapshotHash: plan.memory.snapshotHash
      },
      context: { ...plan.context },
      providerPolicy: plan.providerPolicy ?? { primary: "default", allowFallback: false },
      queue, candidates: {}, verifications: {}, failedCandidates: [], blockers: [],
      settlement: { budget: initialized.state.budget, settlementIds: [] }
    };
    const appended = await runtimeStore.append(state, {
      checkpointId: "runtime-00000000", writerId: plan.writerId, expectedHeadHash: null, now: createdAt
    });
    return appended.checkpoint.state;
  }

  async function step(stepOptions: { stopAfter?: "launch-intent" | "recovery-rebind" | "failed-settlement" | "settlement" | "integration-intent" } = {}): Promise<MissionRuntimeState> {
    let envelope = await loadEnvelope();
    if (envelope === null) throw new Error("mission runtime is not initialized");
    let state = envelope.state;
    let supervisorAtStart = await requiredSupervisorHead();
    const activeAtStart = state.queue.find((item) => !["integrated", "failed", "blocked", "waiting"].includes(item.phase));
    const supervisorItemAtStart = activeAtStart === undefined
      ? undefined
      : supervisorAtStart.state.workItems.find((item) => item.id === activeAtStart.workItemId);
    const candidateAtStart = state.queue.find((item) => ["candidate", "verifying"].includes(item.phase));
    const candidateEvidenceAtStart = candidateAtStart === undefined ? undefined : state.candidates[candidateAtStart.workItemId];
    const expectedSettlementId = candidateEvidenceAtStart === undefined ? undefined
      : stableId("settlement", state.missionId, candidateAtStart!.workItemId, candidateEvidenceAtStart.runId);
    const directSupervisorAdvance = supervisorAtStart.parentHash === state.bindings.missionLedgerHeadHash;
    const supervisorAheadBySettlement = directSupervisorAdvance
      && expectedSettlementId !== undefined
      && supervisorAtStart.checkpointId === stableId("supervisor-settlement", state.bindings.missionLedgerHeadHash, expectedSettlementId)
      && supervisorAtStart.state.settlements.length === state.settlement.settlementIds.length + 1
      && supervisorAtStart.state.settlements.some(
      (settlement) => settlement.settlementId === expectedSettlementId
        && settlement.runId === candidateEvidenceAtStart!.runId
        && settlement.receiptHash === candidateEvidenceAtStart!.receiptHash
    );
    const expectedStartRunId = activeAtStart?.phase === "ready" && supervisorItemAtStart !== undefined
      ? stableId("run", state.missionId, activeAtStart.workItemId, String(supervisorItemAtStart.attempts))
      : undefined;
    const supervisorAheadByStart = directSupervisorAdvance
      && activeAtStart?.phase === "ready"
      && expectedStartRunId !== undefined
      && supervisorAtStart.checkpointId === stableId(
        "supervisor-start", state.bindings.missionLedgerHeadHash, activeAtStart.workItemId, expectedStartRunId
      )
      && supervisorItemAtStart?.status === "running"
      && supervisorItemAtStart.attempts > 0
      && supervisorItemAtStart.lastTransition?.from === "pending"
      && supervisorItemAtStart.lastTransition.to === "running"
      && supervisorItemAtStart.lastTransition.actorId === "mission-runtime"
      && supervisorItemAtStart.lastTransition.actorRole === "supervisor"
      && state.settlement.settlementIds.length === supervisorAtStart.state.settlements.length;
    const supervisorAheadByCandidate = directSupervisorAdvance
      && activeAtStart?.phase === "launching"
      && activeAtStart.childRunId !== undefined
      && supervisorAtStart.checkpointId === stableId(
        "supervisor-candidate", state.bindings.missionLedgerHeadHash, activeAtStart.workItemId, activeAtStart.childRunId
      )
      && supervisorItemAtStart?.status === "succeeded"
      && supervisorItemAtStart.lastTransition?.from === "running"
      && supervisorItemAtStart.lastTransition.to === "succeeded"
      && supervisorItemAtStart.lastTransition.actorId === "child-run-adapter"
      && supervisorItemAtStart.lastTransition.actorRole === "executor"
      && supervisorItemAtStart.lastTransition.evidenceSource === `child:${activeAtStart.childRunId}`
      && supervisorAtStart.state.settlements.length === state.settlement.settlementIds.length;
    const expectedFailedSettlementId = activeAtStart?.phase === "launching" && activeAtStart.childRunId !== undefined
      ? stableId("settlement-failed", state.missionId, activeAtStart.workItemId, activeAtStart.childRunId)
      : undefined;
    const failedSettlementAtStart = expectedFailedSettlementId === undefined
      ? undefined
      : supervisorAtStart.state.settlements.find((settlement) =>
          settlement.settlementId === expectedFailedSettlementId
          && settlement.runId === activeAtStart!.childRunId
          && settlement.workItemId === activeAtStart!.workItemId
          && settlement.verifier.passed === false
          && settlement.verifier.verifierId === "child-run-adapter"
          && settlement.verifier.evidenceHash === settlement.receiptHash
          && settlement.verifier.source === `child:${activeAtStart!.childRunId}`
        );
    const supervisorAheadByFailedSettlement = directSupervisorAdvance
      && failedSettlementAtStart !== undefined
      && supervisorAtStart.checkpointId === stableId(
        "supervisor-failed-settlement", state.bindings.missionLedgerHeadHash, failedSettlementAtStart.settlementId
      )
      && supervisorItemAtStart?.status === "running"
      && supervisorAtStart.state.settlements.length === state.settlement.settlementIds.length + 1
      && state.settlement.settlementIds.every((settlementId) =>
        supervisorAtStart.state.settlements.some((settlement) => settlement.settlementId === settlementId)
      );
    const terminalSettlementAtStart = expectedFailedSettlementId === undefined
      ? undefined
      : supervisorAtStart.state.settlements.find((settlement) =>
          settlement.settlementId === expectedFailedSettlementId
          && settlement.runId === activeAtStart!.childRunId
          && settlement.workItemId === activeAtStart!.workItemId
          && settlement.verifier.passed === false
          && settlement.verifier.verifierId === "child-run-adapter"
          && settlement.verifier.evidenceHash === settlement.receiptHash
          && settlement.verifier.source === `child:${activeAtStart!.childRunId}`
        );
    const supervisorAheadByTerminal = directSupervisorAdvance
      && terminalSettlementAtStart !== undefined
      && activeAtStart?.childRunId !== undefined
      && supervisorAtStart.checkpointId === stableId(
        "supervisor-fail", state.bindings.missionLedgerHeadHash, activeAtStart.workItemId, activeAtStart.childRunId
      )
      && state.settlement.settlementIds.includes(terminalSettlementAtStart.settlementId)
      && supervisorAtStart.state.settlements.length === state.settlement.settlementIds.length
      && (supervisorItemAtStart?.status === "failed" || supervisorItemAtStart?.status === "blocked")
      && supervisorItemAtStart.lastTransition?.evidenceHash === terminalSettlementAtStart.receiptHash
      && supervisorItemAtStart.lastTransition.evidenceSource === `child:${activeAtStart!.childRunId}`
      && ((supervisorItemAtStart.status === "failed"
        && supervisorItemAtStart.lastTransition.from === "running"
        && supervisorItemAtStart.lastTransition.actorId === "child-run-adapter"
        && supervisorItemAtStart.lastTransition.actorRole === "executor")
        || (supervisorItemAtStart.status === "blocked"
          && supervisorItemAtStart.lastTransition.from === "succeeded"
          && supervisorItemAtStart.lastTransition.actorId === "mission-runtime"
          && supervisorItemAtStart.lastTransition.actorRole === "supervisor"));
    const nonLedgerBindingsInvalid = hashMissionWorkQueue(state.queue) !== state.bindings.workQueueHash
      || state.context.manifestHash !== state.bindings.contextManifestHash
      || !await options.bindingAuthority.verify({
        sourceSha: state.bindings.sourceSha, workspaceId: state.bindings.workspaceId,
        workspaceIdentityHash: state.bindings.workspaceIdentityHash
      })
      || !await verifyMemoryBindings(state.bindings.memoryLedgerHeadHash, state.bindings.memorySnapshotHash);
    const ledgerMismatch = supervisorAtStart.hash !== state.bindings.missionLedgerHeadHash;
    const candidateAheadAtStart = ledgerMismatch && supervisorAheadByCandidate;
    const failedSettlementAheadAtStart = ledgerMismatch && supervisorAheadByFailedSettlement;
    const terminalAheadAtStart = ledgerMismatch && supervisorAheadByTerminal;
    if (nonLedgerBindingsInvalid
      || (ledgerMismatch && !supervisorAheadBySettlement && !supervisorAheadByStart
        && !supervisorAheadByCandidate && !supervisorAheadByFailedSettlement && !supervisorAheadByTerminal)) {
      const workItemId = state.blockers.find((blocker) => blocker.code === "corrupt_state")?.workItemId
        ?? state.queue.find((item) => !["integrated", "failed", "blocked"].includes(item.phase))?.workItemId
        ?? "mission";
      return await addBlocker(state, envelope.hash, workItemId, "corrupt_state", "mission checkpoint bindings failed revalidation",
        state.bindings.missionLedgerHeadHash);
    }
    if (ledgerMismatch && supervisorAheadByStart && activeAtStart !== undefined && supervisorItemAtStart !== undefined) {
      const runId = stableId("run", state.missionId, activeAtStart.workItemId, String(supervisorItemAtStart.attempts));
      const launchKey = stableId("launch", state.missionId, activeAtStart.workItemId, runId);
      state = {
        ...state,
        queue: state.queue.map((item) => item.workItemId === activeAtStart.workItemId
          ? { ...item, phase: "launching", childRunId: runId, launchKey, selectedProvider: state.providerPolicy.primary }
          : item)
      };
      state = await persist(state, envelope.hash, supervisorAtStart.hash);
      envelope = (await loadEnvelope())!;
      supervisorAtStart = await requiredSupervisorHead();
    }
    const control = await readMissionRuntimeControlIntent(options.root, options.missionId);
    if (control !== null && (options.controlAuthority === undefined
      || control.schemaVersion !== "martin.mission-control-intent.v1"
      || control.missionId !== options.missionId
      || control.approval.missionId !== options.missionId
      || control.approval.action !== control.action
      || control.verifiedBy !== options.controlAuthority.authorityId
      || !Number.isFinite(Date.parse(control.requestedAt))
      || Date.parse(control.approval.expiresAt) <= Date.parse(now())
      || !options.controlAuthority.verify(control.approval))) {
      const workItemId = state.queue.find((item) => !["integrated", "failed", "blocked"].includes(item.phase))?.workItemId ?? "mission";
      return await addBlocker(state, envelope.hash, workItemId, "corrupt_state", "mission control intent failed host-authority revalidation",
        state.bindings.missionLedgerHeadHash);
    }
    if (control !== null && !state.blockers.some((blocker) => blocker.code === `operator_${control.action}`)) {
      const code = `operator_${control.action}` as "operator_pause" | "operator_cancel";
      const workItemId = state.queue.find((item) => !["integrated", "failed", "blocked"].includes(item.phase))?.workItemId ?? "mission";
      state = { ...state,
        blockers: [...state.blockers, { code, workItemId, message: control.reason, at: control.requestedAt }],
        queue: state.queue.map((item) => {
          if (["integrated", "failed"].includes(item.phase)) return item;
          const { recoveryAuthority: _recoveryAuthority, ...resolved } = item;
          return { ...resolved, phase: "blocked" as const };
        }) };
      return await persist(state, envelope.hash, state.bindings.missionLedgerHeadHash);
    }
    let entry = state.queue.find((item) => ["launching", "candidate", "verifying", "integrating"].includes(item.phase))
      ?? state.queue.find((item) => item.phase === "ready");
    if (entry === undefined) return state;
    let justCreatedLaunch = false;
    if (entry.phase === "ready") {
      const supervisorHead = await requiredSupervisorHead();
      const stop = evaluateMissionStop(supervisorHead.state, now());
      if (stop !== null && stop.code !== "completed") {
        const code: MissionRuntimeBlockerCode = ["budget_exhausted", "wall_clock_exhausted", "no_progress", "no_runnable_work"].includes(stop.code)
          ? stop.code as MissionRuntimeBlockerCode : "policy_blocked";
        return await addBlocker(state, envelope.hash, entry.workItemId, code, stop.message, supervisorHead.hash);
      }
      const progress = getProgressSnapshot(supervisorHead.state);
      const running = supervisorHead.state.workItems.filter((item) => item.status === "running").length;
      if (!progress.runnableWorkItemIds.includes(entry.workItemId)) {
        return await addBlocker(state, envelope.hash, entry.workItemId, "policy_blocked", "work item is not supervisor-runnable", supervisorHead.hash);
      }
      if (running >= supervisorHead.state.budget.maxConcurrency) {
        return await addBlocker(state, envelope.hash, entry.workItemId, "concurrency_exhausted", "mission concurrency budget is exhausted", supervisorHead.hash);
      }
      const runId = stableId("run", state.missionId, entry.workItemId, String(await attemptOf(entry.workItemId) + 1));
      const launchKey = stableId("launch", state.missionId, entry.workItemId, runId);
      const started = await withLease(async (leaseToken) => {
        const head = await requiredSupervisorHead();
        return await supervisor.transitionWorkItem({ workItemId: entry!.workItemId, to: "running", actor: { id: "mission-runtime", role: "supervisor" }, at: now() },
          { checkpointId: stableId("supervisor-start", head.hash, entry!.workItemId, runId), expectedHeadHash: head.hash, leaseToken, now: now() });
      });
      state = { ...state, queue: state.queue.map((item) => item.workItemId === entry!.workItemId
        ? { ...item, phase: "launching", childRunId: runId, launchKey, selectedProvider: state.providerPolicy.primary } : item) };
      state = await persist(state, envelope.hash, started.checkpointHash); envelope = (await loadEnvelope())!;
      entry = state.queue.find((item) => item.workItemId === entry!.workItemId)!;
      justCreatedLaunch = true;
      if (stepOptions.stopAfter === "launch-intent") return state;
    }
    while (entry.phase === "launching") {
      const recovery = classifyMissionRecovery(entry);
      const result = justCreatedLaunch
        ? await options.childRuns.launch(runInput(state, entry))
        : await options.childRuns.recover(runInput(state, entry));
      const recoveryAuthority = entry.recoveryAuthority;
      if (recoveryAuthority !== undefined) {
        const identityMatches = recoveryAuthority.supervisorCheckpointHash === state.bindings.missionLedgerHeadHash
          && result !== null
          && result.runId === recoveryAuthority.runId
          && result.receiptHash === recoveryAuthority.receiptHash
          && canonicalHash(result) === recoveryAuthority.outcomeHash;
        const outcomeMatches = recoveryAuthority.kind === "candidate"
          ? result?.kind === "candidate"
          : result?.kind === "failed"
            && result.actualUsd === recoveryAuthority.actualUsd
            && result.tokens === recoveryAuthority.tokens;
        if (!identityMatches || !outcomeMatches) {
          return await addBlocker(state, envelope.hash, entry.workItemId, "corrupt_state",
            "recovered child result conflicts with durable recovery authority", state.bindings.missionLedgerHeadHash);
        }
      }
      if (candidateAheadAtStart) {
        if (result === null || result.kind !== "candidate"
          || result.runId !== entry.childRunId
          || result.receiptHash !== supervisorItemAtStart?.lastTransition?.evidenceHash) {
          return await addBlocker(state, envelope.hash, entry.workItemId, "corrupt_state",
            "recovered candidate does not match the direct supervisor-ahead success", state.bindings.missionLedgerHeadHash);
        }
        state = {
          ...state,
          queue: state.queue.map((item) => item.workItemId === entry!.workItemId ? {
            ...item,
            recoveryAuthority: {
              kind: "candidate",
              supervisorCheckpointHash: supervisorAtStart.hash,
              runId: result.runId,
              receiptHash: result.receiptHash,
              outcomeHash: canonicalHash(result)
            }
          } : item)
        };
        state = await persist(state, envelope.hash, supervisorAtStart.hash);
        envelope = (await loadEnvelope())!;
        entry = state.queue.find((item) => item.workItemId === entry!.workItemId)!;
        if (stepOptions.stopAfter === "recovery-rebind") return state;
      }
      if (failedSettlementAheadAtStart) {
        if (result === null || result.kind !== "failed"
          || result.runId !== entry.childRunId
          || result.receiptHash !== failedSettlementAtStart?.receiptHash
          || result.actualUsd !== failedSettlementAtStart.actualUsd
          || result.tokens !== failedSettlementAtStart.tokens) {
          return await addBlocker(state, envelope.hash, entry.workItemId, "corrupt_state",
            "recovered child result conflicts with the direct failed-settlement outcome", state.bindings.missionLedgerHeadHash);
        }
        state = {
          ...state,
          queue: state.queue.map((item) => item.workItemId === entry!.workItemId ? {
            ...item,
            recoveryAuthority: {
              kind: "failed_settlement",
              supervisorCheckpointHash: supervisorAtStart.hash,
              runId: result.runId,
              receiptHash: result.receiptHash,
              outcomeHash: canonicalHash(result),
              actualUsd: result.actualUsd,
              tokens: result.tokens
            }
          } : item)
        };
        state = await persist(state, envelope.hash, supervisorAtStart.hash);
        envelope = (await loadEnvelope())!;
        entry = state.queue.find((item) => item.workItemId === entry!.workItemId)!;
        if (stepOptions.stopAfter === "recovery-rebind") return state;
      }
      if (terminalAheadAtStart) {
        if (result === null || result.kind !== "failed"
          || result.runId !== entry.childRunId
          || result.receiptHash !== terminalSettlementAtStart?.receiptHash
          || result.actualUsd !== terminalSettlementAtStart.actualUsd
          || result.tokens !== terminalSettlementAtStart.tokens) {
          return await addBlocker(state, envelope.hash, entry.workItemId, "corrupt_state",
            "recovered child result does not match the direct supervisor-ahead terminal evidence", state.bindings.missionLedgerHeadHash);
        }
        state = {
          ...state,
          queue: state.queue.map((item) => item.workItemId === entry!.workItemId ? {
            ...item,
            recoveryAuthority: {
              kind: "terminal",
              supervisorCheckpointHash: supervisorAtStart.hash,
              runId: result.runId,
              receiptHash: result.receiptHash,
              outcomeHash: canonicalHash(result),
              actualUsd: result.actualUsd,
              tokens: result.tokens,
              terminalStatus: supervisorItemAtStart!.status as "failed" | "blocked"
            }
          } : item)
        };
        state = await persist(state, envelope.hash, supervisorAtStart.hash);
        envelope = (await loadEnvelope())!;
        entry = state.queue.find((item) => item.workItemId === entry!.workItemId)!;
        if (stepOptions.stopAfter === "recovery-rebind") return state;
      }
      if (result === null) return await addBlocker(state, envelope.hash, entry.workItemId, "child_recovery_unavailable",
        `${recovery}: child outcome is not recoverable`, state.bindings.missionLedgerHeadHash);
      if (result.kind === "failed") {
        const terminalOutcomeAuthoritative = entry.recoveryAuthority?.kind === "terminal" || terminalAheadAtStart;
        state = await settleFailedAttempt(state, envelope.hash, entry, result);
        envelope = (await loadEnvelope())!;
        entry = state.queue.find((item) => item.workItemId === entry!.workItemId)!;
        if (stepOptions.stopAfter === "failed-settlement") return state;
        if (!terminalOutcomeAuthoritative && result.code === "provider_failure"
            && state.providerPolicy.allowFallback && state.providerPolicy.fallback !== undefined &&
            entry.selectedProvider !== state.providerPolicy.fallback) {
          const fallback = state.providerPolicy.fallback;
          const supervisorAfterFailure = await requiredSupervisorHead();
          const item = supervisorAfterFailure.state.workItems.find((candidate) => candidate.id === entry!.workItemId);
          const providerAttempts = supervisorAfterFailure.state.settlements.filter((settlement) => settlement.workItemId === entry!.workItemId).length;
          if (item === undefined || providerAttempts >= item.maxAttempts
            || supervisorAfterFailure.state.budget.runsUsed >= supervisorAfterFailure.state.budget.maxRuns
            || supervisorAfterFailure.state.budget.spentUsd >= supervisorAfterFailure.state.budget.maxUsd
            || supervisorAfterFailure.state.budget.tokensUsed >= supervisorAfterFailure.state.budget.maxTokens) {
            return await failChild(state, envelope.hash, entry, { ...result, code: "policy_blocked", message: "fallback attempt exceeds mission or work-item budget" });
          }
          const fallbackRunId = stableId("run", state.missionId, entry.workItemId, entry.childRunId!, fallback);
          state = { ...state, queue: state.queue.map((item) => item.workItemId === entry!.workItemId
            ? (() => {
                const { recoveryAuthority: _recoveryAuthority, ...unconstrained } = item;
                return { ...unconstrained, selectedProvider: fallback,
                  childRunId: fallbackRunId,
                  launchKey: stableId("launch", state.missionId, item.workItemId, fallbackRunId, fallback) };
              })()
            : item) };
          state = await persist(state, envelope.hash, state.bindings.missionLedgerHeadHash); envelope = (await loadEnvelope())!;
          entry = state.queue.find((item) => item.workItemId === entry!.workItemId)!;
          justCreatedLaunch = true;
          continue;
        }
        return await failChild(state, envelope.hash, entry, result);
      }
      const handoffVerification = verifyContextHandoff({
        handoff: result.handoff.receipt,
        producerReceiptVerified: result.handoff.producerReceiptVerified,
        availableArtifacts: new Map(result.handoff.availableArtifactHashes.map((artifactHash) => [artifactHash, true] as const))
      });
      const handoffBound = handoffVerification.ok
        && result.handoff.receipt.missionId === state.missionId
        && result.handoff.receipt.producerRunId === result.runId
        && result.handoff.receipt.producerReceiptHash === result.receiptHash
        && result.handoff.receipt.artifacts.some((artifact) => artifact.required && artifact.sha256 === result.handoff.manifestHash)
        && result.handoff.availableArtifactHashes.includes(result.handoff.manifestHash);
      if (!handoffBound) {
        const failure: MissionChildFailure = { kind: "failed", runId: result.runId, receiptHash: result.receiptHash,
          actualUsd: result.actualUsd, tokens: result.tokens, code: "scope_violation", message: "context handoff verification failed" };
        state = await settleFailedAttempt(state, envelope.hash, entry, failure);
        envelope = (await loadEnvelope())!;
        entry = state.queue.find((item) => item.workItemId === entry!.workItemId)!;
        if (stepOptions.stopAfter === "failed-settlement") return state;
        return await failChild(state, envelope.hash, entry, failure);
      }
      const budgetHead = await requiredSupervisorHead();
      const remainingUsd = Math.max(0, budgetHead.state.budget.maxUsd - budgetHead.state.budget.spentUsd);
      const remainingTokens = Math.max(0, budgetHead.state.budget.maxTokens - budgetHead.state.budget.tokensUsed);
      if (result.actualUsd > remainingUsd || result.tokens > remainingTokens) {
        const failure: MissionChildFailure = {
          kind: "failed",
          runId: result.runId,
          receiptHash: result.receiptHash,
          actualUsd: result.actualUsd,
          tokens: result.tokens,
          code: "budget_exhausted",
          message: "child usage exceeded the remaining mission budget"
        };
        state = await settleFailedAttempt(state, envelope.hash, entry, failure);
        envelope = (await loadEnvelope())!;
        entry = state.queue.find((item) => item.workItemId === entry!.workItemId)!;
        if (stepOptions.stopAfter === "failed-settlement") return state;
        return await failChild(state, envelope.hash, entry, failure);
      }
      const candidateSupervisorHeadHash = await withLease(async (leaseToken) => {
        const head = await requiredSupervisorHead();
        const item = head.state.workItems.find((candidate) => candidate.id === entry!.workItemId);
        if (item?.status === "succeeded" && (
          item.lastTransition?.evidenceHash !== result.receiptHash
          || item.lastTransition.evidenceSource !== `child:${result.runId}`
        )) {
          throw new Error("supervisor candidate evidence does not match the recovered child result");
        }
        if (item?.status === "running") {
          const transitioned = await supervisor.transitionWorkItem({
          workItemId: entry!.workItemId, to: "succeeded", actor: { id: "child-run-adapter", role: "executor" },
          evidence: { hash: result.receiptHash, source: `child:${result.runId}`, observedAt: now() }
        }, { checkpointId: stableId("supervisor-candidate", head.hash, entry!.workItemId, result.runId), expectedHeadHash: head.hash, leaseToken, now: now() });
          return transitioned.checkpointHash;
        }
        return head.hash;
      });
      state = { ...state, candidates: { ...state.candidates, [entry.workItemId]: result },
        context: compactContext(state.context, result.handoff),
        queue: state.queue.map((item) => item.workItemId === entry!.workItemId
          ? (() => {
              const { recoveryAuthority: _recoveryAuthority, ...resolved } = item;
              return { ...resolved, phase: "verifying" as const, candidateHash: result.candidateHash, receiptHash: result.receiptHash };
            })() : item) };
      state = await persist(state, envelope.hash, candidateSupervisorHeadHash); envelope = (await loadEnvelope())!;
      entry = state.queue.find((item) => item.workItemId === entry!.workItemId)!;
      break;
    }
    if (entry.phase === "candidate" || entry.phase === "verifying") {
      const candidate = state.candidates[entry.workItemId];
      if (candidate === undefined) return await addBlocker(state, envelope.hash, entry.workItemId, "corrupt_state", "candidate evidence is missing",
        state.bindings.missionLedgerHeadHash);
      const settlementId = stableId("settlement", state.missionId, entry.workItemId, candidate.runId);
      const supervisorBeforeVerification = await requiredSupervisorHead();
      const settled = supervisorBeforeVerification.state.settlements.find((item) => item.settlementId === settlementId);
      const verification = state.verifications[entry.workItemId] ?? (settled === undefined ? await options.verifier.verify({
        missionId: state.missionId, workItemId: entry.workItemId, runId: candidate.runId,
        candidateHash: candidate.candidateHash, receiptHash: candidate.receiptHash
      }) : { ...settled.verifier });
      const verificationSupervisorHeadHash = await withLease(async (leaseToken) => {
        const head = await requiredSupervisorHead();
        if (!head.state.settlements.some((settlement) => settlement.settlementId === settlementId)) {
          const recorded = await supervisor.recordSettlement({
            settlementId, runId: candidate.runId, workItemId: entry!.workItemId,
            receiptHash: candidate.receiptHash, actualUsd: candidate.actualUsd, tokens: candidate.tokens,
            settledAt: now(), verifier: verification
          }, { checkpointId: stableId("supervisor-settlement", head.hash, settlementId), expectedHeadHash: head.hash, leaseToken, now: now() });
          return recorded.checkpointHash;
        }
        return head.hash;
      });
      state = await persist(state, envelope.hash, verificationSupervisorHeadHash);
      envelope = (await loadEnvelope())!;
      if (stepOptions.stopAfter === "settlement") return state;
      if (!verification.passed) {
        const reason = verification.reason ?? "verifier rejected candidate";
        state = { ...state, verifications: { ...state.verifications, [entry.workItemId]: verification },
          failedCandidates: [...state.failedCandidates, { workItemId: entry.workItemId, runId: candidate.runId,
            candidateHash: candidate.candidateHash, receiptHash: candidate.receiptHash,
            verifierEvidenceHash: verification.evidenceHash, reason, retainedAt: now() }],
          blockers: [...state.blockers, { code: "verifier_rejected", workItemId: entry.workItemId, message: reason, at: now() }],
          queue: state.queue.map((item) => item.workItemId === entry!.workItemId ? { ...item, phase: "failed" } : item) };
        return await persist(state, envelope.hash, state.bindings.missionLedgerHeadHash);
      }
      const integrationId = stableId("integration", state.missionId, entry.workItemId, candidate.candidateHash);
      state = { ...state, verifications: { ...state.verifications, [entry.workItemId]: verification },
        queue: state.queue.map((item) => item.workItemId === entry!.workItemId ? { ...item, phase: "integrating", integrationId } : item) };
      state = await persist(state, envelope.hash, state.bindings.missionLedgerHeadHash); envelope = (await loadEnvelope())!;
      entry = state.queue.find((item) => item.workItemId === entry!.workItemId)!;
      if (stepOptions.stopAfter === "integration-intent") return state;
      const integrated = await options.integrator.integrate({ missionId: state.missionId, workItemId: entry.workItemId,
        integrationId, candidateHash: candidate.candidateHash, verifierEvidenceHash: verification.evidenceHash });
      state = { ...state, queue: state.queue.map((item) => item.workItemId === entry!.workItemId
        ? { ...item, phase: "integrated", integratedHash: integrated.integratedHash } : item) };
      return await persist(state, envelope.hash, state.bindings.missionLedgerHeadHash);
    }
    if (entry.phase === "integrating") {
      const candidate = state.candidates[entry.workItemId]; const verification = state.verifications[entry.workItemId];
      if (candidate === undefined || verification === undefined || entry.integrationId === undefined)
        return await addBlocker(state, envelope.hash, entry.workItemId, "corrupt_state", "integration evidence is missing",
          state.bindings.missionLedgerHeadHash);
      const integrated = await options.integrator.recover({ missionId: state.missionId, workItemId: entry.workItemId,
        integrationId: entry.integrationId, candidateHash: candidate.candidateHash, verifierEvidenceHash: verification.evidenceHash });
      if (integrated === null) return await addBlocker(state, envelope.hash, entry.workItemId, "integration_recovery_unavailable",
        "integration outcome is not recoverable", state.bindings.missionLedgerHeadHash);
      state = { ...state, queue: state.queue.map((item) => item.workItemId === entry!.workItemId
        ? { ...item, phase: "integrated", integratedHash: integrated.integratedHash } : item) };
      return await persist(state, envelope.hash, state.bindings.missionLedgerHeadHash);
    }
    return state;
  }

  async function runUntilBlocked(): Promise<MissionRuntimeState> {
    let previous = "";
    for (let count = 0; count < 10_000; count += 1) {
      const current = await step();
      const signature = JSON.stringify([current.sequence, current.queue, current.blockers]);
      if (signature === previous || current.blockers.length > 0 || current.queue.every((entry) => ["integrated", "failed", "blocked"].includes(entry.phase))) return current;
      previous = signature;
    }
    throw new Error("mission runtime step limit exceeded");
  }

  async function addBlocker(
    state: MissionRuntimeState,
    expected: string,
    workItemId: string,
    code: MissionRuntimeBlockerCode,
    message: string,
    authorizedSupervisorHeadHash: string
  ) {
    if (state.blockers.some((blocker) =>
      blocker.code === code && blocker.workItemId === workItemId && blocker.message === message
    ) && state.queue.find((item) => item.workItemId === workItemId)?.phase === "blocked") {
      return state;
    }
    const blocked = {
      ...state,
      blockers: [...state.blockers, { code, workItemId, message, at: now() }],
      queue: state.queue.map((item) => {
        if (item.workItemId !== workItemId) return item;
        const { recoveryAuthority: _recoveryAuthority, ...resolved } = item;
        return { ...resolved, phase: "blocked" as const };
      })
    };
    if (code !== "corrupt_state") return await persist(blocked, expected, authorizedSupervisorHeadHash);
    const updatedAt = now();
    const next: MissionRuntimeState = {
      ...blocked,
      updatedAt,
      sequence: state.sequence + 1,
      bindings: {
        ...state.bindings,
        workQueueHash: hashMissionWorkQueue(blocked.queue),
        contextManifestHash: blocked.context.manifestHash
      }
    };
    const appended = await runtimeStore.append(next, {
      checkpointId: `runtime-${String(next.sequence).padStart(8, "0")}`,
      writerId: "mission-runtime",
      expectedHeadHash: expected,
      now: updatedAt
    });
    return appended.checkpoint.state;
  }
  async function failChild(state: MissionRuntimeState, expected: string, entry: MissionQueueEntry, failure: MissionChildFailure) {
    const authorizedSupervisorHeadHash = await withLease(async (leaseToken) => {
      const head = await requiredSupervisorHead();
      const item = head.state.workItems.find((candidate) => candidate.id === entry.workItemId);
      if (item === undefined) throw new Error(`mission work item is missing: ${entry.workItemId}`);
      if (item.status === "failed" || item.status === "blocked") return head.hash;
      const terminalStatus = item.status === "succeeded" ? "blocked" : "failed";
      const actor = item.status === "succeeded"
        ? { id: "mission-runtime", role: "supervisor" as const }
        : { id: "child-run-adapter", role: "executor" as const };
      const transitioned = await supervisor.transitionWorkItem({ workItemId: entry.workItemId, to: terminalStatus, actor,
        evidence: { hash: failure.receiptHash, source: `child:${failure.runId}`, observedAt: now() } },
      { checkpointId: stableId("supervisor-fail", head.hash, entry.workItemId, failure.runId), expectedHeadHash: head.hash, leaseToken, now: now() });
      return transitioned.checkpointHash;
    });
    return await addBlocker(state, expected, entry.workItemId, failure.code, failure.message, authorizedSupervisorHeadHash);
  }
  async function settleFailedAttempt(
    state: MissionRuntimeState,
    expectedRuntimeHead: string,
    entry: MissionQueueEntry,
    failure: MissionChildFailure
  ): Promise<MissionRuntimeState> {
    const settlementId = stableId("settlement-failed", state.missionId, entry.workItemId, failure.runId);
    const authorizedSupervisorHeadHash = await withLease(async (leaseToken) => {
      const head = await requiredSupervisorHead();
      const existing = head.state.settlements.find((item) => item.settlementId === settlementId);
      if (existing !== undefined) {
        if (existing.runId !== failure.runId
          || existing.workItemId !== entry.workItemId
          || existing.receiptHash !== failure.receiptHash
          || existing.actualUsd !== failure.actualUsd
          || existing.tokens !== failure.tokens
          || existing.verifier.passed !== false
          || existing.verifier.verifierId !== "child-run-adapter"
          || existing.verifier.evidenceHash !== failure.receiptHash
          || existing.verifier.source !== `child:${failure.runId}`) {
          throw new Error("persisted failed settlement does not match the recovered child result");
        }
        return head.hash;
      }
      const settled = await supervisor.recordSettlement({
        settlementId, runId: failure.runId, workItemId: entry.workItemId,
        receiptHash: failure.receiptHash, actualUsd: failure.actualUsd, tokens: failure.tokens,
        settledAt: now(), verifier: { passed: false, verifierId: "child-run-adapter", evidenceHash: failure.receiptHash, source: `child:${failure.runId}` }
      }, { checkpointId: stableId("supervisor-failed-settlement", head.hash, settlementId), expectedHeadHash: head.hash, leaseToken, now: now() });
      return settled.checkpointHash;
    });
    const constrained: MissionRuntimeState = {
      ...state,
      queue: state.queue.map((item) => item.workItemId === entry.workItemId ? {
        ...item,
        recoveryAuthority: item.recoveryAuthority?.kind === "terminal" ? item.recoveryAuthority : {
          kind: "failed_settlement",
          supervisorCheckpointHash: authorizedSupervisorHeadHash,
          runId: failure.runId,
          receiptHash: failure.receiptHash,
          outcomeHash: canonicalHash(failure),
          actualUsd: failure.actualUsd,
          tokens: failure.tokens
        }
      } : item)
    };
    return await persist(constrained, expectedRuntimeHead, authorizedSupervisorHeadHash);
  }
  async function attemptOf(workItemId: string) { return (await requiredSupervisorHead()).state.workItems.find((item) => item.id === workItemId)?.attempts ?? 0; }

  return {
    initialize,
    async load() { return (await loadEnvelope())?.state ?? null; },
    step,
    runUntilBlocked,
    async morningDossier() {
      const state = (await loadEnvelope())?.state; const supervisorState = await supervisor.load();
      if (state === undefined || supervisorState === null) throw new Error("mission runtime is not initialized");
      return { schemaVersion: "martin.mission-runtime-dossier.v1", state, supervisor: buildMorningDossier(supervisorState) };
    }
  };
}

function stableId(prefix: string, ...values: string[]): string {
  return `${prefix}-${createHash("sha256").update(values.join("\u0000"), "utf8").digest("hex").slice(0, 32)}`;
}
function canonicalHash(value: unknown): string {
  const normalize = (input: unknown): unknown => Array.isArray(input) ? input.map(normalize)
    : input !== null && typeof input === "object"
      ? Object.fromEntries(Object.entries(input as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)).map(([key, child]) => [key, normalize(child)]))
      : input;
  return createHash("sha256").update(JSON.stringify(normalize(value)), "utf8").digest("hex");
}
function assertHash(value: string, name: string): void {
  if (!/^[a-f0-9]{64}$/u.test(value)) throw new TypeError(`${name} must be a SHA-256 hash`);
}
function compactContext(
  current: MissionRuntimeState["context"],
  handoff: MissionChildCandidate["handoff"]
): MissionRuntimeState["context"] {
  const tokenCount = current.tokenCount + handoff.tokenCount;
  if (tokenCount < current.compactAtTokens) return { ...current, tokenCount, manifestHash: handoff.manifestHash, summary: handoff.summary };
  const summary = [current.summary, handoff.summary].filter(Boolean).join("\n");
  return { ...current, manifestHash: createHash("sha256").update(JSON.stringify({ previous: current.manifestHash, handoff: handoff.manifestHash, summary }), "utf8").digest("hex"), tokenCount: handoff.tokenCount, summary };
}

export async function readMissionRuntimeState(root: string, missionId: string): Promise<MissionRuntimeState | null> {
  const missionRoot = assertSafeMissionPath(root, missionId);
  const store = createCheckpointStore<MissionRuntimeState>({ root: join(missionRoot, "runtime") });
  return (await store.loadHead())?.state ?? null;
}

export async function readMissionRuntimeControlIntent(root: string, missionId: string): Promise<MissionControlIntent | null> {
  const missionRoot = assertSafeMissionPath(root, missionId);
  const raw = await readFile(join(missionRoot, "control-intent.json"), "utf8").catch(() => null);
  return raw === null ? null : JSON.parse(raw) as MissionControlIntent;
}

export async function writeMissionRuntimeControlIntent(
  root: string,
  missionId: string,
  input: MissionControlIntentInput,
  authority: MissionHostApprovalAuthority
): Promise<MissionControlIntent> {
  const missionRoot = assertSafeMissionPath(root, missionId);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(input.intentId))
    throw new TypeError("intentId must be a safe path component");
  if (!input.reason.trim() || !Number.isFinite(Date.parse(input.requestedAt)))
    throw new TypeError("control intent id, reason, and requestedAt are required");
  if (input.approval.missionId !== missionId || input.approval.action !== input.action ||
      Date.parse(input.approval.expiresAt) <= Date.parse(input.requestedAt) || !authority.verify(input.approval))
    throw new Error("host approval did not authorize this mission control intent");
  const intent: MissionControlIntent = {
    schemaVersion: "martin.mission-control-intent.v1", intentId: input.intentId, missionId,
    action: input.action, reason: input.reason, requestedAt: input.requestedAt,
    approval: structuredClone(input.approval), verifiedBy: authority.authorityId
  };
  const directory = missionRoot; await mkdir(directory, { recursive: true });
  const path = join(directory, "control-intent.json"); const temporary = join(directory, `.control-intent-${input.intentId}.tmp`);
  const handle = await open(temporary, "wx");
  try { await handle.writeFile(`${JSON.stringify(intent, null, 2)}\n`, "utf8"); await handle.sync(); } finally { await handle.close(); }
  await rename(temporary, path);
  return intent;
}

export async function verifyMissionMemory(root: string, options: MemoryStoreV2Options = {}) {
  return await new MemoryStoreV2(root, options).verify();
}

export async function inspectMissionMemory(root: string, options: MemoryStoreV2Options = {}) {
  return await new MemoryStoreV2(root, options).readAll();
}

export async function classifyMissionMemoryCandidates(
  root: string,
  asOf: string,
  options: MemoryStoreV2Options = {}
): Promise<MissionMemoryCandidateClassification[]> {
  return classifyMissionMemoryRecords(await new MemoryStoreV2(root, options).readAll(), asOf);
}

export async function revokeMissionMemory(
  root: string,
  id: string,
  input: { sourceRef: string; receipt: MemoryApprovalReceiptV2 },
  approvalAuthority: MemoryApprovalAuthorityV2
): Promise<MemoryRecordV2> {
  return await new MemoryStoreV2(root, { approvalAuthority }).revoke(id, input);
}

export function classifyMissionMemoryRecords(
  records: readonly MemoryRecordV2[],
  asOf: string
): MissionMemoryCandidateClassification[] {
  const instant = Date.parse(asOf);
  if (!Number.isFinite(instant)) throw new TypeError("asOf must be an ISO-8601 timestamp");
  const byId = new Map(records.map((record) => [record.id, record]));
  const validPromotions = new Set<string>();
  const expiredPromotions = new Set<string>();
  for (const event of records) {
    if (event.kind !== "promotion" || event.authority?.action !== "promotion" ||
        event.provenance.source !== "human" || !event.provenance.actorId.startsWith("human:") ||
        event.trust.level === "untrusted" || event.trust.confidence !== 1) continue;
    const targetId = readMemoryString(event.content, "targetId");
    const target = targetId === undefined ? undefined : byId.get(targetId);
    const sourceRef = event.provenance.sourceRefs[0];
    if (target === undefined || sourceRef === undefined || event.authority.targetId !== target.id ||
        event.authority.sourceHash !== memoryApprovalActionSourceHashV2(target.entryHash, sourceRef) ||
        readMemoryString(event.content, "exactScope") !== target.scope.subject ||
        event.scope.workspaceId !== target.scope.workspaceId ||
        (event.scope.projectId ?? null) !== (target.scope.projectId ?? null) ||
        (event.scope.missionId ?? null) !== (target.scope.missionId ?? null) ||
        (event.scope.taskId ?? null) !== (target.scope.taskId ?? null) ||
        (event.scope.runId ?? null) !== (target.scope.runId ?? null)) continue;
    if ((event.expiresAt !== undefined && Date.parse(event.expiresAt) <= instant) ||
        Date.parse(event.authority.expiresAt) <= instant) expiredPromotions.add(target.id);
    else validPromotions.add(target.id);
  }
  const revoked = new Set(records.filter((record) => record.kind === "revocation" &&
    record.authority?.action === "revocation" && record.provenance.source === "human" &&
    record.provenance.actorId.startsWith("human:") && record.trust.level === "authoritative" &&
    record.trust.confidence === 1).map((record) => readMemoryString(record.content, "targetId")).filter((id): id is string => id !== undefined));
  for (const record of records) if (validPromotions.has(record.id) && record.supersedesId !== undefined) revoked.add(record.supersedesId);
  return records.filter((record) => !["consent", "promotion", "revocation", "compaction"].includes(record.kind)).map((record) => {
    const expired = record.sourceState === "stale" || (record.expiresAt !== undefined && Date.parse(record.expiresAt) <= instant) || expiredPromotions.has(record.id);
    const status: MissionMemoryCandidateStatus = revoked.has(record.id) ? "revoked" : expired ? "expired" : validPromotions.has(record.id) ? "active" : "candidate";
    return { record: structuredClone(record), status };
  });
}

function readMemoryString(content: unknown, key: string): string | undefined {
  if (content === null || typeof content !== "object") return undefined;
  const value = (content as Record<string, unknown>)[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
