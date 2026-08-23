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
 * Verified server contract (POST /api/runs/sync):
 *   Auth:    Authorization: Bearer martin_cp_<token>  (CP-issued credential, "ingest" scope)
 *   Dedup:   Server deduplicates by (tenantId, loopId). Duplicate events within a run are
 *            deduplicated by eventId. Duplicate sync → 202 { ok: true, replayedEvents: N,
 *            acceptedEvents: 0 } — treated as success.
 *   401:     Bad/missing/revoked token — permanent, do not retry.
 *   403:     Missing "ingest" scope — permanent, do not retry.
 *   400:     Invalid payload (missing loopId, empty events, bad schema) — permanent.
 *   409:     Backdated syncedAt (earlier than existing lastSyncedAt) — permanent, do not retry.
 *   429:     Rate limit — transient; respect Retry-After if present.
 *   5xx:     Server error — transient, retry.
 *
 * Failure modes:
 *   Transient (timeout, offline, 429, 5xx) → item stays in queue for flushSyncQueue().
 *   Permanent (4xx exc. 429)               → item moved to quarantine dir with reason.
 *   Queue full (200 items)                 → oldest by enqueuedAt quarantined; if quarantine
 *                                           fails, new item is NOT enqueued (error logged).
 *   Corrupt queue file                     → quarantined; skipped if quarantine fails.
 *   Oversized payload (> 256 KB)           → rejected before enqueue; logged to stderr.
 *
 * Concurrent process safety:
 *   Items are claimed via atomic rename to .inflight/ before upload.
 *   Only the process that wins the rename proceeds to upload.
 *   Stale .inflight items (from crashed processes) are recovered at flush start.
 *
 * Attempt persistence:
 *   attempts and nextRetryNotBefore are persisted to the queue file after each attempt.
 *   FLUSH_MAX_ATTEMPTS is a lifetime cap enforced across separate invocations.
 */

import { createHash, randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import type { LoopRecord } from "@martin/contracts";

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

interface HostedRunSyncDraft {
  loopId: string;
  workspaceId?: string;
  projectId?: string;
  task: { title: string; objective: string };
  status?: string;
  budget?: { spentUsd?: number };
  events: HostedRunEventDraft[];
  syncedAt?: string;
}

interface SyncQueueItem {
  queueId: string;
  loopId: string;
  payload: HostedRunSyncDraft;
  enqueuedAt: string;           // ISO 8601 — chronological sort key
  attempts: number;             // persisted across flush invocations
  lastAttemptAt?: string;
  nextRetryNotBefore?: string;  // persisted backoff — item skipped if this is in the future
  payloadBytes: number;         // pre-validated at enqueue
}

type UploadResult =
  | { ok: true }
  | { ok: false; permanent: boolean; retryAfterMs?: number };

// ---------------------------------------------------------------------------
// Payload builder
// ---------------------------------------------------------------------------

function buildIngestBody(loop: LoopRecord, _runtimeVersion: string): HostedRunSyncDraft {
  const events: HostedRunEventDraft[] = [];

  // Always-present lifecycle snapshot — guarantees events[] is never empty.
  events.push({
    eventId: `evt_run_synced_${loop.loopId}`,
    eventType: "run.synced",
    occurredAt: loop.updatedAt ?? loop.createdAt,
    sequence: 0,
    payload: { lifecycleState: loop.lifecycleState, status: loop.status },
  });

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
        ...(attempt.model != null && { model: attempt.model }),
      },
    });
  }

  return {
    loopId: loop.loopId,
    workspaceId: loop.workspaceId,
    projectId: loop.projectId,
    task: {
      title: loop.task.title ?? loop.task.objective ?? "",
      objective: loop.task.objective ?? loop.task.title ?? "",
    },
    status: loop.status,
    budget: {
      spentUsd: loop.cost?.actualUsd ?? loop.cost?.estimatedUsd,
    },
    events,
    syncedAt: new Date().toISOString(),
  };
}

