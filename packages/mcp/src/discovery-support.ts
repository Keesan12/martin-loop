// SPDX-FileCopyrightText: MartinLoop contributors
//
// SPDX-License-Identifier: Apache-2.0

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
  warnings: string[];
}

export interface MartinVerificationHistorySnapshot {
  loopId: string;
  loop: LoopPreview;
  verificationCount: number;
  latestVerification?: MartinVerificationSnapshot;
  verificationHistory: MartinVerificationSnapshot[];
  warnings: string[];
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

  const verification = buildVerificationSnapshotForAttempt(loop, attempt, ledgerEvents);
  const warnings = collectVerificationSnapshots(loop, ledgerEvents).warnings;

  return {
    loopId: loop.loopId,
    attemptIndex: attempt.index,
    loop: buildPersistedLoopPreview(loop),
    attempt,
    ...(verification ? { verification } : {}),
    warnings
  };
}

export function buildVerificationHistorySnapshot(
  loop: PersistedLoopRecord,
  ledgerEvents: LedgerEvent[] = []
): MartinVerificationHistorySnapshot {
  const collected = collectVerificationSnapshots(loop, ledgerEvents);
  const verificationHistory = collected.snapshots;
  const latestVerification = selectLatestVerificationSnapshot(verificationHistory, collected.warnings);

  return {
    loopId: loop.loopId,
    loop: buildPersistedLoopPreview(loop),
    verificationCount: verificationHistory.length,
    ...(latestVerification ? { latestVerification } : {}),
    verificationHistory,
    warnings: collected.warnings
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
  const matching = collectVerificationSnapshots(loop, ledgerEvents).snapshots.filter((verification) =>
    verification.attemptIndex === attempt.index ||
    (attempt.attemptId !== undefined && verification.attemptId === attempt.attemptId)
  );

  if (hasConflictingStatuses(matching)) {
    return undefined;
  }

  return matching.at(-1);
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
  if (!isTrustedVerificationTimestamp(event.timestamp)) {
    return undefined;
  }

  const payload = isRecord(event.payload) ? event.payload : undefined;
  const attemptId = typeof payload?.["attemptId"] === "string" ? payload["attemptId"] : undefined;
  const attemptIndex =
    typeof payload?.["attemptIndex"] === "number" && Number.isInteger(payload["attemptIndex"])
      ? payload["attemptIndex"]
      : undefined;
  const matchedAttempt = attemptId
    ? loop.attempts.find((attempt) => attempt.attemptId === attemptId)
    : attemptIndex !== undefined
      ? loop.attempts.find((attempt) => attempt.index === attemptIndex)
      : undefined;

  if (!matchedAttempt) {
    return undefined;
  }

  return {
    ...(matchedAttempt.attemptId ? { attemptId: matchedAttempt.attemptId } : {}),
    attemptIndex: matchedAttempt.index,
    timestamp: event.timestamp,
    lifecycleState: event.lifecycleState,
    ...(typeof payload?.["passed"] === "boolean" ? { passed: payload["passed"] } : {}),
    ...(typeof payload?.["summary"] === "string" ? { summary: payload["summary"] } : {})
  };
}

function collectVerificationSnapshots(
  loop: PersistedLoopRecord,
  ledgerEvents: LedgerEvent[]
): { snapshots: MartinVerificationSnapshot[]; warnings: string[] } {
  const seen = new Set<string>();
  const snapshots: MartinVerificationSnapshot[] = [];
  const warnings = getLedgerWarnings(ledgerEvents);
  const futureEvidenceCount = [
    ...getVerificationEvents(loop).map((event) => event.timestamp),
    ...ledgerEvents.filter((candidate) => candidate.kind === "verification.completed").map((event) => event.timestamp)
  ].filter(isFutureVerificationTimestamp).length;

  if (futureEvidenceCount > 0) {
    warnings.push(
      `Ignored ${futureEvidenceCount} future-dated verification evidence item(s) that cannot be trusted yet.`
    );
  }

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
  if (hasConflictingStatusesForLatestAttempt(snapshots)) {
    warnings.push("Verification evidence conflicts for the latest attempt; marking verification as contradicted.");
  }

  return { snapshots, warnings };
}

function ledgerEventToVerificationSnapshot(
  loop: PersistedLoopRecord,
  event: LedgerEvent
): MartinVerificationSnapshot | undefined {
  if (!isTrustedVerificationTimestamp(event.timestamp)) {
    return undefined;
  }

  const payload = isRecord(event.payload) ? event.payload : undefined;
  const matchedAttempt =
    event.attemptIndex !== undefined
      ? loop.attempts.find((attempt) => attempt.index === event.attemptIndex)
      : undefined;

  if (!matchedAttempt) {
    return undefined;
  }

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
  return [
    snapshot.attemptIndex !== undefined ? `attempt:${snapshot.attemptIndex}` : `attempt-id:${snapshot.attemptId ?? ""}`,
    `timestamp:${snapshot.timestamp}`,
    `summary:${snapshot.summary ?? ""}`,
    `passed:${String(snapshot.passed)}`
  ].join(":");
}

function selectLatestVerificationSnapshot(
  snapshots: MartinVerificationSnapshot[],
  warnings: string[]
): MartinVerificationSnapshot | undefined {
  if (warnings.includes("Verification evidence conflicts for the latest attempt; marking verification as contradicted.")) {
    return undefined;
  }
  return snapshots.at(-1);
}

function hasConflictingStatusesForLatestAttempt(snapshots: MartinVerificationSnapshot[]): boolean {
  const latest = snapshots.at(-1);
  if (!latest) {
    return false;
  }

  const latestAttemptSnapshots = snapshots.filter((candidate) =>
    latest.attemptId
      ? candidate.attemptId === latest.attemptId
      : latest.attemptIndex !== undefined
        ? candidate.attemptIndex === latest.attemptIndex
        : false
  );

  return hasConflictingStatuses(latestAttemptSnapshots);
}

function hasConflictingStatuses(snapshots: MartinVerificationSnapshot[]): boolean {
  const statuses = new Set(
    snapshots
      .map((snapshot) => snapshot.passed)
      .filter((status): status is boolean => typeof status === "boolean")
  );
  return statuses.size > 1;
}

function isTrustedVerificationTimestamp(value: string): boolean {
  const timestamp = new Date(value).getTime();
  if (!Number.isFinite(timestamp)) {
    return false;
  }

  return timestamp <= Date.now() + 5 * 60_000;
}

function isFutureVerificationTimestamp(value: string): boolean {
  const timestamp = new Date(value).getTime();
  if (!Number.isFinite(timestamp)) {
    return false;
  }

  return timestamp > Date.now() + 5 * 60_000;
}

function getLedgerWarnings(ledgerEvents: LedgerEvent[]): string[] {
  const diagnostics = ledgerEvents as LedgerEvent[] & { warnings?: unknown };
  return Array.isArray(diagnostics.warnings)
    ? diagnostics.warnings.filter((warning): warning is string => typeof warning === "string")
    : [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
