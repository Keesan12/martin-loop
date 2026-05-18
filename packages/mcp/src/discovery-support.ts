import { resolveRunsRoot, type LedgerEvent, type LoopAttemptRecord, type LoopRunRecord } from "@martin/core";
import type { LoopArtifact, LoopAttempt, LoopEvent, LoopTask } from "@martin/contracts";

import {
  resolveSafeRepoRoot,
  resolveSafeRunsRootPath
} from "./server-validation.js";
import { loadLoopRecordForStatus } from "./tools/run-store.js";
import {
  buildLoopPreview,
  type LoopPreview,
  type MartinEngine
} from "./tools/tool-support.js";
import { invalidArgumentsError } from "./tools/tool-errors.js";

type PersistedLoopTask = LoopRunRecord["task"] &
  Partial<
    Pick<
      LoopTask,
      | "verificationPlan"
      | "verificationStack"
      | "repoRoot"
      | "allowedPaths"
      | "deniedPaths"
      | "acceptanceCriteria"
      | "mutationMode"
      | "executionProfile"
      | "allowedNetworkDomains"
      | "approvalPolicy"
    >
  >;

export type PersistedLoopAttemptRecord = LoopAttemptRecord &
  Partial<Pick<LoopAttempt, "attemptId" | "summary">>;

export interface PersistedLoopRecord extends LoopRunRecord {
  workspaceId?: string;
  projectId?: string;
  teamId?: string;
  task: PersistedLoopTask;
  attempts: PersistedLoopAttemptRecord[];
  artifacts?: LoopArtifact[];
  events?: LoopEvent[];
  metadata?: Record<string, string>;
}

export interface MartinDiscoveryContext {
  runsRoot: string;
  workingDirectory: string;
  engine?: MartinEngine;
}

export interface MartinVerificationSnapshot {
  attemptId?: string;
  attemptIndex?: number;
  timestamp: string;
  lifecycleState: string;
  passed?: boolean;
  summary?: string;
}

export interface MartinAttemptSnapshot {
  loopId: string;
  attemptIndex: number;
  loop: LoopPreview;
  attempt: PersistedLoopAttemptRecord;
  verification?: MartinVerificationSnapshot;
}

export interface MartinVerificationHistorySnapshot {
  loopId: string;
  loop: LoopPreview;
  verificationCount: number;
  latestVerification?: MartinVerificationSnapshot;
  verificationHistory: MartinVerificationSnapshot[];
}

export function resolveMartinDiscoveryContext(input: {
  runsDir?: string;
  workingDirectory?: string;
  engine?: MartinEngine;
} = {}): MartinDiscoveryContext {
  const fallbackRunsRoot = resolveRunsRoot(process.env);

  return {
    runsRoot: resolveSafeRunsRootPath(input.runsDir, fallbackRunsRoot),
    workingDirectory: resolveSafeRepoRoot(input.workingDirectory),
    ...(input.engine ? { engine: input.engine } : {})
  };
}

export async function loadPersistedLoopRecord(input: {
  loopId: string;
  runsDir?: string;
}): Promise<{ source: string; loop: PersistedLoopRecord }> {
  const resolved = await loadLoopRecordForStatus({
    loopId: input.loopId,
    ...(input.runsDir ? { runsDir: input.runsDir } : {})
  });

  return {
    source: resolved.source,
    loop: resolved.loop as PersistedLoopRecord
  };
}

export function buildAttemptSnapshot(
  loop: PersistedLoopRecord,
  requestedAttemptIndex?: number,
  ledgerEvents: LedgerEvent[] = []
): MartinAttemptSnapshot {
  const attempt = requestedAttemptIndex === undefined
    ? loop.attempts.at(-1)
    : loop.attempts.find((candidate) => candidate.index === requestedAttemptIndex);

  if (!attempt) {
    throw invalidArgumentsError(
      requestedAttemptIndex === undefined
        ? `Loop '${loop.loopId}' has no attempts yet.`
        : `Attempt ${requestedAttemptIndex} was not found for loop '${loop.loopId}'.`,
      requestedAttemptIndex === undefined
        ? "Run martin_run first or inspect a loop that has executed at least one attempt."
        : "Choose an attemptIndex that exists in the loop record."
    );
  }

  return {
    loopId: loop.loopId,
    attemptIndex: attempt.index,
    loop: buildPersistedLoopPreview(loop),
    attempt,
    ...(buildVerificationSnapshotForAttempt(loop, attempt, ledgerEvents)
      ? { verification: buildVerificationSnapshotForAttempt(loop, attempt, ledgerEvents) }
      : {})
  };
}

