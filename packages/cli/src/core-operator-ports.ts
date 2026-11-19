import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";

import {
  classifyMissionMemoryRecords,
  inspectMissionMemory,
  readMissionRuntimeControlIntent,
  readMissionRuntimeState,
  resolveRunsRoot,
  revokeMissionMemory,
  writeMissionRuntimeControlIntent,
  MemoryStoreV2Error,
  type MemoryApprovalAuthorityV2,
  type MemoryApprovalReceiptV2,
  type MissionHostApprovalAuthority,
  type MissionHostApprovalReceipt,
  type MissionControlIntent,
  type MissionRuntimeState,
} from "@martin/core";

import type {
  MissionAuthorityView,
  MissionCommandRequest,
  MissionOperatorPort,
  MissionSelector,
} from "./mission-commands.js";
import type {
  MemoryCommandRequest,
  MemoryLifecycleState,
  MemoryOperatorPort,
  MemoryRecordView,
  MemorySelector,
} from "./memory-commands.js";
import { CliCommandError } from "./ux.js";

export interface CoreOperatorPortOptions {
  defaultRunsRoot?: string;
  env?: NodeJS.ProcessEnv;
  missionApprovalAuthority?: MissionHostApprovalAuthority;
  memoryApprovalAuthority?: MemoryApprovalAuthorityV2;
  resumeMission?: (root: string, missionId: string) => Promise<MissionRuntimeState>;
  now?: () => string;
}

export function createCoreOperatorPorts(options: CoreOperatorPortOptions = {}): {
  mission: MissionOperatorPort;
  memory: MemoryOperatorPort;
} {
  const now = options.now ?? (() => new Date().toISOString());
  const defaultRoot = resolve(options.defaultRunsRoot ?? resolveRunsRoot(options.env ?? process.env));

  const mission: MissionOperatorPort = {
    async status(request) {
      const root = rootFor(request, defaultRoot);
      const state = await selectMission(root, request.selector);
      return missionView(state, await readMissionRuntimeControlIntent(root, state.missionId), now());
    },
    async inspect(request) {
      const root = rootFor(request, defaultRoot);
      const state = await selectMission(root, request.selector);
      return missionView(state, await readMissionRuntimeControlIntent(root, state.missionId), now());
    },
    async resume(request) {
      const root = rootFor(request, defaultRoot);
      const state = await selectMission(root, request.selector);
      const control = await readMissionRuntimeControlIntent(root, state.missionId);
      if (!options.resumeMission) {
        return {
          ...missionView(state, control, now()),
          resume: { status: "read_only", reason: "active_host_required_to_advance" },
        };
      }
      return { ...missionView(await options.resumeMission(root, state.missionId), control, now()), resume: { status: "advanced" } };
    },
    async requestControl(action, request) {
      if (!options.missionApprovalAuthority) {
        throw new CliCommandError("auth", "Mission control approval authority is unavailable in this host.");
      }
      const root = rootFor(request, defaultRoot);
      const state = await selectMission(root, request.selector);
      const approval = await readJson<MissionHostApprovalReceipt>(request.hostApprovalPath, "mission host approval");
      const existing = await readMissionRuntimeControlIntent(root, state.missionId);
      if (existing?.action === action && existing.reason === request.reason && existing.approval.approvalId === approval.approvalId) {
        return controlView(state, action, request.reason, "already_requested");
      }
      await writeMissionRuntimeControlIntent(root, state.missionId, {
        intentId: `intent_${randomUUID()}`,
        action,
        reason: request.reason,
        requestedAt: now(),
        approval,
      }, options.missionApprovalAuthority);
      return controlView(state, action, request.reason, "requested");
    },
  };

  const memory: MemoryOperatorPort = {
    async inspect(request) {
      const root = rootFor(request, defaultRoot);
      const records = await readMemoryRecords(root);
      const classified = classifyMissionMemoryRecords(records, now());
      const selected = selectMemory(classified.map(({ record, status }) => ({ record, state: status })), request.selector);
      return {
        schemaVersion: "martin.memory.operator.v1",
        authority: memoryAuthority(records),
        memory: memoryView(selected.record, selected.state),
      };
    },
    async verify(request) {
      const root = rootFor(request, defaultRoot);
      let records: Awaited<ReturnType<typeof inspectMissionMemory>> | undefined;
      try {
        records = await inspectMissionMemory(root);
        const classified = classifyMissionMemoryRecords(records, now());
        const selected = selectMemory(classified.map(({ record, status }) => ({ record, state: status })), request.selector);
        return {
          schemaVersion: "martin.memory.operator.v1",
          authority: memoryAuthority(records),
          memoryId: selected.record.id,
          state: selected.state,
          verification: { status: "valid", entryCount: records.length, headHash: records.at(-1)?.entryHash ?? null },
        };
      } catch (error) {
        if (!(error instanceof MemoryStoreV2Error)) throw error;
        if (error.code !== "corrupt" && error.code !== "unreadable") throw mapMemoryError(error);
        return {
          schemaVersion: "martin.memory.operator.v1",
          authority: records ? memoryAuthority(records) : { kind: "persisted", revision: 0, headHash: null },
          memoryId: selectorLabel(request.selector),
          state: error.code === "corrupt" ? "corrupt" : "unreadable",
          verification: { status: error.code === "corrupt" ? "corrupt" : "unreadable", reason: error.message },
        };
      }
    },
    async candidates(request) {
      const root = rootFor(request, defaultRoot);
      const records = await readMemoryRecords(root);
      const classified = classifyMissionMemoryRecords(records, now());
      return {
        schemaVersion: "martin.memory.operator.v1",
        authority: memoryAuthority(records),
        candidates: classified
          .filter(({ status }) => !request.state || status === request.state)
          .map(({ record, status }) => memoryView(record, status)),
      };
    },
    async revoke(request) {
      if (!options.memoryApprovalAuthority) {
        throw new CliCommandError("auth", "Memory revoke approval authority is unavailable in this host.");
      }
      const root = rootFor(request, defaultRoot);
      const before = await readMemoryRecords(root);
      const classified = classifyMissionMemoryRecords(before, now());
      const selected = selectMemory(classified.map(({ record, status }) => ({ record, state: status })), request.selector);
      const envelope = await readJson<{ sourceRef: string; receipt: MemoryApprovalReceiptV2 }>(request.hostApprovalPath, "memory host approval");
      if (!envelope.sourceRef?.trim() || !envelope.receipt) {
        throw new CliCommandError("auth", "Memory host approval must contain sourceRef and receipt.");
      }
      const existing = before.find((record) => isPersistedRevocationOf(record, selected.record.id));
      let revoked;
      try {
        revoked = await revokeMissionMemory(root, selected.record.id, envelope, options.memoryApprovalAuthority);
      } catch (error) {
        if (!(error instanceof MemoryStoreV2Error) || error.code !== "replay" || !existing) throw mapMemoryError(error);
        revoked = existing;
      }
      const records = await readMemoryRecords(root);
      return {
        schemaVersion: "martin.memory.operator.v1",
        authority: memoryAuthority(records),
        memoryId: selected.record.id,
        state: "revoked",
        outcome: existing ? "already_revoked" : "revoked",
        approval: { status: "verified", approvalId: revoked.authority?.receiptId },
      };
    },
  };

  return { mission, memory };
}

