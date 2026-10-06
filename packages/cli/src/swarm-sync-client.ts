/**
 * sync-client.ts — durable local queue + upload for syncing LoopRecords to a hosted Control Plane.
 *
 * Opt-in: silent no-op unless MARTIN_TELEMETRY_ENDPOINT and MARTIN_API_TOKEN are set.
 *
 * Contracts:
 *   syncLoopToHosted — never throws; all errors are caught and logged to stderr.
 *   flushSyncQueue   — may throw on unrecoverable filesystem errors (permission denied, etc.).
 *   syncQueueStatus  — may throw on unrecoverable filesystem errors.
 *
 * Hosted server contract:
 *   Signed receipts: POST /register-receipt-key first with the locally persisted
 *                    per-run key. Requires receipt_keys:write. Workspace identity
 *                    comes from the bearer token; the secret is never queued.
 *   Run upload:       POST /api/runs/sync with runs:write or telemetry:write.
 *   Dedup:            Server upserts by (workspace_id, loop_id); re-sync updates
 *                    the same logical row and returns HTTP 200.
 *   401/402/403:      Repairable auth, entitlement, or scope rejection — preserve for retry.
 *   409/422:          Trust/payload conflict — permanent.
 *   429:              Rate limit — transient; respect Retry-After if present.
 *   5xx/network:      Transient, retry.
 *
 * Failure modes:
 *   Transient (timeout, offline, 429, 5xx) → item stays in queue for flushSyncQueue().
 *   Permanent trust/payload 4xx             → item moved to quarantine dir with reason.
 *   Repairable auth/entitlement/scope 4xx   → item stays in queue for flushSyncQueue().
 *   Queue full (200 items)                 → oldest by enqueuedAt quarantined; if quarantine
 *                                           fails, new item is NOT enqueued (error logged).
 *   Corrupt queue file                     → quarantined; skipped if quarantine fails.
 *   Oversized payload (> 256 KB)           → rejected before enqueue; logged to stderr.
 *
 * Concurrent process safety:
 *   Items are claimed via an exclusive per-item directory in .inflight/ before upload.
 *   Only the process that creates that directory proceeds to upload.
 *   Stale .inflight items (from crashed processes) are recovered at flush start.
 *
 * Attempt persistence:
 *   attempts and nextRetryNotBefore are persisted to the queue file after each attempt.
 *   FLUSH_MAX_ATTEMPTS is a lifetime cap enforced across separate invocations.
 */