export function buildVerificationHistorySnapshot(
  loop: PersistedLoopRecord,
  ledgerEvents: LedgerEvent[] = []
): MartinVerificationHistorySnapshot {
  const verificationHistory = collectVerificationSnapshots(loop, ledgerEvents);

  return {
    loopId: loop.loopId,
    loop: buildPersistedLoopPreview(loop),
    verificationCount: verificationHistory.length,
    ...(verificationHistory.at(-1)
      ? { latestVerification: verificationHistory.at(-1) }
      : {}),
    verificationHistory
  };
}

export function buildPersistedLoopPreview(loop: PersistedLoopRecord): LoopPreview {
  return buildLoopPreview(loop as Parameters<typeof buildLoopPreview>[0]);
}

export function parseAttemptIndex(value: string): number {
  if (!/^\d+$/u.test(value)) {
    throw invalidArgumentsError(
      "Invalid attemptIndex.",
      "attemptIndex must be a positive integer taken from the loop's attempts array."
    );
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw invalidArgumentsError(
      "Invalid attemptIndex.",
      "attemptIndex must be a positive integer taken from the loop's attempts array."
    );
  }

  return parsed;
}

export function toPrettyJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function buildVerificationSnapshotForAttempt(
  loop: PersistedLoopRecord,
  attempt: PersistedLoopAttemptRecord,
  ledgerEvents: LedgerEvent[] = []
): MartinVerificationSnapshot | undefined {
  return collectVerificationSnapshots(loop, ledgerEvents).find((verification) =>
    verification.attemptIndex === attempt.index ||
    (attempt.attemptId !== undefined && verification.attemptId === attempt.attemptId)
  );
}

function getVerificationEvents(loop: PersistedLoopRecord): LoopEvent[] {
  return (loop.events ?? []).filter(
    (event): event is LoopEvent => event.type === "verification.completed"
  );
}

function toVerificationSnapshot(
  loop: PersistedLoopRecord,
  event: LoopEvent
): MartinVerificationSnapshot | undefined {
  const payload = isRecord(event.payload) ? event.payload : undefined;
  const attemptId = typeof payload?.["attemptId"] === "string" ? payload["attemptId"] : undefined;
  const matchedAttempt = attemptId
    ? loop.attempts.find((attempt) => attempt.attemptId === attemptId)
    : undefined;

  return {
    ...(attemptId ? { attemptId } : {}),
    ...(matchedAttempt ? { attemptIndex: matchedAttempt.index } : {}),
    timestamp: event.timestamp,
    lifecycleState: event.lifecycleState,
    ...(typeof payload?.["passed"] === "boolean" ? { passed: payload["passed"] } : {}),
    ...(typeof payload?.["summary"] === "string" ? { summary: payload["summary"] } : {})
  };
}

function collectVerificationSnapshots(
  loop: PersistedLoopRecord,
  ledgerEvents: LedgerEvent[]
): MartinVerificationSnapshot[] {
  const seen = new Set<string>();
  const snapshots: MartinVerificationSnapshot[] = [];

  for (const event of getVerificationEvents(loop)) {
    const snapshot = toVerificationSnapshot(loop, event);
    if (!snapshot) {
      continue;
    }

    const key = verificationSnapshotKey(snapshot);
    seen.add(key);
    snapshots.push(snapshot);
  }

  for (const event of ledgerEvents.filter((candidate) => candidate.kind === "verification.completed")) {
    const snapshot = ledgerEventToVerificationSnapshot(loop, event);
    if (!snapshot) {
      continue;
    }

    const key = verificationSnapshotKey(snapshot);
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    snapshots.push(snapshot);
  }

  snapshots.sort((left, right) => new Date(left.timestamp).getTime() - new Date(right.timestamp).getTime());
  return snapshots;
}

function ledgerEventToVerificationSnapshot(
  loop: PersistedLoopRecord,
  event: LedgerEvent
): MartinVerificationSnapshot | undefined {
  const payload = isRecord(event.payload) ? event.payload : undefined;
  const matchedAttempt =
    event.attemptIndex !== undefined
      ? loop.attempts.find((attempt) => attempt.index === event.attemptIndex)
      : undefined;

  return {
    ...(matchedAttempt?.attemptId ? { attemptId: matchedAttempt.attemptId } : {}),
    ...(event.attemptIndex !== undefined ? { attemptIndex: event.attemptIndex } : {}),
    timestamp: event.timestamp,
    lifecycleState: loop.lifecycleState,
    ...(typeof payload?.["passed"] === "boolean" ? { passed: payload["passed"] } : {}),
    ...(typeof payload?.["summary"] === "string" ? { summary: payload["summary"] } : {})
  };
}

function verificationSnapshotKey(snapshot: MartinVerificationSnapshot): string {
  if (snapshot.attemptIndex !== undefined) {
    return `attempt:${snapshot.attemptIndex}`;
  }

  if (snapshot.attemptId) {
    return `attempt-id:${snapshot.attemptId}`;
  }

  return `timestamp:${snapshot.timestamp}:summary:${snapshot.summary ?? ""}:passed:${String(snapshot.passed)}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
