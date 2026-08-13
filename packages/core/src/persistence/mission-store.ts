/**
 * Mission Store — C2 durable persistence.
 *
 * Layout under <runsRoot>/missions/<missionId>/:
 *   mission.json      — rebuildable snapshot/cache (NOT the authority)
 *   ledger.jsonl      — append-only, SHA-256 hash-chained event log (authority)
 *   ledger-chain.json — chain head hash for tamper detection
 *   .lock             — cross-process exclusive lock (created with O_EXCL)
 *
 * Rules:
 *   - Ledger is always written before mission.json is updated.
 *   - mission.json is written atomically (temp file → rename).
 *   - Cross-process lock is held during every write; stale locks (>8s) are removed.
 *   - CAS revision must match before any write is accepted.
 *   - Corrupt or unverifiable ledger data fails closed.
 *   - Workspace isolation: all paths are under caller-supplied runsRoot.
 */

import { createHash } from "node:crypto";
import { constants, open } from "node:fs/promises";
import { appendFile, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type {
  MissionCost,
  MissionDecision,
  MissionEvent,
  MissionRecord,
  MissionRunLink,
  MissionRunRole,
  MissionStatus
} from "@martin/contracts";
import {
  MISSION_SCHEMA_VERSION,
  isMissionTransitionAllowed
} from "@martin/contracts";

// ─── Paths ────────────────────────────────────────────────────────────────────

export function missionDir(runsRoot: string, missionId: string): string {
  return join(runsRoot, "missions", missionId);
}

function missionJsonPath(runsRoot: string, missionId: string): string {
  return join(missionDir(runsRoot, missionId), "mission.json");
}

function ledgerPath(runsRoot: string, missionId: string): string {
  return join(missionDir(runsRoot, missionId), "ledger.jsonl");
}

function chainPath(runsRoot: string, missionId: string): string {
  return join(missionDir(runsRoot, missionId), "ledger-chain.json");
}

function lockPath(runsRoot: string, missionId: string): string {
  return join(missionDir(runsRoot, missionId), ".lock");
}

// ─── Hash chain ───────────────────────────────────────────────────────────────

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

interface ChainHead {
  headHash: string;
  entryCount: number;
}

async function readChainHead(runsRoot: string, missionId: string): Promise<ChainHead> {
  const raw = await readFile(chainPath(runsRoot, missionId), "utf8").catch(() => null);
  if (raw === null) return { headHash: "root", entryCount: 0 };
  return JSON.parse(raw) as ChainHead;
}

async function appendLedgerEntry(
  runsRoot: string,
  missionId: string,
  event: MissionEvent
): Promise<void> {
  const line = JSON.stringify(event);
  const head = await readChainHead(runsRoot, missionId);
  const newHash = sha256(`${head.headHash}\n${line}`);
  const newHead: ChainHead = { headHash: newHash, entryCount: head.entryCount + 1 };
  // Append event first, then update chain head
  await appendFile(ledgerPath(runsRoot, missionId), `${line}\n`, "utf8");
  await atomicWrite(chainPath(runsRoot, missionId), JSON.stringify(newHead, null, 2));
}

// ─── Atomic write ─────────────────────────────────────────────────────────────

async function atomicWrite(filePath: string, content: string): Promise<void> {
  const tmp = `${filePath}.tmp`;
  await writeFile(tmp, content, "utf8");
  await rename(tmp, filePath);
}

// ─── Cross-process lock ───────────────────────────────────────────────────────

const LOCK_STALE_MS = 8_000;
const LOCK_RETRY_INTERVAL_MS = 50;
const LOCK_MAX_RETRIES = 60; // 3s total

async function acquireLock(runsRoot: string, missionId: string): Promise<void> {
  const lp = lockPath(runsRoot, missionId);

  for (let attempt = 0; attempt < LOCK_MAX_RETRIES; attempt++) {
    try {
      // O_EXCL — fails if file exists (atomic on all POSIX and Windows NTFS)
      const fh = await open(lp, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY);
      await fh.write(String(Date.now()));
      await fh.close();
      return;
    } catch {
      // Lock exists — check if stale
      try {
        const st = await stat(lp);
        const ageMs = Date.now() - st.mtimeMs;
        if (ageMs > LOCK_STALE_MS) {
          await rm(lp, { force: true });
          continue; // retry immediately after removing stale lock
        }
      } catch {
        // Lock disappeared between check and stat — retry
        continue;
      }
      await new Promise<void>((r) => setTimeout(r, LOCK_RETRY_INTERVAL_MS));
    }
  }
  throw new Error(`mission-store: could not acquire lock for ${missionId} after ${LOCK_MAX_RETRIES} retries`);
}

async function releaseLock(runsRoot: string, missionId: string): Promise<void> {
  await rm(lockPath(runsRoot, missionId), { force: true });
}

async function withLock<T>(
  runsRoot: string,
  missionId: string,
  fn: () => Promise<T>
): Promise<T> {
  await acquireLock(runsRoot, missionId);
  try {
    return await fn();
  } finally {
    await releaseLock(runsRoot, missionId);
  }
}

// ─── Event ID factory ─────────────────────────────────────────────────────────

let _seq = 0;
function makeEventId(missionId: string): string {
  return `evt_${missionId.slice(0, 8)}_${Date.now()}_${(_seq++).toString().padStart(4, "0")}`;
}

// ─── Read mission ─────────────────────────────────────────────────────────────

/**
 * Read the current mission snapshot.
 * Returns null when no mission exists at this path.
 * Fails closed when the snapshot schema version is not recognised.
 */
export async function readMission(
  runsRoot: string,
  missionId: string
): Promise<MissionRecord | null> {
  const raw = await readFile(missionJsonPath(runsRoot, missionId), "utf8").catch(() => null);
  if (raw === null) return null;
  const record = JSON.parse(raw) as MissionRecord;
  if (record.schemaVersion !== MISSION_SCHEMA_VERSION) {
    throw new Error(
      `mission-store: unsupported schema "${record.schemaVersion}" for mission ${missionId}`
    );
  }
  return record;
}

// ─── Read ledger ──────────────────────────────────────────────────────────────

export async function readMissionLedger(
  runsRoot: string,
  missionId: string
): Promise<MissionEvent[]> {
  const raw = await readFile(ledgerPath(runsRoot, missionId), "utf8").catch(() => "");
  return raw
    .split(/\r?\n/u)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => JSON.parse(l) as MissionEvent);
}