function rootFor(request: { runsDir?: string }, fallback: string): string {
  return resolve(request.runsDir?.trim() || fallback);
}

async function selectMission(root: string, selector: MissionSelector): Promise<MissionRuntimeState> {
  if ("missionId" in selector) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(selector.missionId)) {
      throw new CliCommandError("invalid_input", "Mission id must be a safe path component.");
    }
    const state = await readMissionRuntimeState(root, selector.missionId);
    if (!state) throw new CliCommandError("not_found", `Mission ${selector.missionId} was not found.`);
    return state;
  }
  const entries = await readdir(resolve(root, "missions"), { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  const states = (await Promise.all(entries.filter((entry) => entry.isDirectory()).map((entry) => readMissionRuntimeState(root, entry.name))))
    .filter((state): state is MissionRuntimeState => state !== null)
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || right.missionId.localeCompare(left.missionId));
  if (!states[0]) throw new CliCommandError("not_found", "No persisted missions were found.");
  return states[0];
}

function missionView(state: MissionRuntimeState, controlIntent: MissionControlIntent | null, asOf: string): MissionAuthorityView {
  const completed = state.queue.filter((entry) => entry.phase === "integrated").map((entry) => entry.workItemId);
  const active = state.queue.filter((entry) => ["launching", "candidate", "verifying", "integrating"].includes(entry.phase)).map((entry) => entry.workItemId);
  const interrupted = state.queue.filter((entry) => ["failed", "blocked"].includes(entry.phase)).map((entry) => entry.workItemId);
  const budgetReasons = [
    ...(state.settlement.budget.spentUsd >= state.settlement.budget.maxUsd ? ["usd_limit"] : []),
    ...(state.settlement.budget.runsUsed >= state.settlement.budget.maxRuns ? ["run_limit"] : []),
    ...(state.settlement.budget.tokensUsed >= state.settlement.budget.maxTokens ? ["token_limit"] : []),
    ...(Date.parse(asOf) >= Date.parse(state.settlement.budget.wallClockDeadline) ? ["wall_clock_limit"] : []),
    ...(state.settlement.budget.noProgressIntervals >= state.settlement.budget.maxNoProgressIntervals ? ["no_progress_limit"] : []),
  ];
  const complete = completed.length === state.queue.length;
  const verification = state.failedCandidates.length > 0 || state.blockers.some((blocker) => blocker.code === "verifier_rejected")
    ? "failed" : complete ? "verified" : "pending";
  return {
    schemaVersion: "martin.mission.operator.v1",
    missionId: state.missionId,
    authority: { kind: "persisted", revision: state.sequence },
    lifecycle: state.blockers.some((blocker) => blocker.code === "operator_cancel") ? "cancelled"
      : state.blockers.some((blocker) => blocker.code === "operator_pause") ? "paused"
        : complete ? "completed" : interrupted.length > 0 ? "interrupted" : active.length > 0 ? "active" : "pending",
    completed: { count: completed.length, taskIds: completed },
    active: { count: active.length, taskIds: active },
    interrupted: { count: interrupted.length, taskIds: interrupted },
    candidates: { count: Object.keys(state.candidates).length, candidateIds: Object.keys(state.candidates).sort() },
    rollback: { status: "unavailable", reason: "not_persisted" },
    budget: { status: budgetReasons.length > 0 ? "limit_reached" : "within_limit", reasons: budgetReasons, ...state.settlement.budget },
    verification: { status: verification },
    ...(controlIntent ? { controlIntent: {
      action: controlIntent.action,
      status: state.blockers.some((blocker) => blocker.code === `operator_${controlIntent.action}`) ? "applied" as const : "requested" as const,
      approvalId: controlIntent.approval.approvalId,
      requestedAt: controlIntent.requestedAt,
      verifiedBy: controlIntent.verifiedBy,
    } } : {}),
    updatedAt: state.updatedAt,
  };
}