import { createHash, createHmac, randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

import {
  buildSwarmHostedEnvelope,
  type BuiltSwarmHostedEnvelope,
} from "../../core/dist/swarm/hosted-export.js";
import type { LoopRecord } from "@martin/contracts";
import { buildPrivacySafeCoreReceiptBundle, redactHostedSyncValue } from "./sync-privacy.js";
import { buildVerifiedHandoffFromPersistedLoop, loadPersistedLoop } from "./run-store.js";

/** Portable basename — handles both forward and backslash separators on all platforms. @internal */
export function queueFileName(filePath: string): string {
  return filePath.split(/[\\/]/).filter(Boolean).at(-1) ?? `unknown-${Date.now()}.json`;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const QUEUE_MAX_SIZE = 200;
const UPLOAD_TIMEOUT_MS = 10_000;
const FLUSH_MAX_ATTEMPTS = 5;
const BACKOFF_BASE_MS = 1_000;
const BACKOFF_CAP_MS = 30_000;
const RETRY_AFTER_MIN_MS = 1_000;
/**
 * Conservative stale-inflight threshold — well above the upload timeout to avoid
 * reclaiming items from processes still actively uploading.
 */
const CLAIM_STALE_MS = 5 * 60 * 1_000; // 5 minutes
const SWARM_ADMISSION_LOCK_STALE_MS = CLAIM_STALE_MS;
const SWARM_ADMISSION_LOCK_WAIT_MS = 10_000;
const MAX_PAYLOAD_BYTES = 256 * 1_024; // 256 KB
const QUARANTINE_MAX_ITEMS = 500;
const QUARANTINE_MAX_BYTES = 20 * 1_024 * 1_024; // 20 MB

// ---------------------------------------------------------------------------
// Queue directory helpers
// ---------------------------------------------------------------------------

/**
 * Returns the active queue directory.
 * MARTIN_SYNC_QUEUE_DIR is an internal test override — not a supported public env var.
 */
function resolveQueueDir(): string {
  return process.env["MARTIN_SYNC_QUEUE_DIR"] ?? join(homedir(), ".martin", "runs", ".sync-queue");
}

function resolveQuarantineDir(queueDir: string): string {
  return join(queueDir, ".quarantine");
}

function resolveInflightDir(queueDir: string): string {
  return join(queueDir, ".inflight");
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function syncResourceId(item: SyncQueueItem): string {
  return item.resourceKind === "swarm" ? item.resourceId : item.loopId;
}

function isValidSwarmQueueItem(item: unknown): item is SwarmSyncQueueItem {
  if (!isPlainRecord(item) || item["resourceKind"] !== "swarm") return false;
  const canonicalBody = item["canonicalBody"];
  const payloadSha256 = item["payloadSha256"];
  const payloadBytes = item["payloadBytes"];
  const transportKey = item["transportKey"];
  if (typeof item["resourceId"] !== "string"
    || typeof item["envelopeIdentity"] !== "string"
    || typeof canonicalBody !== "string"
    || typeof payloadSha256 !== "string"
    || typeof payloadBytes !== "number"
    || !isPlainRecord(transportKey)
    || typeof transportKey["keyId"] !== "string"
    || typeof transportKey["keyLocatorHash"] !== "string"
    || transportKey["domain"] !== "martin.swarm-hosted.v1") return false;
  if (payloadBytes > MAX_PAYLOAD_BYTES
    || Buffer.byteLength(canonicalBody, "utf8") !== payloadBytes
    || sha256Hex(canonicalBody) !== payloadSha256) return false;
  try {
    const envelope = JSON.parse(canonicalBody) as unknown;
    if (!isPlainRecord(envelope)
      || !isPlainRecord(envelope["swarm"])
      || !isPlainRecord(envelope["transportSignature"])) return false;
    return envelope["envelopeId"] === item["envelopeIdentity"]
      && envelope["swarm"]["swarmId"] === item["resourceId"]
      && envelope["transportSignature"]["keyId"] === transportKey["keyId"]
      && envelope["transportSignature"]["keyLocatorHash"] === transportKey["keyLocatorHash"];
  } catch {
    return false;
  }
}

function resolveReceiptIntegrityRootForSync(): string {
  return process.env["MARTIN_INTEGRITY_KEY_DIR"]?.trim() ??
    join(homedir(), ".martin", "receipt-integrity");
}

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

// Local wire-format types matching the Control Plane POST /api/runs/sync contract.
// Token must be a CP-issued martin_cp_* credential supplied via MARTIN_API_TOKEN.
interface HostedRunEventDraft {
  eventId: string;
  eventType: string;
  occurredAt: string;
  sequence: number;
  attemptId?: string;
  payload?: Record<string, unknown>;
}

interface CoreReceiptIntegrityMaterial {
  schemaVersion: "martin.receipt-integrity.v1";
  runId: string;
  keyId: string;
  signedAt: string;
  scope?: Record<string, unknown>;
  loopRecordSha256: string;
  ledgerSha256: string;
  ledgerHeadHash: string;
  entryCount: number;
  chain: Array<Record<string, unknown>>;
  verifiedHandoffSha256?: string;
  signatureHmacSha256: string;
}

interface CoreReceiptBundle {
  loopRecord: Record<string, unknown>;
  ledgerEntries: Array<Record<string, unknown>>;
  integrity: CoreReceiptIntegrityMaterial;
  verifiedHandoff?: Record<string, unknown>;
}

interface HostedRunSyncDraft {
  loopId: string;
  workspaceId?: string;
  projectId?: string;
  task: { title: string; objective: string };
  status?: string;
  budget?: { spentUsd?: number; avoidedUsd?: number };
  receiptScope?: Record<string, unknown>;
  receiptIntegrity?: CoreReceiptIntegrityMaterial;
  events: HostedRunEventDraft[];
  syncedAt?: string;
  coreReceipt?: CoreReceiptBundle;
}

interface SyncQueueBase {
  queueId: string;
  enqueuedAt: string;           // ISO 8601 — chronological sort key
  attempts: number;             // persisted across flush invocations
  lastAttemptAt?: string;
  nextRetryNotBefore?: string;  // persisted backoff — item skipped if this is in the future
  payloadBytes: number;         // pre-validated at enqueue
}

interface RunSyncQueueItem extends SyncQueueBase {
  /** Missing is the immutable legacy wire shape. */
  resourceKind?: "run";
  loopId: string;
  payload: HostedRunSyncDraft;
  /**
   * Non-secret locator for the local per-run receipt key.
   * The signing secret itself is NEVER persisted in the sync queue.
   */
  receiptKey?: {
    keyId: string;
    runsRootHash: string;
  };
}

interface SwarmSyncQueueItem extends SyncQueueBase {
  resourceKind: "swarm";
  resourceId: string;
  canonicalBody: string;
  payloadSha256: string;
  envelopeIdentity: string;
  transportKey: {
    keyId: string;
    keyLocatorHash: string;
    domain: "martin.swarm-hosted.v1";
  };
}

interface SwarmAdmissionIndex {
  schemaVersion: "martin.swarm-sync-admission.v1";
  resourceId: string;
  queueId: string;
  envelopeIdentity: string;
  payloadSha256: string;
  canonicalBodySha256: string;
  createdAt: string;
}

type SyncQueueItem = RunSyncQueueItem | SwarmSyncQueueItem;

interface SafeHostedSyncError {
  status?: number;
  error?: string;
  reason?: string;
  upgradeUrl?: string;
  retryAfter?: string;
  kind: "rejected" | "rate_limited" | "temporary" | "network";
  stage: "receipt-key registration" | "run upload" | "swarm-key registration" | "swarm upload";
}

type UploadResult =
  | { ok: true }
  | {
      ok: false;
      permanent: boolean;
      retryAfterMs?: number;
      failure: SafeHostedSyncError;
    };

// ---------------------------------------------------------------------------
// Receipt transport
// ---------------------------------------------------------------------------

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function stringField(record: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = record?.[key];
  return typeof value === "string" ? value : undefined;
}

function resolveRunsRootForReceipt(loop: LoopRecord): string {
  const receiptRunsRoot = loop.receiptScope?.runsRoot?.trim();
  if (receiptRunsRoot) return receiptRunsRoot;

  const configuredRunsRoot = process.env["MARTIN_RUNS_DIR"]?.trim();
  if (configuredRunsRoot) return configuredRunsRoot;

  return join(homedir(), ".martin", "runs");
}

async function readPersistedCoreReceiptBundle(loop: LoopRecord): Promise<CoreReceiptBundle | undefined> {
  const runsRoot = resolveRunsRootForReceipt(loop);
  const runRoot = join(runsRoot, loop.loopId);
  try {
    const [loopRecordRaw, ledgerRaw, integrityRaw] = await Promise.all([
      readFile(join(runRoot, "loop.json"), "utf8"),
      readFile(join(runRoot, "ledger.jsonl"), "utf8"),
      readFile(join(runRoot, "receipt-integrity.json"), "utf8"),
    ]);

    const loopRecord = JSON.parse(loopRecordRaw) as unknown;
    const integrity = JSON.parse(integrityRaw) as unknown;
    const ledgerEntries = ledgerRaw
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line) as unknown);

    if (
      !isPlainRecord(loopRecord) ||
      !isPlainRecord(integrity) ||
      integrity["schemaVersion"] !== "martin.receipt-integrity.v1" ||
      integrity["runId"] !== loop.loopId ||
      ledgerEntries.some((entry) => !isPlainRecord(entry))
    ) {
      return undefined;
    }

    const detail = await loadPersistedLoop({ loopId: loop.loopId, runsDir: runsRoot });
    if (detail.integrity.state !== "verified") return undefined;
    const verifiedHandoff = buildVerifiedHandoffFromPersistedLoop(detail) as unknown as Record<string, unknown>;
    return await buildPrivacySafeCoreReceiptBundle({
      runsRoot,
      loopRecord,
      ledgerEntries: ledgerEntries as Array<Record<string, unknown>>,
      integrity: integrity as unknown as CoreReceiptIntegrityMaterial,
      verifiedHandoff,
    });
  } catch {
    return undefined;
  }
}

function projectReceiptEvents(entries: unknown[]): HostedRunEventDraft[] {
  return entries.flatMap((candidate, index) => {
    if (!isPlainRecord(candidate)) return [];
    const entry = candidate;
    const eventId = stringField(entry, "eventId");
    const eventType = stringField(entry, "type") ?? stringField(entry, "kind");
    const occurredAt = stringField(entry, "timestamp");
    if (!eventId || !eventType || !occurredAt) return [];

    const attemptId = stringField(entry, "attemptId");
    const payload = isPlainRecord(entry["payload"]) ? entry["payload"] : undefined;
    return [{
      eventId,
      eventType,
      occurredAt,
      sequence: index,
      ...(attemptId ? { attemptId } : {}),
      ...(payload ? { payload } : {}),
    }];
  });
}

function buildReceiptBoundEvents(coreReceipt: CoreReceiptBundle): HostedRunEventDraft[] {
  const signedLoopEvents = Array.isArray(coreReceipt.loopRecord["events"])
    ? projectReceiptEvents(coreReceipt.loopRecord["events"])
    : [];
  if (signedLoopEvents.length > 0) return signedLoopEvents;

  // Older signed receipts may carry event identifiers in their ledger. Keep
  // that compatibility path, but never invent identifiers for canonical
  // ledgers whose schema intentionally omits them.
  return projectReceiptEvents(coreReceipt.ledgerEntries);
}

function receiptCanBindHostedDraft(coreReceipt: CoreReceiptBundle, events: HostedRunEventDraft[]): boolean {
  const task = isPlainRecord(coreReceipt.loopRecord["task"])
    ? coreReceipt.loopRecord["task"]
    : undefined;
  return events.length > 0 &&
    typeof coreReceipt.loopRecord["updatedAt"] === "string" &&
    typeof coreReceipt.loopRecord["status"] === "string" &&
    typeof task?.["title"] === "string" &&
    typeof task?.["objective"] === "string";
}

// ---------------------------------------------------------------------------
// Payload builder
// ---------------------------------------------------------------------------

function buildIngestBody(
  loop: LoopRecord,
  _runtimeVersion: string,
  persistedReceipt?: CoreReceiptBundle
): HostedRunSyncDraft {
  const receiptEvents = persistedReceipt ? buildReceiptBoundEvents(persistedReceipt) : [];
  const coreReceipt = persistedReceipt && receiptCanBindHostedDraft(persistedReceipt, receiptEvents)
    ? persistedReceipt
    : undefined;

  if (coreReceipt) {
    const signedTask = coreReceipt.loopRecord["task"] as Record<string, unknown>;
    const signedCost = isPlainRecord(coreReceipt.loopRecord["cost"])
      ? coreReceipt.loopRecord["cost"]
      : undefined;
    const spentUsd = finiteNumber(signedCost?.["actualUsd"]);
    const avoidedUsd = finiteNumber(signedCost?.["avoidedUsd"]);
    const workspaceId = stringField(coreReceipt.loopRecord, "workspaceId");
    const projectId = stringField(coreReceipt.loopRecord, "projectId");
    const status = stringField(coreReceipt.loopRecord, "status");
    const syncedAt = stringField(coreReceipt.loopRecord, "updatedAt")!;
    const receiptScope = isPlainRecord(coreReceipt.loopRecord["receiptScope"])
      ? coreReceipt.loopRecord["receiptScope"]
      : undefined;
    const budget = spentUsd !== undefined || avoidedUsd !== undefined
      ? {
          ...(spentUsd !== undefined ? { spentUsd } : {}),
          ...(avoidedUsd !== undefined ? { avoidedUsd } : {}),
        }
      : undefined;

    return {
      loopId: loop.loopId,
      ...(workspaceId ? { workspaceId } : {}),
      ...(projectId ? { projectId } : {}),
      task: {
        title: signedTask["title"] as string,
        objective: signedTask["objective"] as string,
      },
      ...(status ? { status } : {}),
      ...(budget ? { budget } : {}),
      ...(receiptScope ? { receiptScope } : {}),
      receiptIntegrity: coreReceipt.integrity,
      events: receiptEvents,
      syncedAt,
      coreReceipt,
    };
  }

  const runCompletedEvent = loop.events?.find((event) => event.type === "run.completed");
  const runStartedEvent = loop.events?.find((event) => event.type === "run.started");
  const runCompletedPayload = isPlainRecord(runCompletedEvent?.payload) ? runCompletedEvent.payload : undefined;
  const runStartedPayload = isPlainRecord(runStartedEvent?.payload) ? runStartedEvent.payload : undefined;
  const events: HostedRunEventDraft[] = [];

  // Always-present lifecycle snapshot — guarantees events[] is never empty.
  events.push({
    eventId: `evt_run_synced_${loop.loopId}`,
    eventType: "run.synced",
    occurredAt: loop.updatedAt ?? loop.createdAt,
    sequence: 0,
    payload: {
      lifecycleState: loop.lifecycleState,
      status: loop.status,
      ...(typeof runCompletedPayload?.["failureClass"] === "string" && {
        failureClass: runCompletedPayload["failureClass"],
      }),
      ...(typeof runCompletedPayload?.["reason"] === "string" && {
        failureReason: runCompletedPayload["reason"],
      }),
      ...(typeof runCompletedPayload?.["reasonCode"] === "string" && {
        reasonCode: runCompletedPayload["reasonCode"],
      }),
      ...(typeof runStartedPayload?.["adapterId"] === "string" && {
        adapterId: runStartedPayload["adapterId"],
      }),
    },
  });

  const settledModel = loop.cost?.providerSettlement?.model;

  // One event per attempt — taxonomy locked 2026-08-21.
  for (const attempt of loop.attempts) {
    const eventType = attempt.failureClass != null ? "attempt.failed" : "attempt.completed";
    events.push({
      eventId: `evt_attempt_${attempt.attemptId}`,
      eventType,
      occurredAt: attempt.completedAt ?? attempt.startedAt,
      sequence: attempt.index + 1,
      attemptId: attempt.attemptId,
      payload: {
        ...(attempt.failureClass != null && { failureClass: attempt.failureClass }),
        ...(attempt.summary != null && { summary: attempt.summary }),
        // Provider settlement is run-level evidence; this does not claim per-attempt model accuracy.
        ...(settledModel != null && { model: settledModel }),
        ...(attempt.adapterId != null && { adapterId: attempt.adapterId }),
      },
    });
  }

  const spentUsd = finiteNumber(loop.cost?.actualUsd);
  const avoidedUsd = finiteNumber(loop.cost?.avoidedUsd);
  const budget = spentUsd !== undefined || avoidedUsd !== undefined
    ? {
        ...(spentUsd !== undefined ? { spentUsd } : {}),
        ...(avoidedUsd !== undefined ? { avoidedUsd } : {}),
      }
    : undefined;
  const rawDraft: HostedRunSyncDraft = {
    loopId: loop.loopId,
    workspaceId: loop.workspaceId,
    projectId: loop.projectId,
    task: {
      title: loop.task.title || loop.task.objective || "(untitled)",
      objective: loop.task.objective || loop.task.title || "(untitled)",
    },
    status: loop.status,
    ...(budget ? { budget } : {}),
    ...(loop.receiptScope ? { receiptScope: loop.receiptScope as unknown as Record<string, unknown> } : {}),
    events,
    syncedAt: new Date().toISOString(),
  };

  return redactHostedSyncValue(rawDraft) as HostedRunSyncDraft;
}

// ---------------------------------------------------------------------------
// Atomic write — all queue file writes go through this helper
// ---------------------------------------------------------------------------

async function atomicWriteJson(filePath: string, data: unknown): Promise<void> {
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, JSON.stringify(data), "utf8");
  await rename(tmp, filePath);
}