// ─── Verify ledger integrity ──────────────────────────────────────────────────

export interface LedgerIntegrityResult {
  ok: boolean;
  reason?: string;
  entryCount: number;
}

/**
 * Verify the stored chain head matches a full replay of the ledger.
 * Returns ok=false when the ledger has been tampered with or entries are missing.
 */
export async function verifyMissionLedger(
  runsRoot: string,
  missionId: string
): Promise<LedgerIntegrityResult> {
  const events = await readMissionLedger(runsRoot, missionId);
  const stored = await readChainHead(runsRoot, missionId);

  let hash = "root";
  for (const event of events) {
    hash = sha256(`${hash}\n${JSON.stringify(event)}`);
  }

  if (hash !== stored.headHash) {
    return {
      ok: false,
      reason: `chain_mismatch: expected ${stored.headHash}, replayed ${hash}`,
      entryCount: events.length
    };
  }
  if (events.length !== stored.entryCount) {
    return {
      ok: false,
      reason: `count_mismatch: stored ${stored.entryCount}, actual ${events.length}`,
      entryCount: events.length
    };
  }
  return { ok: true, entryCount: events.length };
}

// ─── Create mission ───────────────────────────────────────────────────────────

export async function createMission(
  runsRoot: string,
  mission: MissionRecord
): Promise<void> {
  const dir = missionDir(runsRoot, mission.missionId);
  await mkdir(dir, { recursive: true });

  await withLock(runsRoot, mission.missionId, async () => {
    // Fail if already exists
    const existing = await readMission(runsRoot, mission.missionId);
    if (existing !== null) {
      throw new Error(`mission-store: mission ${mission.missionId} already exists`);
    }

    const event: MissionEvent = {
      eventId: makeEventId(mission.missionId),
      kind: "mission.created",
      missionId: mission.missionId,
      timestamp: mission.createdAt,
      payload: { status: mission.status, ownerId: mission.ownerId }
    };

    await appendLedgerEntry(runsRoot, mission.missionId, event);
    await atomicWrite(missionJsonPath(runsRoot, mission.missionId), JSON.stringify(mission, null, 2));
  });
}

// ─── Attach run ───────────────────────────────────────────────────────────────