/**
 * @internal Exported for targeted tests only. Server deduplicates by (tenantId, loopId).
 */
export function computeIdempotencyKey(loopId: string, body: HostedRunSyncDraft): string {
  return createHash("sha256")
    .update(loopId + JSON.stringify(body))
    .digest("hex");
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
        if (typeof item.loopId !== "string" || typeof item.enqueuedAt !== "string") return null;
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
 * Cross-process ownership is guaranteed by the atomic OS rename in claimItem.
 * This Set provides additional in-process serialization: it is checked and updated
 * synchronously (no await before the check-and-add), so it is atomic within the JS
 * event loop and prevents two coroutines in the same process from both submitting
 * renames for the same source path to the OS I/O queue simultaneously.
 *
 * Keyed by the canonical full source path, not only queueId, to ensure correct
 * scoping when multiple queue directories are active (e.g., in tests).
 */
const activeClaimPaths = new Set<string>();

/**
 * Atomically claims a queue item by renaming it to a structured inflight filename:
 *   queue/<queueId>.json  →  .inflight/<claimedAtEpochMs>.<claimUuid>.<queueId>.json
 *
 * The claim timestamp and identity are encoded in the rename destination, so they are
 * established by the same atomic OS operation that acquires ownership. Nothing is
 * written after the rename — the filename is the claim record.
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

  // In-process serialization: checked and set synchronously before the first await,
  // so this is atomic within the JS event loop. Keyed by full source path.
  if (activeClaimPaths.has(src)) return undefined;
  activeClaimPaths.add(src);

  try {
    const inflightDir = resolveInflightDir(queueDir);
    await mkdir(inflightDir, { recursive: true });

    // Claim timestamp and UUID encoded in destination filename — atomically established.
    const claimedAtMs = Date.now();
    const claimUuid = randomUUID();
    const dest = join(inflightDir, `${claimedAtMs}.${claimUuid}.${queueId}.json`);

    try {
      await rename(src, dest);
      return dest;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined; // lost the race
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
  if (outcome === "done") {
    await rm(inflightPath, { force: true }); // force handles ENOENT safely
    return;
  }
  // Extract the original <queueId>.json name from the inflight filename.
  // New format: <epochMs>.<claimUuid>.<queueId>.json → requeue as <queueId>.json
  // Legacy format: <queueId>.json → requeue as-is
  const base = queueFileName(inflightPath);
  const meta = parseInflightName(base);
  const queueFile = meta ? `${meta.queueId}.json` : base;
  const dest = join(queueDir, queueFile);
  try {
    await rename(inflightPath, dest);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return; // already swept — safe race
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
  const rawName = queueFileName(filePath);
  const meta = parseInflightName(rawName);
  const name = meta ? `${meta.queueId}.json` : rawName;
  const dest = join(dir, name);

  try {
    await rename(filePath, dest);
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

// ---------------------------------------------------------------------------
// HTTP upload
// ---------------------------------------------------------------------------

/**
 * @internal Exported for targeted HTTP behavior tests only.
 */
export async function attemptUpload(
  item: SyncQueueItem,
  endpoint: string,
  token: string
): Promise<UploadResult> {
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

    // 202: accepted (new or duplicate events). Duplicate sync → replayedEvents>0, acceptedEvents===0.
    if (res.ok) return { ok: true };

    if (res.status === 429) {
      const retryAfterMs = parseRetryAfterMs(res.headers.get("Retry-After"));
      return { ok: false, permanent: false, retryAfterMs };
    }

    if (res.status >= 500) return { ok: false, permanent: false };

    // 4xx (exc. 429): permanent — includes 409 (backdated syncedAt), 401, 403, 400
    return { ok: false, permanent: true };
  } catch {
    return { ok: false, permanent: false }; // network error or AbortError (timeout)
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
  const payload = buildIngestBody(loop, opts.runtimeVersion);

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

    if (result.permanent) {
      process.stderr.write(
        `[martin sync] Permanent upload failure for loop ${loop.loopId} — quarantining. Check MARTIN_API_TOKEN and MARTIN_TELEMETRY_ENDPOINT.\n`
      );
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
    process.stderr.write(
      `[martin sync] Upload deferred for loop ${loop.loopId} — will retry with \`martin sync flush\`.\n`
    );
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
export async function flushSyncQueue(): Promise<void> {
  const endpoint = process.env["MARTIN_TELEMETRY_ENDPOINT"]?.trim();
  const token = process.env["MARTIN_API_TOKEN"]?.trim();
  if (!endpoint || !token) {
    process.stderr.write(
      "[martin sync] MARTIN_TELEMETRY_ENDPOINT and MARTIN_API_TOKEN must be set to flush the queue.\n"
    );
    return;
  }

  const queueDir = resolveQueueDir();

  // Recover items abandoned by crashed processes before claiming new ones
  await recoverStaleInflight(queueDir);

  // Quarantine files that are present in the directory but cannot be parsed
  const allFiles = await safeListQueue(queueDir);
  const parseable = await listQueueOldestFirst(queueDir);
  const parseableSet = new Set(parseable.map((x) => x.file));
  for (const f of allFiles) {
    if (!parseableSet.has(f)) {
      process.stderr.write(`[martin sync] Corrupt queue file ${f} — quarantining.\n`);
      await quarantine(join(queueDir, f), queueDir, "corrupt");
    }
  }

  if (parseable.length === 0) {
    process.stdout.write("[martin sync] Queue is empty.\n");
    return;
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
  let quarantinedCount = 0;
  let stillPending = 0;

  for (const { file } of eligible) {
    const inflightPath = await claimItem(file, queueDir);
    if (!inflightPath) continue; // another process claimed it

    let currentItem: SyncQueueItem;
    try {
      currentItem = JSON.parse(await readFile(inflightPath, "utf8")) as SyncQueueItem;
    } catch {
      process.stderr.write(`[martin sync] Cannot read claimed item ${file} — releasing.\n`);
      await releaseItem(inflightPath, queueDir, "requeue");
      continue;
    }

    // Enforce lifetime attempt cap across invocations
    if (currentItem.attempts >= FLUSH_MAX_ATTEMPTS) {
      process.stderr.write(
        `[martin sync] Loop ${currentItem.loopId} exhausted ${FLUSH_MAX_ATTEMPTS} attempts — quarantining.\n`
      );
      const moved = await quarantine(inflightPath, queueDir, "max_attempts");
      if (moved) quarantinedCount++;
      else await releaseItem(inflightPath, queueDir, "requeue");
      continue;
    }

    const result = await attemptUpload(currentItem, endpoint, token);

    if (result.ok) {
      await releaseItem(inflightPath, queueDir, "done");
      succeeded++;
    } else if (result.permanent) {
      process.stderr.write(
        `[martin sync] Permanent failure for loop ${currentItem.loopId} — quarantining.\n`
      );
      const moved = await quarantine(inflightPath, queueDir, "permanent_4xx");
      if (moved) quarantinedCount++;
      else await releaseItem(inflightPath, queueDir, "requeue");
    } else {
      // Persist incremented attempt count and backoff window
      const delay = backoffDelay(currentItem.attempts, result.retryAfterMs);
      const updated: SyncQueueItem = {
        ...currentItem,
        attempts: currentItem.attempts + 1,
        lastAttemptAt: new Date().toISOString(),
        nextRetryNotBefore: new Date(Date.now() + delay).toISOString(),
      };
      await atomicWriteJson(inflightPath, updated);
      await releaseItem(inflightPath, queueDir, "requeue");
      stillPending++;
    }
  }

  process.stdout.write(
    `[martin sync] Done — ${succeeded} uploaded, ${quarantinedCount} quarantined, ${stillPending} still pending.\n`
  );
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
        `  • ${item.loopId} (queued ${item.enqueuedAt}, attempts: ${item.attempts}${backoffNote})\n`
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