// ---------------------------------------------------------------------------
// Inflight filename protocol
// ---------------------------------------------------------------------------

/**
 * Structured inflight filename: <claimedAtEpochMs>.<claimUuid>.<queueId>.json
 *
 * The claim timestamp and owner UUID are encoded in the rename destination, so they
 * are established by the same atomic OS rename that acquires ownership. Nothing is
 * written after the rename — the filename itself is the authoritative claim record.
 *
 * Legacy inflight filenames (<queueId>.json) are handled separately and conservatively.
 */
const INFLIGHT_RE = /^(\d+)\.([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.json$/i;
/**
 * Claim directories are generation-aware:
 *   <queueId>.<claimId>.claim  current owned claim
 *   <queueId>.claim            acquisition reservation and legacy claim
 *
 * The stable reservation path serializes the Windows rename, while every owner
 * receives a unique terminal path. A recovered owner can therefore never delete,
 * requeue, quarantine, or rewrite a later owner's replacement claim.
 */
const CLAIM_DIR_RE = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:\.([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}))?\.claim$/i;

interface InflightMeta {
  claimedAtMs: number;
  claimId: string;
  queueId: string;
}

function parseInflightName(name: string): InflightMeta | null {
  const m = INFLIGHT_RE.exec(name);
  if (!m) return null;
  return {
    claimedAtMs: Number(m[1]),
    claimId: m[2]!,
    queueId: m[3]!,
  };
}

function queueIdFromClaimPath(filePath: string): string | undefined {
  if (basename(filePath) !== "item.json") return undefined;
  return CLAIM_DIR_RE.exec(basename(dirname(filePath)))?.[1];
}

// ---------------------------------------------------------------------------
// Queue listing
// ---------------------------------------------------------------------------

/**
 * Lists .json filenames in dir.
 * Treats ENOENT as empty. All other errors (permissions, I/O) propagate — they are not "empty".
 */
async function safeListQueue(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir);
    return entries.filter((f) => f.endsWith(".json"));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
}

/**
 * Returns all parseable queue items sorted by enqueuedAt ascending (oldest first).
 * Unparseable files are silently excluded — callers identify them via safeListQueue diff.
 */
async function listQueueOldestFirst(
  queueDir: string
): Promise<Array<{ file: string; item: SyncQueueItem }>> {
  const files = await safeListQueue(queueDir);
  const results = await Promise.all(
    files.map(async (f) => {
      try {
        const raw = await readFile(join(queueDir, f), "utf8");
        const item = JSON.parse(raw) as SyncQueueItem;
        if (typeof item.enqueuedAt !== "string") return null;
        if (item.resourceKind === "swarm") {
          if (!isValidSwarmQueueItem(item)) return null;
        } else if ((item.resourceKind !== undefined && item.resourceKind !== "run") || typeof item.loopId !== "string") return null;
        return { file: f, item };
      } catch (err) {
        if (err instanceof SyntaxError) return null; // corrupt JSON — quarantined later by flush
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return null; // vanished between readdir/readFile
        throw err; // permission/IO error — propagate
      }
    })
  );
  return results
    .filter((x): x is { file: string; item: SyncQueueItem } => x !== null)
    .sort((a, b) => a.item.enqueuedAt.localeCompare(b.item.enqueuedAt));
}

// ---------------------------------------------------------------------------
// Retry-After parsing — safe against malformed, negative, and extreme values
// ---------------------------------------------------------------------------

function parseRetryAfterMs(headerValue: string | null): number | undefined {
  if (!headerValue) return undefined;
  const asSeconds = Number(headerValue);
  const ms = Number.isFinite(asSeconds)
    ? asSeconds * 1_000
    : Date.parse(headerValue) - Date.now();
  if (!Number.isFinite(ms) || ms <= 0) return undefined; // malformed/negative → fall back to backoff
  return Math.min(Math.max(ms, RETRY_AFTER_MIN_MS), BACKOFF_CAP_MS);
}

// ---------------------------------------------------------------------------
// Atomic claiming — prevents concurrent upload of same item
// ---------------------------------------------------------------------------

/**
 * In-process serialization for concurrent claim attempts.
 *
 * Cross-process ownership is guaranteed by exclusive creation of a stable claim directory.
 * This Set provides additional in-process serialization: it is checked and updated
 * synchronously (no await before the check-and-add), so it is atomic within the JS
 * event loop and prevents two coroutines in the same process from both submitting
 * renames for the same source path to the OS I/O queue simultaneously.
 *
 * Keyed by the canonical full source path, not only queueId, to ensure correct
 * scoping when multiple queue directories are active (e.g., in tests).
 */
const activeClaimPaths = new Set<string>();
let claimTransitionHookForTests: (() => Promise<void>) | undefined;
let releaseIdentityResolvedHookForTests: (() => Promise<void>) | undefined;

/** @internal Deterministic race seam for the queue claim-transition test only. */
export function setSwarmClaimTransitionHookForTests(hook?: () => Promise<void>): void {
  claimTransitionHookForTests = hook;
}

/** @internal Deterministic race seam for the stale-owner release fence test only. */
export function setSwarmReleaseIdentityResolvedHookForTests(hook?: () => Promise<void>): void {
  releaseIdentityResolvedHookForTests = hook;
}

/**
 * Atomically claims a queue item by exclusively creating .inflight/<queueId>.claim,
 * moving the item inside it, then renaming that reservation to the generation-specific
 * .inflight/<queueId>.<claimId>.claim path. The stable reservation is required on
 * Windows: competing renames of one source to different destinations can both report
 * success. The unique owned path fences every later terminal operation from replacement
 * claims for the same queueId.
 *
 * Returns the inflight path on success; undefined if another worker won the race
 * (ENOENT from OS rename, or in-process serialization lock already held).
 */
async function claimItem(file: string, queueDir: string): Promise<string | undefined> {
  // Validate file is exactly <uuid>.json — guards against path traversal.
  if (!file.endsWith(".json")) return undefined;
  const queueId = file.slice(0, -5);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(queueId)) {
    return undefined;
  }

  const src = join(queueDir, file);
  const initialSwarmIdentity = await readSwarmItemIdentity(src);
  if (initialSwarmIdentity) {
    return withSwarmAdmissionLock(queueDir, initialSwarmIdentity.resourceId, async () => {
      const lockedIdentity = await readSwarmItemIdentity(src);
      if (!lockedIdentity
        || lockedIdentity.resourceId !== initialSwarmIdentity.resourceId
        || lockedIdentity.queueId !== initialSwarmIdentity.queueId
        || lockedIdentity.envelopeIdentity !== initialSwarmIdentity.envelopeIdentity
        || lockedIdentity.payloadSha256 !== initialSwarmIdentity.payloadSha256
        || lockedIdentity.canonicalBodySha256 !== initialSwarmIdentity.canonicalBodySha256) {
        return undefined;
      }
      return claimItemUnlocked(file, queueDir, src, true);
    });
  }
  return claimItemUnlocked(file, queueDir, src, false);
}

