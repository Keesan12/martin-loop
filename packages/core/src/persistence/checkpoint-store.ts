import { createHash, randomUUID } from "node:crypto";
import { constants, mkdir, open, readFile, readdir, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";

export type CheckpointStoreErrorCode =
  | "corrupt_checkpoint"
  | "corrupt_head"
  | "duplicate_checkpoint"
  | "invalid_checkpoint_id"
  | "lock_timeout"
  | "missing_parent"
  | "stale_writer";

export class CheckpointStoreError extends Error {
  constructor(
    public readonly code: CheckpointStoreErrorCode,
    message: string,
    public readonly details: Readonly<Record<string, unknown>> = {}
  ) {
    super(message);
    this.name = "CheckpointStoreError";
  }
}

export interface CheckpointEnvelope<T> {
  schemaVersion: "martin.checkpoint.v1";
  sequence: number;
  checkpointId: string;
  parentHash: string | null;
  hash: string;
  writerId: string;
  createdAt: string;
  compaction: CheckpointCompaction;
  state: T;
}

export interface CheckpointAppendOptions {
  checkpointId: string;
  writerId: string;
  expectedHeadHash: string | null;
  now?: string;
}

export interface CheckpointCompaction {
  algorithm: "sha256-json-v1";
  arraysTrimmed: number;
  entriesRemoved: number;
  removedContentHash: string;
}

export interface CheckpointAppendResult<T> {
  checkpoint: CheckpointEnvelope<T>;
  compaction: CheckpointCompaction;
}

export interface CheckpointStore<T> {
  append(state: T, options: CheckpointAppendOptions): Promise<CheckpointAppendResult<T>>;
  loadHead(): Promise<CheckpointEnvelope<T> | null>;
  loadCompactionProvenance(hash: string): Promise<CheckpointCompactionProvenanceEntry[]>;
}

export interface CheckpointCompactionProvenanceEntry {
  path: string;
  entries: unknown[];
}

export interface CreateCheckpointStoreOptions {
  root: string;
  maxArrayEntries?: number;
  lockTimeoutMs?: number;
  lockRetryMs?: number;
  lockStaleMs?: number;
}

interface HeadPointer {
  checkpointId: string;
  checkpointHash: string;
  sequence: number;
}

interface LockOwner {
  token: string;
  pid: number;
  acquiredAt: string;
}

const SCHEMA_VERSION = "martin.checkpoint.v1" as const;
const CHECKPOINT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function isFileSystemError(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

function withoutHash<T>(checkpoint: CheckpointEnvelope<T>): Omit<CheckpointEnvelope<T>, "hash"> {
  return {
    schemaVersion: checkpoint.schemaVersion,
    sequence: checkpoint.sequence,
    checkpointId: checkpoint.checkpointId,
    parentHash: checkpoint.parentHash,
    writerId: checkpoint.writerId,
    createdAt: checkpoint.createdAt,
    compaction: checkpoint.compaction,
    state: checkpoint.state
  };
}

function checkpointHash<T>(checkpoint: Omit<CheckpointEnvelope<T>, "hash">): string {
  return sha256(JSON.stringify(checkpoint));
}

function compactValue(
  value: unknown,
  maxArrayEntries: number,
  summary: CheckpointCompaction,
  ancestors: Set<object>,
  path: string,
  removedContent: Array<{ path: string; entries: unknown[] }>
): unknown {
  if (Array.isArray(value)) {
    if (ancestors.has(value)) {
      throw new TypeError("checkpoint state must not contain circular references");
    }
    ancestors.add(value);
    const removed = Math.max(0, value.length - maxArrayEntries);
    if (removed > 0) {
      summary.arraysTrimmed += 1;
      summary.entriesRemoved += removed;
      removedContent.push({ path, entries: value.slice(0, removed) });
    }
    const compacted = value
      .slice(removed)
      .map((entry, index) =>
        compactValue(entry, maxArrayEntries, summary, ancestors, `${path}/${index}`, removedContent)
      );
    ancestors.delete(value);
    return compacted;
  }

  if (value !== null && typeof value === "object") {
    if (ancestors.has(value)) {
      throw new TypeError("checkpoint state must not contain circular references");
    }
    ancestors.add(value);
    const compacted = Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        compactValue(entry, maxArrayEntries, summary, ancestors, `${path}/${key}`, removedContent)
      ])
    );
    ancestors.delete(value);
    return compacted;
  }

  return value;
}