function controlView(state: MissionRuntimeState, action: "pause" | "cancel", reason: string, status: "requested" | "already_requested") {
  return {
    schemaVersion: "martin.mission.control-intent.v1",
    missionId: state.missionId,
    authority: { kind: "persisted" as const, revision: state.sequence },
    intent: { action, status, reason },
  };
}

function selectMemory<T extends { record: { id: string; sequence: number }; state: MemoryLifecycleState }>(records: T[], selector: MemorySelector): T {
  const selected = "memoryId" in selector
    ? records.find(({ record }) => record.id === selector.memoryId)
    : [...records].sort((left, right) => right.record.sequence - left.record.sequence)[0];
  if (!selected) throw new CliCommandError("not_found", `Memory ${selectorLabel(selector)} was not found.`);
  return selected;
}

function memoryView(record: Awaited<ReturnType<typeof inspectMissionMemory>>[number], state: MemoryLifecycleState): MemoryRecordView {
  return { ...record, memoryId: record.id, state };
}

function selectorLabel(selector: MemorySelector): string {
  return "memoryId" in selector ? selector.memoryId : "latest";
}

async function readJson<T>(path: string, label: string): Promise<T> {
  try {
    return JSON.parse(await readFile(resolve(path), "utf8")) as T;
  } catch (error) {
    throw new CliCommandError("auth", `Unable to read ${label}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function memoryTargetId(content: unknown): string | undefined {
  if (content === null || typeof content !== "object" || Array.isArray(content)) return undefined;
  const value = (content as Record<string, unknown>)["targetId"];
  return typeof value === "string" ? value : undefined;
}

function memoryAuthority(records: readonly { sequence: number; entryHash: string }[]) {
  const head = records.at(-1);
  return { kind: "persisted" as const, revision: head?.sequence ?? 0, headHash: head?.entryHash ?? null };
}

async function readMemoryRecords(root: string) {
  try {
    return await inspectMissionMemory(root);
  } catch (error) {
    throw mapMemoryError(error);
  }
}

function mapMemoryError(error: unknown): unknown {
  if (!(error instanceof MemoryStoreV2Error)) return error;
  switch (error.code) {
    case "not_found": return new CliCommandError("not_found", error.message);
    case "unreadable": return new CliCommandError("store_unreadable", error.message);
    case "corrupt": return new CliCommandError("verification_failed", error.message);
    case "invalid": return new CliCommandError("invalid_input", error.message);
    case "authority_denied": return new CliCommandError("auth", error.message);
    case "secret_denied":
    case "quarantined":
    case "replay": return new CliCommandError("policy_blocked", error.message);
    case "conflict": return new CliCommandError("transient", error.message);
  }
}

function isPersistedRevocationOf(record: Awaited<ReturnType<typeof inspectMissionMemory>>[number], targetId: string): boolean {
  return record.kind === "revocation"
    && record.authority?.action === "revocation"
    && record.provenance.source === "human"
    && record.provenance.actorId.startsWith("human:")
    && record.trust.level === "authoritative"
    && record.trust.confidence === 1
    && memoryTargetId(record.content) === targetId;
}