async function claimItemUnlocked(
  file: string,
  queueDir: string,
  src: string,
  swarmTransition: boolean,
): Promise<string | undefined> {
  const queueId = file.slice(0, -5);

  // In-process serialization: checked and set synchronously before the first await,
  // so this is atomic within the JS event loop. Keyed by full source path.
  if (activeClaimPaths.has(src)) return undefined;
  activeClaimPaths.add(src);

  try {
    const inflightDir = resolveInflightDir(queueDir);
    await mkdir(inflightDir, { recursive: true });

    const reservationDir = join(inflightDir, `${queueId}.claim`);
    try {
      await mkdir(reservationDir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") return undefined;
      throw err;
    }
    const reservedItemPath = join(reservationDir, "item.json");

    try {
      await rename(src, reservedItemPath);
    } catch (err) {
      await rm(reservationDir, { recursive: true, force: true });
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw err;
    }

    if (swarmTransition) await claimTransitionHookForTests?.();

    const claimId = randomUUID();
    const ownedClaimDir = join(inflightDir, `${queueId}.${claimId}.claim`);
    try {
      await rename(reservationDir, ownedClaimDir);
      return join(ownedClaimDir, "item.json");
    } catch (err) {
      // The queue item is already inside our reservation. Put it back before
      // propagating an ownership-publication failure so it is never stranded.
      await releaseItemUnlocked(reservedItemPath, queueDir, "requeue");
      throw err;
    }
  } finally {
    activeClaimPaths.delete(src);
  }
}

/**
 * Releases a claimed item: either marks it done (deletes it) or requeues it.
 * Only ENOENT is treated as a safe race condition — other errors propagate.
 */
async function releaseItem(
  inflightPath: string,
  queueDir: string,
  outcome: "requeue" | "done"
): Promise<void> {
  const swarmIdentity = await readSwarmItemIdentity(inflightPath);
  if (swarmIdentity) {
    await releaseIdentityResolvedHookForTests?.();
    await withSwarmAdmissionLock(queueDir, swarmIdentity.resourceId, async () => {
      const lockedIdentity = await readSwarmItemIdentity(inflightPath);
      if (!lockedIdentity
        || lockedIdentity.resourceId !== swarmIdentity.resourceId
        || lockedIdentity.queueId !== swarmIdentity.queueId
        || lockedIdentity.envelopeIdentity !== swarmIdentity.envelopeIdentity
        || lockedIdentity.payloadSha256 !== swarmIdentity.payloadSha256
        || lockedIdentity.canonicalBodySha256 !== swarmIdentity.canonicalBodySha256) {
        return;
      }
      await releaseItemUnlocked(inflightPath, queueDir, outcome, lockedIdentity);
    });
    return;
  }
  await releaseItemUnlocked(inflightPath, queueDir, outcome);
}

async function releaseItemUnlocked(
  inflightPath: string,
  queueDir: string,
  outcome: "requeue" | "done",
  knownSwarmIdentity?: Awaited<ReturnType<typeof readSwarmItemIdentity>>,
): Promise<void> {
  if (outcome === "done") {
    const swarmIdentity = knownSwarmIdentity ?? await readSwarmItemIdentity(inflightPath);
    const claimQueueId = queueIdFromClaimPath(inflightPath);
    if (claimQueueId) await rm(dirname(inflightPath), { recursive: true, force: true });
    else await rm(inflightPath, { force: true });
    if (swarmIdentity) await clearSwarmAdmissionIndexUnlocked(queueDir, swarmIdentity);
    return;
  }
  // Extract the original <queueId>.json name from the inflight filename.
  // New format: <epochMs>.<claimUuid>.<queueId>.json → requeue as <queueId>.json
  // Legacy format: <queueId>.json → requeue as-is
  const claimQueueId = queueIdFromClaimPath(inflightPath);
  const base = queueFileName(inflightPath);
  const meta = parseInflightName(base);
  const queueFile = claimQueueId ? `${claimQueueId}.json` : meta ? `${meta.queueId}.json` : base;
  const dest = join(queueDir, queueFile);
  try {
    await rename(inflightPath, dest);
    if (claimQueueId) await rm(dirname(inflightPath), { recursive: true, force: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      if (claimQueueId) await rm(dirname(inflightPath), { recursive: true, force: true });
      return;
    }
    process.stderr.write(
      `[martin sync] Failed to requeue ${queueFile}: ${err instanceof Error ? err.message : String(err)}\n`
    );
    throw err;
  }
}

/**
 * Recovers .inflight items abandoned by crashed or killed processes.
 *
 * New-format claims (<claimedAtMs>.<claimUuid>.<queueId>.json): staleness is determined
 * from the epoch timestamp encoded in the filename — the same atomic rename that acquired
 * ownership established this timestamp, so it can never be confused with the original
 * queue-write mtime.
 *
 * Legacy-format claims (<queueId>.json): fall back to file mtime conservatively.
 * This path exists only for inflight files created before this protocol was introduced.
 *
 * Called at the start of every flushSyncQueue() before any new claims are made.
 */
async function recoverStaleInflight(queueDir: string): Promise<void> {
  const inflightDir = resolveInflightDir(queueDir);
  let entries: string[];
  try {
    entries = await readdir(inflightDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
    throw err;
  }
  for (const entry of entries) {
    const claimMatch = CLAIM_DIR_RE.exec(entry);
    if (claimMatch) {
      const claimDir = join(inflightDir, entry);
      try {
        const s = await stat(claimDir);
        if (Date.now() - s.mtimeMs > CLAIM_STALE_MS) {
          const itemPath = join(claimDir, "item.json");
          try {
            await releaseItem(itemPath, queueDir, "requeue");
          } catch (err) {
            if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
            await rm(claimDir, { recursive: true, force: true });
          }
          process.stderr.write(`[martin sync] Recovered stale claim directory: ${entry}\n`);
        }
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      }
      continue;
    }
    if (!entry.endsWith(".json")) continue;
    const p = join(inflightDir, entry);
    try {
      const meta = parseInflightName(entry);
      if (meta) {
        // New format: staleness from the atomically-established claim timestamp in the name.
        if (Date.now() - meta.claimedAtMs > CLAIM_STALE_MS) {
          await releaseItem(p, queueDir, "requeue");
          process.stderr.write(`[martin sync] Recovered stale inflight item: ${entry}\n`);
        }
      } else {
        // Legacy format: fall back to mtime conservatively.
        const s = await stat(p);
        if (Date.now() - s.mtimeMs > CLAIM_STALE_MS) {
          await releaseItem(p, queueDir, "requeue");
          process.stderr.write(`[martin sync] Recovered stale legacy inflight item: ${entry}\n`);
        }
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw err;
    }
  }
}

// ---------------------------------------------------------------------------
// Quarantine — bounded, never deletes source on failure
// ---------------------------------------------------------------------------

async function enforceQuarantineBounds(quarantineDir: string): Promise<void> {
  const files = await safeListQueue(quarantineDir);
  if (files.length === 0) return;

  const fileStats = await Promise.all(
    files.map(async (f) => {
      try {
        const s = await stat(join(quarantineDir, f));
        return { file: f, size: s.size, mtime: s.mtimeMs };
      } catch {
        return { file: f, size: 0, mtime: Date.now() };
      }
    })
  );
  fileStats.sort((a, b) => a.mtime - b.mtime); // oldest first

  let totalItems = fileStats.length;
  let totalBytes = fileStats.reduce((acc, f) => acc + f.size, 0);

  for (const f of fileStats) {
    if (totalItems <= QUARANTINE_MAX_ITEMS && totalBytes <= QUARANTINE_MAX_BYTES) break;
    try {
      await rm(join(quarantineDir, f.file), { force: true });
      await rm(`${join(quarantineDir, f.file)}.reason`, { force: true });
      process.stderr.write(`[martin sync] Quarantine cap: purged ${f.file}\n`);
      totalItems--;
      totalBytes -= f.size;
    } catch (err) {
      process.stderr.write(`[martin sync] Quarantine cap: delete failed for ${f.file}: ${err instanceof Error ? err.message : String(err)}\n`);
      break; // stop on delete errors — don't loop on a broken filesystem
    }
  }
}

/**
 * Moves filePath to the quarantine directory.
 * Returns true if the move succeeded; false if it failed (source file is left intact).
 * NEVER deletes the source file if quarantine fails.
 */
async function quarantine(filePath: string, queueDir: string, reason: string): Promise<boolean> {
  const swarmIdentity = await readSwarmItemIdentity(filePath);
  const dir = resolveQuarantineDir(queueDir);
  try {
    await mkdir(dir, { recursive: true });
  } catch (err) {
    process.stderr.write(
      `[martin sync] Cannot create quarantine dir: ${err instanceof Error ? err.message : String(err)}\n`
    );
    return false; // source file intact
  }

  // Normalize quarantine filename: strip inflight metadata so quarantine entries are
  // named <queueId>.json regardless of whether the source was a queue or inflight file.
  const claimQueueId = queueIdFromClaimPath(filePath);
  const rawName = queueFileName(filePath);
  const meta = parseInflightName(rawName);
  const name = claimQueueId ? `${claimQueueId}.json` : meta ? `${meta.queueId}.json` : rawName;
  const dest = join(dir, name);

  try {
    await rename(filePath, dest);
    if (claimQueueId) await rm(dirname(filePath), { recursive: true, force: true });
  } catch (err) {
    process.stderr.write(
      `[martin sync] Cannot quarantine ${name}: ${err instanceof Error ? err.message : String(err)}. Record left in place.\n`
    );
    return false; // source file intact — never deleted on failure
  }

  // Non-fatal post-move operations: failure here doesn't undo the quarantine
  try {
    await atomicWriteJson(`${dest}.reason`, { reason, quarantinedAt: new Date().toISOString() });
  } catch (err) {
    process.stderr.write(
      `[martin sync] Quarantine reason write failed for ${name}: ${err instanceof Error ? err.message : String(err)}\n`
    );
  }
  try {
    await enforceQuarantineBounds(dir);
  } catch (err) {
    process.stderr.write(
      `[martin sync] Quarantine bounds enforcement failed: ${err instanceof Error ? err.message : String(err)}\n`
    );
  }

  if (swarmIdentity) await clearSwarmAdmissionIndex(queueDir, swarmIdentity);

  return true;
}

// ---------------------------------------------------------------------------
// Enqueue
// ---------------------------------------------------------------------------

async function enqueue(item: SyncQueueItem, queueDir: string): Promise<void> {
  await mkdir(queueDir, { recursive: true });

  // Cap: quarantine the oldest item (by enqueuedAt) to make room
  const existing = await listQueueOldestFirst(queueDir);
  if (existing.length >= QUEUE_MAX_SIZE) {
    const oldest = existing[0]!;
    process.stderr.write(
      `[martin sync] Queue full (${QUEUE_MAX_SIZE} items). Quarantining oldest: ${oldest.file}\n`
    );
    const moved = await quarantine(join(queueDir, oldest.file), queueDir, "queue_full");
    if (!moved) {
      // Cannot make room — refuse to exceed the cap
      throw new Error(
        `Queue full (${QUEUE_MAX_SIZE} items) and oldest item could not be quarantined — new record dropped.`
      );
    }
  }

  const filePath = join(queueDir, `${item.queueId}.json`);
  await atomicWriteJson(filePath, item);
}

function swarmAdmissionLockPath(queueDir: string, resourceId: string): string {
  return join(queueDir, ".swarm-admission", `${sha256Hex(resourceId)}.lock`);
}

function swarmAdmissionIndexPath(queueDir: string, resourceId: string): string {
  return join(queueDir, ".swarm-admission", `${sha256Hex(resourceId)}.json`);
}

async function withSwarmAdmissionLock<T>(
  queueDir: string,
  resourceId: string,
  action: () => Promise<T>,
): Promise<T> {
  const lockRoot = join(queueDir, ".swarm-admission");
  const lockPath = swarmAdmissionLockPath(queueDir, resourceId);
  const owner = randomUUID();
  const deadline = Date.now() + SWARM_ADMISSION_LOCK_WAIT_MS;
  await mkdir(lockRoot, { recursive: true });

  while (true) {
    try {
      await mkdir(lockPath);
      await writeFile(join(lockPath, "owner"), `${owner}\n`, { encoding: "utf8", flag: "wx" });
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      try {
        const details = await stat(lockPath);
        if (Date.now() - details.mtimeMs > SWARM_ADMISSION_LOCK_STALE_MS) {
          const stalePath = `${lockPath}.stale-${randomUUID()}`;
          try {
            await rename(lockPath, stalePath);
            await rm(stalePath, { recursive: true, force: true });
            continue;
          } catch (recoveryError) {
            if ((recoveryError as NodeJS.ErrnoException).code === "ENOENT") continue;
            throw recoveryError;
          }
        }
      } catch (statError) {
        if ((statError as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw statError;
      }
      if (Date.now() >= deadline) {
        throw Object.assign(new Error("Timed out waiting for same-swarm sync admission."), {
          code: "SWARM_SYNC_ADMISSION_BUSY",
        });
      }
      await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 10));
    }
  }

  try {
    return await action();
  } finally {
    try {
      const persistedOwner = (await readFile(join(lockPath, "owner"), "utf8")).trim();
      if (persistedOwner === owner) await rm(lockPath, { recursive: true, force: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

async function readSwarmItemIdentity(filePath: string): Promise<{
  resourceId: string;
  queueId: string;
  envelopeIdentity: string;
  payloadSha256: string;
  canonicalBodySha256: string;
} | undefined> {
  try {
    const parsed = JSON.parse(await readFile(filePath, "utf8")) as unknown;
    if (!isPlainRecord(parsed)
      || parsed["resourceKind"] !== "swarm"
      || typeof parsed["resourceId"] !== "string"
      || typeof parsed["queueId"] !== "string"
      || typeof parsed["envelopeIdentity"] !== "string"
      || typeof parsed["payloadSha256"] !== "string"
      || typeof parsed["canonicalBody"] !== "string") return undefined;
    return {
      resourceId: parsed["resourceId"],
      queueId: parsed["queueId"],
      envelopeIdentity: parsed["envelopeIdentity"],
      payloadSha256: parsed["payloadSha256"],
      canonicalBodySha256: sha256Hex(parsed["canonicalBody"]),
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" || error instanceof SyntaxError) return undefined;
    throw error;
  }
}

function isValidSwarmAdmissionIndex(value: unknown, resourceId: string): value is SwarmAdmissionIndex {
  return isPlainRecord(value)
    && value["schemaVersion"] === "martin.swarm-sync-admission.v1"
    && value["resourceId"] === resourceId
    && typeof value["queueId"] === "string"
    && typeof value["envelopeIdentity"] === "string"
    && typeof value["payloadSha256"] === "string"
    && typeof value["canonicalBodySha256"] === "string"
    && typeof value["createdAt"] === "string";
}

async function readSwarmAdmissionIndex(
  queueDir: string,
  resourceId: string,
): Promise<{ value: unknown; mtimeMs: number } | undefined> {
  const path = swarmAdmissionIndexPath(queueDir, resourceId);
  try {
    const [raw, details] = await Promise.all([readFile(path, "utf8"), stat(path)]);
    return { value: JSON.parse(raw) as unknown, mtimeMs: details.mtimeMs };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    if (error instanceof SyntaxError) {
      const details = await stat(path);
      return { value: undefined, mtimeMs: details.mtimeMs };
    }
    throw error;
  }
}

async function hasActiveSwarmItem(queueDir: string, resourceId: string): Promise<boolean> {
  const paths: string[] = (await safeListQueue(queueDir)).map((file) => join(queueDir, file));
  const inflightDir = resolveInflightDir(queueDir);
  try {
    for (const entry of await readdir(inflightDir)) {
      if (entry.endsWith(".claim")) paths.push(join(inflightDir, entry, "item.json"));
      else if (entry.endsWith(".json")) paths.push(join(inflightDir, entry));
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  for (const path of paths) {
    const identity = await readSwarmItemIdentity(path);
    if (identity?.resourceId === resourceId) return true;
  }
  return false;
}

async function clearSwarmAdmissionIndex(
  queueDir: string,
  identity: { resourceId: string; queueId: string },
): Promise<void> {
  await withSwarmAdmissionLock(queueDir, identity.resourceId, async () => {
    await clearSwarmAdmissionIndexUnlocked(queueDir, identity);
  });
}

async function clearSwarmAdmissionIndexUnlocked(
  queueDir: string,
  identity: { resourceId: string; queueId: string },
): Promise<void> {
  const indexed = await readSwarmAdmissionIndex(queueDir, identity.resourceId);
  if (indexed && isValidSwarmAdmissionIndex(indexed.value, identity.resourceId)
    && indexed.value.queueId === identity.queueId) {
    await rm(swarmAdmissionIndexPath(queueDir, identity.resourceId), { force: true });
  }
}

// ---------------------------------------------------------------------------
// HTTP upload
// ---------------------------------------------------------------------------

function safeHostedErrorText(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.replace(/[\u0000-\u001f\u007f]+/gu, " ").trim();
  return normalized.length > 0 ? normalized.slice(0, 512) : undefined;
}

async function readSafeHostedError(response: Response): Promise<{
  error?: string;
  reason?: string;
  upgradeUrl?: string;
  retryAfter?: string;
}> {
  try {
    const parsed = JSON.parse(await response.text()) as unknown;
    if (!isPlainRecord(parsed)) return {};
    const error = safeHostedErrorText(parsed["error"]);
    const reason = safeHostedErrorText(parsed["reason"]);
    const upgradeCandidate = safeHostedErrorText(parsed["upgradeUrl"]);
    let upgradeUrl: string | undefined;
    if (upgradeCandidate) {
      try {
        const url = new URL(upgradeCandidate);
        if (url.protocol === "https:" || url.protocol === "http:") upgradeUrl = url.toString();
      } catch {
        // Ignore malformed or non-URL upgrade hints.
      }
    }
    const retryAfterValue = parsed["retryAfter"];
    const retryAfter = safeHostedErrorText(
      typeof retryAfterValue === "number" && Number.isFinite(retryAfterValue)
        ? String(retryAfterValue)
        : retryAfterValue
    );
    return {
      ...(error ? { error } : {}),
      ...(reason ? { reason } : {}),
      ...(upgradeUrl ? { upgradeUrl } : {}),
      ...(retryAfter ? { retryAfter } : {}),
    };
  } catch {
    return {};
  }
}

async function classifyHostedFailure(
  response: Response,
  stage: SafeHostedSyncError["stage"]
): Promise<Exclude<UploadResult, { ok: true }>> {
  const safe = await readSafeHostedError(response);
  const retryAfterHeader = safeHostedErrorText(response.headers.get("Retry-After"));
  const retryAfterMs = response.status === 429
    ? parseRetryAfterMs(response.headers.get("Retry-After"))
    : undefined;
  const kind: SafeHostedSyncError["kind"] = response.status === 429
    ? "rate_limited"
    : response.status >= 500
      ? "temporary"
      : "rejected";
  // Authentication, entitlement, and scope failures can be repaired without
  // rerunning the provider. Preserve their signed evidence for a later retry.
  const permanent = !(
    response.status === 401 ||
    response.status === 402 ||
    response.status === 403 ||
    response.status === 429 ||
    response.status >= 500
  );
  return {
    ok: false,
    permanent,
    ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
    failure: {
      status: response.status,
      kind,
      stage,
      ...safe,
      ...(retryAfterHeader ? { retryAfter: retryAfterHeader } : {}),
    },
  };
}

function localUploadFailure(
  stage: SafeHostedSyncError["stage"],
  kind: SafeHostedSyncError["kind"],
  reason: string,
  permanent = false
): Exclude<UploadResult, { ok: true }> {
  return { ok: false, permanent, failure: { kind, stage, reason } };
}

function writeUploadFailure(result: Exclude<UploadResult, { ok: true }>): void {
  const { failure } = result;
  const details = [failure.error, failure.reason]
    .filter((value, index, values): value is string => Boolean(value) && values.indexOf(value) === index)
    .join(": ");
  const fallback = failure.status ? `HTTP ${failure.status}` : "hosted sync request failed";
  const label = failure.kind === "rate_limited"
    ? "Sync rate limited"
    : failure.kind === "temporary" || failure.kind === "network"
      ? "Sync temporarily failed"
      : `Sync rejected during ${failure.stage}`;
  const upgrade = failure.upgradeUrl ? ` Upgrade: ${failure.upgradeUrl}` : "";
  const retryAfter = failure.retryAfter ? ` Retry after ${failure.retryAfter}s.` : "";
  process.stderr.write(`[martin sync] ${label}: ${details || fallback}.${upgrade}${retryAfter}\n`);
  process.stderr.write(
    result.permanent
      ? "[martin sync] Queued evidence will be quarantined for inspection.\n"
      : "[martin sync] 1 run remains queued for retry.\n"
  );
}

/**
 * @internal Exported for targeted HTTP behavior tests only.
 */
async function ensureHostedReceiptKey(
  item: RunSyncQueueItem,
  endpoint: string,
  token: string
): Promise<UploadResult> {
  const locator = item.receiptKey;
  const receiptKeyId = item.payload.coreReceipt?.integrity.keyId;
  if (!locator || !receiptKeyId) return { ok: true };

  // Fail closed if the queue locator and signed receipt disagree.
  if (locator.keyId !== receiptKeyId) {
    return localUploadFailure(
      "receipt-key registration",
      "rejected",
      "queued receipt key does not match the signed receipt",
      true
    );
  }

  let signingSecret: string;
  try {
    signingSecret = (
      await readFile(
        join(resolveReceiptIntegrityRootForSync(), locator.runsRootHash, `${item.loopId}.key`),
        "utf8"
      )
    ).trim();
  } catch {
    // The operator may restore the local key or MARTIN_INTEGRITY_KEY_DIR and retry.
    return localUploadFailure(
      "receipt-key registration",
      "temporary",
      "local receipt signing key is unavailable"
    );
  }

  if (sha256Hex(signingSecret).slice(0, 16) !== locator.keyId) {
    return localUploadFailure(
      "receipt-key registration",
      "rejected",
      "local receipt signing key does not match the signed receipt",
      true
    );
  }

  const url = `${endpoint.replace(/\/$/, "")}/register-receipt-key`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPLOAD_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ keyId: locator.keyId, signingSecret }),
    });

    if (res.ok) return { ok: true };
    return await classifyHostedFailure(res, "receipt-key registration");
  } catch {
    return localUploadFailure(
      "receipt-key registration",
      "network",
      "could not reach the hosted service"
    );
  } finally {
    clearTimeout(timer);
  }
}

async function ensureHostedSwarmKey(
  item: SwarmSyncQueueItem,
  endpoint: string,
  token: string,
): Promise<UploadResult> {
  const runsRoot = await realpath(resolve(
    process.env["MARTIN_RUNS_DIR"]?.trim() ?? join(homedir(), ".martin", "runs"),
  )).catch(() => undefined);
  if (!runsRoot) {
    return localUploadFailure("swarm-key registration", "temporary", "local swarm runs root is unavailable");
  }
  const runsRootHash = sha256Hex(runsRoot).slice(0, 16);
  let receiptSecret: string;
  try {
    receiptSecret = (await readFile(
      join(resolveReceiptIntegrityRootForSync(), runsRootHash, `swarm-${item.resourceId}.key`),
      "utf8",
    )).trim();
  } catch {
    return localUploadFailure("swarm-key registration", "temporary", "local swarm receipt signing key is unavailable");
  }
  const signingSecret = createHmac("sha256", receiptSecret)
    .update(`${item.transportKey.domain}\n${item.resourceId}\n`)
    .digest("hex");
  const expectedKeyId = `hosted-${sha256Hex(signingSecret).slice(0, 16)}`;
  const expectedLocatorHash = sha256Hex(`${item.transportKey.domain}\n${item.resourceId}\n${expectedKeyId}\n`);
  if (item.transportKey.keyId !== expectedKeyId || item.transportKey.keyLocatorHash !== expectedLocatorHash) {
    return localUploadFailure("swarm-key registration", "rejected", "hosted swarm key locator does not match authenticated receipt key material", true);
  }

  const url = `${endpoint.replace(/\/$/, "")}/register-swarm-transport-key`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPLOAD_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
        "X-Martin-Swarm-Transport-Key": signingSecret,
      },
      body: JSON.stringify({
        swarmId: item.resourceId,
        keyId: item.transportKey.keyId,
        keyLocatorHash: item.transportKey.keyLocatorHash,
        domain: item.transportKey.domain,
      }),
    });
    if (response.ok) return { ok: true };
    return await classifyHostedFailure(response, "swarm-key registration");
  } catch {
    return localUploadFailure("swarm-key registration", "network", "could not reach the hosted service");
  } finally {
    clearTimeout(timer);
  }
}

/**
 * @internal Exported for targeted HTTP behavior tests only.
 */
export async function attemptUpload(
  item: SyncQueueItem,
  endpoint: string,
  token: string
): Promise<UploadResult> {
  if (item.resourceKind === "swarm") {
    if (!isValidSwarmQueueItem(item)) {
      return localUploadFailure("swarm upload", "rejected", "queued swarm canonical bytes failed integrity validation", true);
    }
    const registration = await ensureHostedSwarmKey(item, endpoint, token);
    if (!registration.ok) return registration;
    const url = `${endpoint.replace(/\/$/, "")}/api/swarms/sync`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), UPLOAD_TIMEOUT_MS);
    try {
      const response = await fetch(url, {
        method: "POST",
        signal: controller.signal,
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: item.canonicalBody,
      });
      if (response.ok) return { ok: true };
      return await classifyHostedFailure(response, "swarm upload");
    } catch {
      return localUploadFailure("swarm upload", "network", "could not reach the hosted service");
    } finally {
      clearTimeout(timer);
    }
  }
  // A receipt-bound run establishes workspace trust for its local signing key
  // immediately before the immutable signed payload is uploaded. The secret is
  // sent only to the authenticated registration endpoint and never enters the
  // sync payload or durable queue.
  const registration = await ensureHostedReceiptKey(item, endpoint, token);
  if (!registration.ok) return registration;

  const url = `${endpoint.replace(/\/$/, "")}/api/runs/sync`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPLOAD_TIMEOUT_MS);

  try {
    const res = await fetch(url, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(item.payload),
    });

    if (res.ok) return { ok: true };
    return await classifyHostedFailure(res, "run upload");
  } catch {
    return localUploadFailure(
      "run upload",
      "network",
      "could not reach the hosted service"
    );
  } finally {
    clearTimeout(timer);
  }
}