export function compactCheckpointState<T>(
  state: T,
  maxArrayEntries: number
): { state: T; compaction: CheckpointCompaction; removedContent: CheckpointCompactionProvenanceEntry[] } {
  if (!Number.isSafeInteger(maxArrayEntries) || maxArrayEntries < 1) {
    throw new RangeError("maxArrayEntries must be a positive safe integer");
  }
  const removedContent: Array<{ path: string; entries: unknown[] }> = [];
  const compaction: CheckpointCompaction = {
    algorithm: "sha256-json-v1",
    arraysTrimmed: 0,
    entriesRemoved: 0,
    removedContentHash: ""
  };
  const compacted = compactValue(state, maxArrayEntries, compaction, new Set(), "$", removedContent) as T;
  compaction.removedContentHash = sha256(JSON.stringify(removedContent));
  return { state: compacted, compaction, removedContent };
}

export function createCheckpointStore<T>(
  options: CreateCheckpointStoreOptions
): CheckpointStore<T> {
  const root = options.root;
  const checkpointsRoot = join(root, "checkpoints");
  const compactionsRoot = join(root, "compactions");
  const headPath = join(root, "head.json");
  const previousHeadPath = join(root, ".head.previous.json");
  const lockPath = join(root, ".checkpoint.lock");
  const maxArrayEntries = options.maxArrayEntries ?? 200;
  const lockTimeoutMs = options.lockTimeoutMs ?? 5_000;
  const lockRetryMs = options.lockRetryMs ?? 20;
  const lockStaleMs = options.lockStaleMs ?? 30_000;

  if (!Number.isSafeInteger(maxArrayEntries) || maxArrayEntries < 1 ||
      !Number.isFinite(lockTimeoutMs) || lockTimeoutMs < 0 ||
      !Number.isFinite(lockRetryMs) || lockRetryMs <= 0 ||
      !Number.isFinite(lockStaleMs) || lockStaleMs < 1) {
    throw new RangeError("invalid checkpoint store limits");
  }

  async function readHeadPointer(): Promise<HeadPointer | null> {
    let raw: string;
    try {
      raw = await readFile(headPath, "utf8");
    } catch (error) {
      if (!isFileSystemError(error, "ENOENT")) throw error;
      try {
        raw = await readFile(previousHeadPath, "utf8");
      } catch (previousError) {
        if (isFileSystemError(previousError, "ENOENT")) return null;
        throw previousError;
      }
    }

    try {
      const parsed = JSON.parse(raw) as Partial<HeadPointer>;
      const sequence = parsed.sequence;
      if (
        typeof parsed.checkpointId !== "string" ||
        !CHECKPOINT_ID.test(parsed.checkpointId) ||
        typeof parsed.checkpointHash !== "string" ||
        !/^[a-f0-9]{64}$/u.test(parsed.checkpointHash) ||
        typeof sequence !== "number" || !Number.isSafeInteger(sequence) || sequence < 1
      ) {
        throw new Error("invalid head shape");
      }
      return { checkpointId: parsed.checkpointId, checkpointHash: parsed.checkpointHash, sequence };
    } catch (error) {
      throw new CheckpointStoreError("corrupt_head", "checkpoint head is malformed", {
        cause: error instanceof Error ? error.message : String(error)
      });
    }
  }

  async function readCheckpoint(checkpointId: string): Promise<CheckpointEnvelope<T>> {
    const filePath = join(checkpointsRoot, `${checkpointId}.json`);
    let raw: string;
    try {
      raw = await readFile(filePath, "utf8");
    } catch (error) {
      if (isFileSystemError(error, "ENOENT")) {
        throw new CheckpointStoreError("missing_parent", `checkpoint ${checkpointId} is missing`, {
          checkpointId
        });
      }
      throw error;
    }

    try {
      const checkpoint = JSON.parse(raw) as CheckpointEnvelope<T>;
      if (
        checkpoint.schemaVersion !== SCHEMA_VERSION ||
        !Number.isSafeInteger(checkpoint.sequence) || checkpoint.sequence < 1 ||
        checkpoint.checkpointId !== checkpointId ||
        typeof checkpoint.writerId !== "string" ||
        checkpoint.writerId.length === 0 ||
        typeof checkpoint.createdAt !== "string" ||
        !Number.isFinite(Date.parse(checkpoint.createdAt)) ||
        checkpoint.compaction === null || typeof checkpoint.compaction !== "object" ||
        checkpoint.compaction.algorithm !== "sha256-json-v1" ||
        !Number.isSafeInteger(checkpoint.compaction.arraysTrimmed) ||
        checkpoint.compaction.arraysTrimmed < 0 ||
        !Number.isSafeInteger(checkpoint.compaction.entriesRemoved) ||
        checkpoint.compaction.entriesRemoved < 0 ||
        !/^[a-f0-9]{64}$/u.test(checkpoint.compaction.removedContentHash) ||
        !("state" in checkpoint) ||
        (checkpoint.parentHash !== null &&
          (typeof checkpoint.parentHash !== "string" || !/^[a-f0-9]{64}$/u.test(checkpoint.parentHash))) ||
        typeof checkpoint.hash !== "string" ||
        checkpoint.hash !== checkpointHash(withoutHash(checkpoint))
      ) {
        throw new Error("checkpoint shape or digest mismatch");
      }
      return checkpoint;
    } catch (error) {
      if (error instanceof CheckpointStoreError) throw error;
      throw new CheckpointStoreError(
        "corrupt_checkpoint",
        `checkpoint ${checkpointId} failed integrity validation`,
        { checkpointId, cause: error instanceof Error ? error.message : String(error) }
      );
    }
  }

  async function findCheckpointIdByHash(hash: string): Promise<string | null> {
    let names: string[];
    try {
      names = await readdir(checkpointsRoot);
    } catch (error) {
      if (isFileSystemError(error, "ENOENT")) return null;
      throw error;
    }
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      const checkpointId = name.slice(0, -5);
      if (!CHECKPOINT_ID.test(checkpointId)) continue;
      const checkpoint = await readCheckpoint(checkpointId);
      if (checkpoint.hash === hash) return checkpointId;
    }
    return null;
  }

  async function loadHead(): Promise<CheckpointEnvelope<T> | null> {
    const pointer = await readHeadPointer();
    if (pointer === null) {
      const names = await readdir(checkpointsRoot).catch((error: unknown) => {
        if (isFileSystemError(error, "ENOENT")) return [];
        throw error;
      });
      if (names.some((name) => name.endsWith(".json"))) {
        throw new CheckpointStoreError("corrupt_head", "checkpoint files exist without a head");
      }
      return null;
    }
    const head = await readCheckpoint(pointer.checkpointId);
    if (head.hash !== pointer.checkpointHash) {
      throw new CheckpointStoreError("corrupt_head", "checkpoint head digest does not match target", {
        checkpointId: pointer.checkpointId
      });
    }
    if (head.sequence !== pointer.sequence) {
      throw new CheckpointStoreError("corrupt_head", "checkpoint head sequence does not match target", {
        checkpointId: pointer.checkpointId
      });
    }

    const visited = new Set<string>([head.hash]);
    let cursor = head;
    while (cursor.parentHash !== null) {
      if (visited.has(cursor.parentHash)) {
        throw new CheckpointStoreError("corrupt_checkpoint", "checkpoint parent chain contains a cycle", {
          checkpointId: cursor.checkpointId
        });
      }
      const parentId = await findCheckpointIdByHash(cursor.parentHash);
      if (parentId === null) {
        throw new CheckpointStoreError("missing_parent", "checkpoint parent hash cannot be resolved", {
          checkpointId: cursor.checkpointId,
          parentHash: cursor.parentHash
        });
      }
      cursor = await readCheckpoint(parentId);
      if (cursor.sequence !== head.sequence - visited.size) {
        throw new CheckpointStoreError("corrupt_checkpoint", "checkpoint sequence is not monotonic", {
          checkpointId: cursor.checkpointId
        });
      }
      visited.add(cursor.hash);
    }
    return head;
  }

  async function acquireLock(): Promise<LockOwner> {
    await mkdir(root, { recursive: true });
    const startedAt = Date.now();
    const owner: LockOwner = {
      token: randomUUID(),
      pid: process.pid,
      acquiredAt: new Date().toISOString()
    };

    let firstAttempt = true;
    let postReclaimAttempt = false;
    while (firstAttempt || postReclaimAttempt || Date.now() - startedAt <= lockTimeoutMs) {
      const isPostReclaimAttempt = postReclaimAttempt;
      firstAttempt = false;
      postReclaimAttempt = false;
      try {
        const handle = await open(lockPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY);
        try {
          await handle.writeFile(`${JSON.stringify(owner)}\n`, "utf8");
          await handle.sync();
        } finally {
          await handle.close();
        }
        return owner;
      } catch (error) {
        if (!isFileSystemError(error, "EEXIST")) throw error;
        if (isPostReclaimAttempt && Date.now() - startedAt > lockTimeoutMs) break;
        const reclaimed = await reclaimStaleLock();
        if (reclaimed) {
          postReclaimAttempt = true;
          continue;
        }
        if (Date.now() - startedAt > lockTimeoutMs) break;
        await new Promise<void>((resolve) => setTimeout(resolve, lockRetryMs));
      }
    }
    throw new CheckpointStoreError("lock_timeout", "checkpoint store lock is already held", {
      lockPath,
      lockTimeoutMs
    });
  }

  function isProcessAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return !isFileSystemError(error, "ESRCH");
    }
  }

  async function reclaimStaleLock(): Promise<boolean> {
    const reclaimPath = `${lockPath}.reclaim`;
    const reclaimOwner: LockOwner = {
      token: randomUUID(),
      pid: process.pid,
      acquiredAt: new Date().toISOString()
    };
    let reclaimHandle;
    try {
      reclaimHandle = await open(reclaimPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY);
    } catch (error) {
      if (isFileSystemError(error, "EEXIST")) {
        await removeDeadOwnerFile(reclaimPath, lockStaleMs);
        return false;
      }
      throw error;
    }
    try {
      await reclaimHandle.writeFile(`${JSON.stringify(reclaimOwner)}\n`, "utf8");
      const raw = await readFile(lockPath, "utf8").catch(() => null);
      if (raw === null) return false;
      let owner: LockOwner;
      try {
        owner = JSON.parse(raw) as LockOwner;
      } catch {
        return false;
      }
      if (
        typeof owner.token !== "string" || !owner.token ||
        !Number.isSafeInteger(owner.pid) || owner.pid < 1 ||
        !Number.isFinite(Date.parse(owner.acquiredAt)) ||
        Date.now() - Date.parse(owner.acquiredAt) < lockStaleMs ||
        isProcessAlive(owner.pid)
      ) {
        return false;
      }
      const current = await readFile(lockPath, "utf8").catch(() => null);
      if (current !== raw) return false;
      await rm(lockPath, { force: true });
      return true;
    } finally {
      await reclaimHandle.close().catch(() => {});
      await rm(reclaimPath, { force: true });
    }
  }

  async function removeDeadOwnerFile(path: string, staleMs: number): Promise<void> {
    const raw = await readFile(path, "utf8").catch(() => null);
    if (raw === null) return;
    let owner: LockOwner;
    try {
      owner = JSON.parse(raw) as LockOwner;
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

  async function releaseLock(owner: LockOwner): Promise<void> {
    const raw = await readFile(lockPath, "utf8").catch(() => null);
    if (raw === null) return;
    let persisted: Partial<LockOwner>;
    try {
      persisted = JSON.parse(raw) as Partial<LockOwner>;
    } catch {
      return;
    }
    if (persisted.token === owner.token) {
      await rm(lockPath, { force: true });
    }
  }

  async function append(
    state: T,
    appendOptions: CheckpointAppendOptions
  ): Promise<CheckpointAppendResult<T>> {
    if (!CHECKPOINT_ID.test(appendOptions.checkpointId)) {
      throw new CheckpointStoreError(
        "invalid_checkpoint_id",
        `invalid checkpoint id: ${appendOptions.checkpointId}`
      );
    }
    if (!appendOptions.writerId.trim()) {
      throw new TypeError("writerId must not be empty");
    }
    if (appendOptions.now !== undefined && !Number.isFinite(Date.parse(appendOptions.now))) {
      throw new TypeError("checkpoint timestamp must be valid");
    }
    const owner = await acquireLock();
    try {
      await mkdir(checkpointsRoot, { recursive: true });
      const checkpointPath = join(checkpointsRoot, `${appendOptions.checkpointId}.json`);
      try {
        await stat(checkpointPath);
        throw new CheckpointStoreError(
          "duplicate_checkpoint",
          `checkpoint ${appendOptions.checkpointId} already exists`
        );
      } catch (error) {
        if (!isFileSystemError(error, "ENOENT")) throw error;
      }

      const current = await loadHead();
      const actualHeadHash = current?.hash ?? null;
      if (appendOptions.expectedHeadHash !== actualHeadHash) {
        throw new CheckpointStoreError("stale_writer", "checkpoint compare-and-swap failed", {
          expectedHeadHash: appendOptions.expectedHeadHash,
          actualHeadHash
        });
      }

      const compacted = compactCheckpointState(state, maxArrayEntries);
      const checkpointWithoutHash: Omit<CheckpointEnvelope<T>, "hash"> = {
        schemaVersion: SCHEMA_VERSION,
        sequence: (current?.sequence ?? 0) + 1,
        checkpointId: appendOptions.checkpointId,
        parentHash: actualHeadHash,
        writerId: appendOptions.writerId,
        createdAt: appendOptions.now ?? new Date().toISOString(),
        compaction: compacted.compaction,
        state: compacted.state
      };
      const checkpoint: CheckpointEnvelope<T> = {
        ...checkpointWithoutHash,
        hash: checkpointHash(checkpointWithoutHash)
      };

      if (compacted.compaction.entriesRemoved > 0) {
        await mkdir(compactionsRoot, { recursive: true });
        const provenancePath = join(compactionsRoot, `${compacted.compaction.removedContentHash}.json`);
        const existing = await readFile(provenancePath, "utf8").catch((error: unknown) => {
          if (isFileSystemError(error, "ENOENT")) return null;
          throw error;
        });
        if (existing === null) {
          const provenanceHandle = await open(provenancePath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY);
          try {
            await provenanceHandle.writeFile(`${JSON.stringify(compacted.removedContent, null, 2)}\n`, "utf8");
            await provenanceHandle.sync();
          } finally {
            await provenanceHandle.close();
          }
        } else if (sha256(JSON.stringify(JSON.parse(existing))) !== compacted.compaction.removedContentHash) {
          throw new CheckpointStoreError("corrupt_checkpoint", "compaction provenance hash collision or corruption");
        }
      }

      const checkpointTempPath = join(checkpointsRoot, `.${owner.token}.tmp`);
      const handle = await open(checkpointTempPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY);
      try {
        await handle.writeFile(`${JSON.stringify(checkpoint, null, 2)}\n`, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }

      // Publication is protected by the exclusive store lock and the duplicate-id check above.
      // Atomic rename works on Windows synchronized filesystems where hard-link creation is denied.
      try {
        await rename(checkpointTempPath, checkpointPath);
      } catch (error) {
        await rm(checkpointTempPath, { force: true });
        throw error;
      }
      await readCheckpoint(checkpoint.checkpointId);
      const headTempPath = join(root, `.head.${owner.token}.tmp`);
      const headHandle = await open(headTempPath, "wx");
      try {
        await headHandle.writeFile(
          `${JSON.stringify({ checkpointId: checkpoint.checkpointId, checkpointHash: checkpoint.hash, sequence: checkpoint.sequence })}\n`,
          "utf8"
        );
        await headHandle.sync();
      } finally {
        await headHandle.close();
      }
      const currentHeadExists = await stat(headPath).then(() => true).catch((error: unknown) => {
        if (isFileSystemError(error, "ENOENT")) return false;
        throw error;
      });
      if (currentHeadExists) {
        await rm(previousHeadPath, { force: true });
        await rename(headPath, previousHeadPath);
      }
      try {
        // Some synchronized filesystems deny rename-over-existing. Rotate the verified old head aside first;
        // readers fall back to it until the fsynced new head is atomically published.
        await rename(headTempPath, headPath);
      } catch (error) {
        await rm(headTempPath, { force: true });
        const headMissing = await stat(headPath).then(() => false).catch((statError: unknown) => {
          if (isFileSystemError(statError, "ENOENT")) return true;
          throw statError;
        });
        if (headMissing) await rename(previousHeadPath, headPath).catch(() => undefined);
        throw error;
      }
      await rm(previousHeadPath, { force: true });
      return { checkpoint, compaction: compacted.compaction };
    } finally {
      await releaseLock(owner);
    }
  }

  async function loadCompactionProvenance(hash: string): Promise<CheckpointCompactionProvenanceEntry[]> {
    if (!/^[a-f0-9]{64}$/u.test(hash)) throw new TypeError("compaction provenance hash must be SHA-256");
    let raw: string;
    try {
      raw = await readFile(join(compactionsRoot, `${hash}.json`), "utf8");
    } catch (error) {
      if (isFileSystemError(error, "ENOENT")) {
        throw new CheckpointStoreError("missing_parent", "compaction provenance archive is missing", { hash });
      }
      throw error;
    }
    try {
      const parsed = JSON.parse(raw) as CheckpointCompactionProvenanceEntry[];
      if (!Array.isArray(parsed) || sha256(JSON.stringify(parsed)) !== hash) throw new Error("digest mismatch");
      return parsed;
    } catch (error) {
      throw new CheckpointStoreError("corrupt_checkpoint", "compaction provenance archive is corrupt", {
        hash, cause: error instanceof Error ? error.message : String(error)
      });
    }
  }

  return { append, loadHead, loadCompactionProvenance };
}