export interface AttachRunOptions {
  loopId: string;
  role: MissionRunRole;
  verifiedOutcome?: boolean;
  actualUsd?: number;
  now?: () => string;
  /** Expected revision for CAS enforcement. */
  expectedRevision: number;
}

export async function attachRun(
  runsRoot: string,
  missionId: string,
  options: AttachRunOptions
): Promise<MissionRecord> {
  return withLock(runsRoot, missionId, async () => {
    const mission = await readMission(runsRoot, missionId);
    if (mission === null) throw new Error(`mission-store: mission ${missionId} not found`);

    if (mission.revision !== options.expectedRevision) {
      throw new Error(
        `mission-store: CAS revision mismatch for ${missionId}: ` +
        `expected ${options.expectedRevision}, found ${mission.revision}`
      );
    }

    const ts = options.now ? options.now() : new Date().toISOString();
    const link: MissionRunLink = {
      loopId: options.loopId,
      role: options.role,
      attachedAt: ts,
      ...(options.verifiedOutcome !== undefined ? { verifiedOutcome: options.verifiedOutcome } : {}),
      ...(options.actualUsd !== undefined ? { actualUsd: options.actualUsd } : {})
    };

    const newCost: MissionCost = {
      totalActualUsd: mission.cost.totalActualUsd + (options.actualUsd ?? 0),
      verifiedOutcomeCount:
        mission.cost.verifiedOutcomeCount + (options.verifiedOutcome === true ? 1 : 0),
      totalRunCount: mission.cost.totalRunCount + 1
    };

    const updated: MissionRecord = {
      ...mission,
      revision: mission.revision + 1,
      runLinks: [...mission.runLinks, link],
      cost: newCost,
      updatedAt: ts
    };

    const event: MissionEvent = {
      eventId: makeEventId(missionId),
      kind: "mission.run_attached",
      missionId,
      timestamp: ts,
      payload: {
        loopId: options.loopId,
        role: options.role,
        verifiedOutcome: options.verifiedOutcome,
        actualUsd: options.actualUsd
      }
    };

    await appendLedgerEntry(runsRoot, missionId, event);
    await atomicWrite(missionJsonPath(runsRoot, missionId), JSON.stringify(updated, null, 2));
    return updated;
  });
}

// ─── Change status ────────────────────────────────────────────────────────────

export interface ChangeMissionStatusOptions {
  toStatus: MissionStatus;
  expectedRevision: number;
  decidedBy?: string;
  decision?: MissionDecision;
  note?: string;
  now?: () => string;
}

export async function changeMissionStatus(
  runsRoot: string,
  missionId: string,
  options: ChangeMissionStatusOptions
): Promise<MissionRecord> {
  return withLock(runsRoot, missionId, async () => {
    const mission = await readMission(runsRoot, missionId);
    if (mission === null) throw new Error(`mission-store: mission ${missionId} not found`);

    if (mission.revision !== options.expectedRevision) {
      throw new Error(
        `mission-store: CAS revision mismatch for ${missionId}: ` +
        `expected ${options.expectedRevision}, found ${mission.revision}`
      );
    }

    if (!isMissionTransitionAllowed(mission.status, options.toStatus)) {
      throw new Error(
        `mission-store: transition ${mission.status} → ${options.toStatus} is not allowed`
      );
    }

    const ts = options.now ? options.now() : new Date().toISOString();
    const updated: MissionRecord = {
      ...mission,
      revision: mission.revision + 1,
      status: options.toStatus,
      updatedAt: ts,
      ...(options.decision && options.decidedBy
        ? {
            outcome: {
              decision: options.decision,
              decidedAt: ts,
              decidedBy: options.decidedBy,
              ...(options.note ? { note: options.note } : {})
            }
          }
        : {})
    };

    const eventKind =
      options.toStatus === "shipped" || options.toStatus === "killed" || options.toStatus === "rolled_back"
        ? "mission.closed"
        : "mission.status_changed";

    const event: MissionEvent = {
      eventId: makeEventId(missionId),
      kind: eventKind,
      missionId,
      timestamp: ts,
      payload: {
        from: mission.status,
        to: options.toStatus,
        decision: options.decision,
        decidedBy: options.decidedBy
      }
    };

    await appendLedgerEntry(runsRoot, missionId, event);
    await atomicWrite(missionJsonPath(runsRoot, missionId), JSON.stringify(updated, null, 2));
    return updated;
  });
}