function backoffDelay(attempt: number, retryAfterMs?: number): number {
  if (retryAfterMs != null && retryAfterMs > 0) return Math.min(retryAfterMs, BACKOFF_CAP_MS);
  const exp = Math.min(BACKOFF_BASE_MS * Math.pow(2, attempt), BACKOFF_CAP_MS);
  const jitter = Math.random() * 0.3 * exp;
  return Math.floor(exp + jitter);
}

// ---------------------------------------------------------------------------
// Internal: shared enqueue logic
// ---------------------------------------------------------------------------

interface EnqueuedContext {
  item: SyncQueueItem;
  queueDir: string;
  endpoint: string;
  token: string;
}

/**
 * Validates opt-in env vars, builds the ingest payload, checks size, creates a
 * SyncQueueItem, and atomically writes it to the queue directory.
 *
 * Returns the enqueued context on success; undefined if opt-in is disabled or
 * the payload is rejected (too large). Throws on queue-write failures so the
 * caller can decide how to handle them.
 */
async function buildAndEnqueue(
  loop: LoopRecord,
  opts: { runtimeVersion: string }
): Promise<EnqueuedContext | undefined> {
  const endpoint = process.env["MARTIN_TELEMETRY_ENDPOINT"]?.trim();
  const token = process.env["MARTIN_API_TOKEN"]?.trim();
  if (!endpoint || !token) return undefined; // opt-in — silent no-op

  const queueDir = resolveQueueDir();
  const runsRoot = resolveRunsRootForReceipt(loop);
  const persistedReceipt = await readPersistedCoreReceiptBundle(loop);
  const payload = buildIngestBody(loop, opts.runtimeVersion, persistedReceipt);
  const receiptKey = payload.coreReceipt
    ? {
        keyId: payload.coreReceipt.integrity.keyId,
        runsRootHash: sha256Hex(runsRoot).slice(0, 16),
      }
    : undefined;

  const payloadBytes = Buffer.byteLength(JSON.stringify(payload), "utf8");
  if (payloadBytes > MAX_PAYLOAD_BYTES) {
    process.stderr.write(
      `[martin sync] Payload too large (${payloadBytes} bytes, max ${MAX_PAYLOAD_BYTES}) for loop ${loop.loopId} — not queued.\n`
    );
    return undefined;
  }

  const item: SyncQueueItem = {
    queueId: randomUUID(),
    loopId: loop.loopId,
    payload,
    ...(receiptKey ? { receiptKey } : {}),
    enqueuedAt: new Date().toISOString(),
    attempts: 0,
    payloadBytes,
  };

  await enqueue(item, queueDir);
  return { item, queueDir, endpoint, token };
}

// ---------------------------------------------------------------------------
// Public: enqueueLoopForHostedSync
// ---------------------------------------------------------------------------

/**
 * Atomically writes a LoopRecord to the local sync queue. This is the durability
 * guarantee — the record is persisted before this function returns.
 *
 * Must be awaited by the caller. Never throws — errors are caught and logged to
 * stderr so the governed run output is never blocked.
 *
 * Opt-in: silent no-op when MARTIN_TELEMETRY_ENDPOINT or MARTIN_API_TOKEN are unset.
 * Use `martin sync flush` or the background flush in index.ts to upload.
 */
export async function enqueueLoopForHostedSync(
  loop: LoopRecord,
  opts: { runtimeVersion: string }
): Promise<void> {
  try {
    await buildAndEnqueue(loop, opts);
  } catch (err) {
    process.stderr.write(
      `[martin sync] Sync deferred for loop ${loop.loopId}: ${err instanceof Error ? err.message : String(err)}\n`
    );
  }
}

export type EnqueueSwarmSyncResult = "queued" | "duplicate" | "disabled";

export interface EnqueueCommittedSwarmSyncInput {
  runsRoot: string;
  swarmId: string;
  runtimeVersion: string;
}

interface EnqueueCommittedSwarmSyncDependencies {
  buildSwarmHostedEnvelope(input: EnqueueCommittedSwarmSyncInput): Promise<BuiltSwarmHostedEnvelope>;
}

const committedSwarmSyncDependencies: EnqueueCommittedSwarmSyncDependencies = {
  buildSwarmHostedEnvelope,
};

/**
 * Builds and queues a hosted projection only when hosted sync is fully configured.
 * The exporter authenticates the committed terminal seal before returning bytes.
 */
export async function enqueueCommittedSwarmForHostedSync(
  input: EnqueueCommittedSwarmSyncInput,
  dependencies: EnqueueCommittedSwarmSyncDependencies = committedSwarmSyncDependencies,
): Promise<EnqueueSwarmSyncResult> {
  const endpoint = process.env["MARTIN_TELEMETRY_ENDPOINT"]?.trim();
  const token = process.env["MARTIN_API_TOKEN"]?.trim();
  if (!endpoint || !token) return "disabled";
  const exported = await dependencies.buildSwarmHostedEnvelope(input);
  return enqueueSwarmForHostedSync(exported);
}

/**
 * Durably queues an already authenticated Core swarm export. This boundary does
 * not rebuild or parse/reserialize the canonical upload body.
 */
export async function enqueueSwarmForHostedSync(
  exported: BuiltSwarmHostedEnvelope,
): Promise<EnqueueSwarmSyncResult> {
  const endpoint = process.env["MARTIN_TELEMETRY_ENDPOINT"]?.trim();
  const token = process.env["MARTIN_API_TOKEN"]?.trim();
  if (!endpoint || !token) return "disabled";

  const payloadBytes = Buffer.byteLength(exported.canonicalBody, "utf8");
  const candidate: SwarmSyncQueueItem = {
    queueId: randomUUID(),
    resourceKind: "swarm",
    resourceId: exported.envelope.swarm.swarmId,
    canonicalBody: exported.canonicalBody,
    payloadSha256: exported.payloadSha256,
    envelopeIdentity: exported.envelopeIdentity,
    transportKey: { ...exported.transportKey },
    enqueuedAt: new Date().toISOString(),
    attempts: 0,
    payloadBytes,
  };
  if (!isValidSwarmQueueItem(candidate)) {
    throw Object.assign(new Error("Swarm sync export failed canonical byte validation."), { code: "SWARM_SYNC_INVALID_EXPORT" });
  }
  if (payloadBytes > MAX_PAYLOAD_BYTES) {
    throw Object.assign(
      new Error(`Swarm sync payload is ${payloadBytes} bytes; maximum is ${MAX_PAYLOAD_BYTES}.`),
      { code: "SWARM_SYNC_PAYLOAD_TOO_LARGE" },
    );
  }

  const queueDir = resolveQueueDir();
  return withSwarmAdmissionLock(queueDir, candidate.resourceId, async () => {
    const indexPath = swarmAdmissionIndexPath(queueDir, candidate.resourceId);
    const indexed = await readSwarmAdmissionIndex(queueDir, candidate.resourceId);
    if (indexed) {
      const active = await hasActiveSwarmItem(queueDir, candidate.resourceId);
      const staleOrphan = !active && Date.now() - indexed.mtimeMs > SWARM_ADMISSION_LOCK_STALE_MS;
      if (staleOrphan) {
        await rm(indexPath, { force: true });
      } else if (isValidSwarmAdmissionIndex(indexed.value, candidate.resourceId)) {
        const same = indexed.value.envelopeIdentity === candidate.envelopeIdentity
          && indexed.value.payloadSha256 === candidate.payloadSha256
          && indexed.value.canonicalBodySha256 === sha256Hex(candidate.canonicalBody);
        if (same) return "duplicate";
        throw Object.assign(new Error("A different hosted envelope is already queued for this swarm."), { code: "SWARM_SYNC_CONFLICT" });
      } else {
        throw Object.assign(new Error("The same-swarm admission index is malformed."), { code: "SWARM_SYNC_CONFLICT" });
      }
    }
    const admission: SwarmAdmissionIndex = {
      schemaVersion: "martin.swarm-sync-admission.v1",
      resourceId: candidate.resourceId,
      queueId: candidate.queueId,
      envelopeIdentity: candidate.envelopeIdentity,
      payloadSha256: candidate.payloadSha256,
      canonicalBodySha256: sha256Hex(candidate.canonicalBody),
      createdAt: candidate.enqueuedAt,
    };
    await atomicWriteJson(indexPath, admission);
    try {
      await enqueue(candidate, queueDir);
    } catch (error) {
      await rm(indexPath, { force: true });
      throw error;
    }
    return "queued";
  });
}

// ---------------------------------------------------------------------------
// Public: syncLoopToHosted
// ---------------------------------------------------------------------------

/**
 * Enqueues a LoopRecord and immediately attempts an upload to the hosted Control Plane.
 *
 * Never throws — all errors are caught and logged to stderr.
 * On transient failure the item stays queued for `martin sync flush`.
 * On permanent failure (4xx exc. 429) the item is quarantined with a diagnostic.
 *
 * Used in tests that exercise the full enqueue + upload path in one call.
 * In production, index.ts uses enqueueLoopForHostedSync + flushSyncQueue separately.
 */
export async function syncLoopToHosted(
  loop: LoopRecord,
  opts: { runtimeVersion: string }
): Promise<void> {
  try {
    const ctx = await buildAndEnqueue(loop, opts);
    if (!ctx) return;

    const { item, queueDir, endpoint, token } = ctx;

    // Claim before uploading — prevents race with a concurrent flushSyncQueue call
    const inflightPath = await claimItem(`${item.queueId}.json`, queueDir);
    if (!inflightPath) {
      // Another process claimed it (extremely unlikely). Leave it for flush.
      return;
    }

    const result = await attemptUpload(item, endpoint, token);

    if (result.ok) {
      await releaseItem(inflightPath, queueDir, "done");
      return;
    }

    writeUploadFailure(result);

    if (result.permanent) {
      const moved = await quarantine(inflightPath, queueDir, "permanent_4xx");
      if (!moved) await releaseItem(inflightPath, queueDir, "requeue");
      return;
    }

    // Transient — persist attempt state before releasing back to queue
    const delay = backoffDelay(0, result.retryAfterMs);
    const updated: SyncQueueItem = {
      ...item,
      attempts: 1,
      lastAttemptAt: new Date().toISOString(),
      nextRetryNotBefore: new Date(Date.now() + delay).toISOString(),
    };
    await atomicWriteJson(inflightPath, updated);
    await releaseItem(inflightPath, queueDir, "requeue");
  } catch (err) {
    // Catch-all: filesystem failures, queue-full errors, etc.
    process.stderr.write(
      `[martin sync] Sync deferred for loop ${loop.loopId}: ${err instanceof Error ? err.message : String(err)}\n`
    );
  }
}

// ---------------------------------------------------------------------------
// Public: flushSyncQueue
// ---------------------------------------------------------------------------

/**
 * Processes the sync queue: recovers stale inflight items, then for each eligible item
 * (not within backoff window, under attempt cap) attempts one upload.
 *
 * Attempt count and backoff are persisted — multiple flush invocations count toward
 * the FLUSH_MAX_ATTEMPTS lifetime cap per item, not per invocation.
 *
 * May throw on unrecoverable filesystem errors (permission denied, disk full, etc.).
 * Called by `martin sync flush`.
 */
export interface SyncFlushResult {
  ok: boolean;
  uploaded: number;
  quarantined: number;
  pending: number;
  reason?: "missing_token" | "missing_endpoint" | "missing_both" | "incomplete";
}

export async function flushSyncQueue(): Promise<SyncFlushResult> {
  const endpoint = process.env["MARTIN_TELEMETRY_ENDPOINT"]?.trim();
  const token = process.env["MARTIN_API_TOKEN"]?.trim();
  if (!endpoint || !token) {
    const missing = [
      ...(!endpoint ? ["MARTIN_TELEMETRY_ENDPOINT"] : []),
      ...(!token ? ["MARTIN_API_TOKEN"] : []),
    ];
    process.stderr.write(
      `[martin sync] Hosted sync is not configured. ${missing.join(" and ")} must be set; then retry \`martin sync flush\`.\n`
    );
    return {
      ok: false,
      uploaded: 0,
      quarantined: 0,
      pending: 0,
      reason: !endpoint && !token ? "missing_both" : !endpoint ? "missing_endpoint" : "missing_token",
    };
  }

  const queueDir = resolveQueueDir();

  // Recover items abandoned by crashed processes before claiming new ones
  await recoverStaleInflight(queueDir);

  // Quarantine files that are present in the directory but cannot be parsed
  const allFiles = await safeListQueue(queueDir);
  const parseable = await listQueueOldestFirst(queueDir);
  const parseableSet = new Set(parseable.map((x) => x.file));
  let quarantinedCount = 0;
  let stillPending = 0;
  for (const f of allFiles) {
    if (!parseableSet.has(f)) {
      process.stderr.write(`[martin sync] Corrupt queue file ${f} — quarantining.\n`);
      const moved = await quarantine(join(queueDir, f), queueDir, "corrupt");
      if (moved) quarantinedCount++;
      else stillPending++;
    }
  }

  if (parseable.length === 0) {
    process.stdout.write("[martin sync] Queue is empty.\n");
    return {
      ok: quarantinedCount === 0 && stillPending === 0,
      uploaded: 0,
      quarantined: quarantinedCount,
      pending: stillPending,
      ...(quarantinedCount > 0 || stillPending > 0 ? { reason: "incomplete" as const } : {}),
    };
  }

  const now = Date.now();
  const eligible = parseable.filter(
    (x) => !x.item.nextRetryNotBefore || Date.parse(x.item.nextRetryNotBefore) <= now
  );
  const deferred = parseable.length - eligible.length;

  process.stdout.write(
    `[martin sync] Flushing ${eligible.length} eligible item(s)${deferred > 0 ? ` (${deferred} deferred by backoff)` : ""}…\n`
  );

  let succeeded = 0;
  for (const { file } of eligible) {
    const inflightPath = await claimItem(file, queueDir);
    if (!inflightPath) {
      stillPending++;
      continue; // another process claimed it
    }

    let currentItem: SyncQueueItem;
    try {
      currentItem = JSON.parse(await readFile(inflightPath, "utf8")) as SyncQueueItem;
      if (currentItem.resourceKind === "swarm" && !isValidSwarmQueueItem(currentItem)) {
        const moved = await quarantine(inflightPath, queueDir, "corrupt");
        if (moved) quarantinedCount++;
        else stillPending++;
        continue;
      }
    } catch {
      process.stderr.write(`[martin sync] Cannot read claimed item ${file} — releasing.\n`);
      await releaseItem(inflightPath, queueDir, "requeue");
      stillPending++;
      continue;
    }

    // Enforce lifetime attempt cap across invocations
    if (currentItem.attempts >= FLUSH_MAX_ATTEMPTS) {
      process.stderr.write(
        `[martin sync] Resource ${syncResourceId(currentItem)} exhausted ${FLUSH_MAX_ATTEMPTS} attempts — quarantining.\n`
      );
      const moved = await quarantine(inflightPath, queueDir, "max_attempts");
      if (moved) quarantinedCount++;
      else {
        await releaseItem(inflightPath, queueDir, "requeue");
        stillPending++;
      }
      continue;
    }

    const result = await attemptUpload(currentItem, endpoint, token);

    if (result.ok) {
      await releaseItem(inflightPath, queueDir, "done");
      succeeded++;
    } else if (result.permanent) {
      writeUploadFailure(result);
      const moved = await quarantine(inflightPath, queueDir, "permanent_4xx");
      if (moved) quarantinedCount++;
      else {
        await releaseItem(inflightPath, queueDir, "requeue");
        stillPending++;
      }
    } else {
      writeUploadFailure(result);
      // Persist incremented attempt count and backoff window
      const delay = backoffDelay(currentItem.attempts, result.retryAfterMs);
      const updated: SyncQueueItem = {
        ...currentItem,
        attempts: currentItem.attempts + 1,
        lastAttemptAt: new Date().toISOString(),
        nextRetryNotBefore: new Date(Date.now() + delay).toISOString(),
      };
      try {
        await atomicWriteJson(inflightPath, updated);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") {
          // Stale recovery may have fenced this owner while the upload was in
          // flight. The replacement generation owns the durable item now.
          stillPending++;
          continue;
        }
        throw err;
      }
      await releaseItem(inflightPath, queueDir, "requeue");
      stillPending++;
    }
  }

  process.stdout.write(
    `[martin sync] Done — ${succeeded} uploaded, ${quarantinedCount} quarantined, ${stillPending} still pending.\n`
  );

  const pending = deferred + stillPending;
  const ok = quarantinedCount === 0 && pending === 0;
  return {
    ok,
    uploaded: succeeded,
    quarantined: quarantinedCount,
    pending,
    ...(!ok ? { reason: "incomplete" as const } : {}),
  };
}

// ---------------------------------------------------------------------------
// Public: syncQueueStatus
// ---------------------------------------------------------------------------

/**
 * Prints the current sync queue and quarantine state.
 * May throw on unrecoverable filesystem errors.
 * Called by `martin sync status`.
 */
export async function syncQueueStatus(): Promise<void> {
  const queueDir = resolveQueueDir();
  const items = await listQueueOldestFirst(queueDir);
  const allFiles = await safeListQueue(queueDir);

  if (allFiles.length === 0) {
    process.stdout.write("[martin sync] Queue is empty.\n");
  } else {
    process.stdout.write(`[martin sync] ${allFiles.length} item(s) pending upload:\n`);
    for (const { item } of items) {
      const backoffNote = item.nextRetryNotBefore
        ? `, retry after: ${item.nextRetryNotBefore}`
        : "";
      process.stdout.write(
        `  • ${syncResourceId(item)} (queued ${item.enqueuedAt}, attempts: ${item.attempts}${backoffNote})\n`
      );
    }
    const corrupt = allFiles.length - items.length;
    if (corrupt > 0) process.stdout.write(`  • ${corrupt} unreadable/corrupt item(s)\n`);
  }

  const quarantineDir = resolveQuarantineDir(queueDir);
  try {
    const quarantined = (await readdir(quarantineDir)).filter((f) => f.endsWith(".json"));
    if (quarantined.length > 0) {
      process.stdout.write(
        `[martin sync] ${quarantined.length} item(s) in quarantine — inspect ~/.martin/runs/.sync-queue/.quarantine/\n`
      );
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    // ENOENT: no quarantine dir yet — fine
  }
}
