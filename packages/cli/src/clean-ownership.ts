import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { Stats } from "node:fs";
import { link, lstat, mkdir, open, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const CLEAN_OWNERSHIP_SCHEMA = "martin.clean-ownership.v1";
const CLEAN_OWNERSHIP_LOCK_SCHEMA = "martin.clean-ownership-lock.v1";
const CLEAN_OWNERSHIP_RECOVERY_OWNER_SCHEMA = "martin.clean-ownership-recovery-owner.v1";
const KEY_DIRECTORY_MODE = 0o700;
const KEY_FILE_MODE = 0o600;
const LOCK_LEASE_MS = 5_000;
const LOCK_WAIT_MS = 1_000;
const INITIALIZATION_GRACE_MS = 5_000;
const ownershipRecoveryTails = new Map<string, Promise<void>>();
const ownershipKeyInitializationTails = new Map<string, Promise<void>>();
let recoveryClaimBeforeCleanupTestHook:
  | ((input: { path: string; claimPath: string }) => Promise<void>)
  | undefined;

interface CleanOwnershipMarker {
  schemaVersion: typeof CLEAN_OWNERSHIP_SCHEMA;
  kind: "workflow-state";
  runsRootSha256: string;
  keyId: string;
  createdAt: string;
  signatureHmacSha256: string;
}

interface CleanOwnershipLock {
  schemaVersion: typeof CLEAN_OWNERSHIP_LOCK_SCHEMA;
  nonce: string;
  pid: number;
  createdAt: string;
  // Immutable publication timestamp retained under the v1 field name. PID liveness is
  // authoritative; a reused live PID therefore fails closed instead of reclaiming the lock.
  heartbeatAt: string;
}

interface RecoveryClaimOwner {
  schemaVersion: typeof CLEAN_OWNERSHIP_RECOVERY_OWNER_SCHEMA;
  nonce: string;
  pid: number;
  createdAt: string;
}

interface FileIdentity {
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
  birthtimeMs: number;
}

export function setRecoveryClaimBeforeCleanupTestHookForTesting(
  hook: ((input: { path: string; claimPath: string }) => Promise<void>) | undefined
): void {
  recoveryClaimBeforeCleanupTestHook = hook;
}

export async function ensureWorkflowCleanOwnership(runsRoot: string): Promise<void> {
  const canonicalRunsRoot = resolve(runsRoot);
  await assertSafeOwnershipDirectory(canonicalRunsRoot, false);
  const workflowRoot = join(canonicalRunsRoot, "_martin");
  await assertSafeOwnershipDirectory(workflowRoot, false);
  const key = await ensureOwnershipKey(canonicalRunsRoot);
  const base = {
    schemaVersion: CLEAN_OWNERSHIP_SCHEMA as typeof CLEAN_OWNERSHIP_SCHEMA,
    kind: "workflow-state" as const,
    runsRootSha256: sha256(canonicalRunsRoot),
    keyId: sha256(key).slice(0, 16),
    createdAt: new Date().toISOString()
  };
  const marker: CleanOwnershipMarker = {
    ...base,
    signatureHmacSha256: signOwnership(key, base)
  };
  const markerPath = resolveWorkflowOwnershipPath(canonicalRunsRoot);
  const ownershipAlreadyPublished = async (): Promise<boolean> => {
    await assertSafeOwnershipDirectory(canonicalRunsRoot, true);
    await assertSafeOwnershipDirectory(workflowRoot, true);
    await assertSafeMarkerLeaf(markerPath);
    return await verifyWorkflowCleanOwnership(canonicalRunsRoot, workflowRoot);
  };
  if (await ownershipAlreadyPublished()) {
    return;
  }
  await withOwnershipWriteLock(workflowRoot, async () => {
    await assertSafeMarkerLeaf(markerPath);
    if (await verifyWorkflowCleanOwnership(canonicalRunsRoot, workflowRoot)) {
      return;
    }
    const tempPath = join(workflowRoot, `.clean-ownership.${randomBytes(8).toString("hex")}.tmp`);
    try {
      await writeFile(tempPath, `${JSON.stringify(marker, null, 2)}\n`, {
        encoding: "utf8",
        mode: KEY_FILE_MODE,
        flag: "wx"
      });
      await assertSafeOwnershipDirectory(canonicalRunsRoot, true);
      await assertSafeOwnershipDirectory(workflowRoot, true);
      await assertSafeMarkerLeaf(markerPath);
      await rename(tempPath, markerPath);
      await assertSafeMarkerLeaf(markerPath, true);
    } finally {
      await rm(tempPath, { force: true });
    }
  }, ownershipAlreadyPublished);
}

export async function verifyWorkflowCleanOwnership(
  runsRoot: string,
  workflowRoot = join(resolve(runsRoot), "_martin")
): Promise<boolean> {
  const canonicalRunsRoot = resolve(runsRoot);
  const markerPath = join(resolve(workflowRoot), "clean-ownership.json");
  const markerInfo = await lstat(markerPath).catch(() => undefined);
  if (!markerInfo?.isFile() || markerInfo.isSymbolicLink()) {
    return false;
  }

  let marker: CleanOwnershipMarker;
  try {
    marker = JSON.parse(await readFile(markerPath, "utf8")) as CleanOwnershipMarker;
  } catch {
    return false;
  }
  if (
    marker.schemaVersion !== CLEAN_OWNERSHIP_SCHEMA ||
    marker.kind !== "workflow-state" ||
    marker.runsRootSha256 !== sha256(canonicalRunsRoot) ||
    !/^[a-f0-9]{16}$/u.test(marker.keyId) ||
    !/^[a-f0-9]{64}$/u.test(marker.signatureHmacSha256) ||
    Number.isNaN(Date.parse(marker.createdAt))
  ) {
    return false;
  }

  const key = await readOwnershipKey(canonicalRunsRoot).catch(() => undefined);
  if (!key || marker.keyId !== sha256(key).slice(0, 16)) {
    return false;
  }
  const expected = signOwnership(key, {
    schemaVersion: marker.schemaVersion,
    kind: marker.kind,
    runsRootSha256: marker.runsRootSha256,
    keyId: marker.keyId,
    createdAt: marker.createdAt
  });
  return safeHexEqual(expected, marker.signatureHmacSha256);
}

function resolveWorkflowOwnershipPath(runsRoot: string): string {
  return join(runsRoot, "_martin", "clean-ownership.json");
}

async function assertSafeOwnershipDirectory(path: string, mustExist: boolean, createMode?: number): Promise<void> {
  const resolvedPath = await resolveCleanOwnershipDirectoryPath(path);
  let info = await lstat(resolvedPath).catch(() => undefined);
  if (!info && !mustExist) {
    const missing: string[] = [];
    let cursor = resolvedPath;
    while (!await lstat(cursor).then(() => true).catch(() => false)) {
      missing.push(cursor);
      const parent = dirname(cursor);
      if (parent === cursor) {
        break;
      }
      cursor = parent;
    }
    await validateExistingOwnershipDirectory(cursor);
    for (const directory of missing.reverse()) {
      try {
        await mkdir(directory, createMode === undefined ? undefined : { mode: createMode });
      } catch (error: unknown) {
        const raced = await lstat(directory).catch(() => undefined);
        if (!raced) {
          throw error;
        }
      }
      await validateExistingOwnershipDirectory(directory);
    }
    info = await lstat(resolvedPath).catch(() => undefined);
  }
  if (!info?.isDirectory() || info.isSymbolicLink()) {
    throw new Error(`unsafe clean ownership directory: ${resolvedPath}`);
  }
  const canonicalPath = await realpath(resolvedPath);
  if (!isSameCanonicalPath(canonicalPath, resolvedPath)) {
    throw new Error(`clean ownership directory contains a symbolic link or junction: ${resolvedPath}`);
  }
}

async function validateExistingOwnershipDirectory(path: string): Promise<void> {
  const resolvedPath = await resolveCleanOwnershipDirectoryPath(path);
  const info = await lstat(resolvedPath);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error(`unsafe clean ownership directory: ${resolvedPath}`);
  }
  const canonicalPath = await realpath(resolvedPath);
  if (!isSameCanonicalPath(canonicalPath, resolvedPath)) {
    throw new Error(`clean ownership directory contains a symbolic link or junction: ${resolvedPath}`);
  }
}

export async function resolveCleanOwnershipDirectoryPath(path: string): Promise<string> {
  const resolvedPath = resolve(path);
  // macOS exposes its standard temporary hierarchy through /var -> /private/var.
  // Normalize only that OS-owned alias before applying the strict descendant
  // symlink checks; arbitrary caller-controlled aliases remain fail-closed.
  if (process.platform === "darwin" && (resolvedPath === "/var" || resolvedPath.startsWith("/var/"))) {
    const canonicalVar = await realpath("/var");
    return `${canonicalVar}${resolvedPath.slice(4)}`;
  }
  return resolvedPath;
}

async function assertSafeMarkerLeaf(markerPath: string, mustExist = false): Promise<void> {
  const info = await lstat(markerPath).catch(() => undefined);
  if (!info) {
    if (mustExist) {
      throw new Error(`clean ownership marker is missing: ${markerPath}`);
    }
    return;
  }
  if (!info.isFile() || info.isSymbolicLink() || info.nlink > 1) {
    throw new Error(`clean ownership marker is not an exclusive regular file: ${markerPath}`);
  }
}

async function withOwnershipWriteLock(
  workflowRoot: string,
  action: () => Promise<void>,
  contentionSatisfied?: () => Promise<boolean>
): Promise<void> {
  const lockPath = join(workflowRoot, ".clean-ownership.lock");
  await cleanupAbandonedRecoveryClaims(lockPath);
  const deadline = Date.now() + LOCK_WAIT_MS;
  const now = new Date().toISOString();
  const lock: CleanOwnershipLock = {
    schemaVersion: CLEAN_OWNERSHIP_LOCK_SCHEMA,
    nonce: randomBytes(16).toString("hex"),
    pid: process.pid,
    createdAt: now,
    heartbeatAt: now
  };
  while (!await publishExclusiveFile(lockPath, `${JSON.stringify(lock)}\n`)) {
    if (await contentionSatisfied?.()) {
      return;
    }
    if (await recoverAbandonedOwnershipLock(lockPath)) {
      continue;
    }
    if (await contentionSatisfied?.()) {
      return;
    }
    if (Date.now() >= deadline) {
      throw new Error(`live or unverifiable clean ownership marker lock was not stolen: ${lockPath}`);
    }
    await delay(10);
  }
  try {
    await action();
  } finally {
    if (!await removeOwnershipLockIfNonceMatches(lockPath, lock.nonce)) {
      throw new Error(`clean ownership marker lock changed ownership and was not deleted: ${lockPath}`);
    }
  }
}

async function cleanupAbandonedRecoveryClaims(path: string): Promise<void> {
  const baseName = path.slice(dirname(path).length + 1);
  const recoveryPrefix = `${baseName}.recovery.`;
  const entries = await readdir(dirname(path)).catch((error: unknown) => {
    if (isNodeErrorWithCode(error, "ENOENT")) {
      return [];
    }
    throw error;
  });
  const claimPaths = new Set<string>();
  for (const entry of entries) {
    if (!entry.startsWith(recoveryPrefix)) {
      continue;
    }
    const claimSuffix = entry.indexOf(".claim");
    if (claimSuffix < 0 || entry.slice(claimSuffix) !== ".claim" && entry.slice(claimSuffix) !== ".claim.owner") {
      continue;
    }
    claimPaths.add(join(dirname(path), entry.slice(0, claimSuffix + ".claim".length)));
  }
  for (const claimPath of claimPaths) {
    const ownerPath = `${claimPath}.owner`;
    const owner = await acquireRecoveryClaimOwner(ownerPath);
    if (!owner) {
      continue;
    }
    try {
      const claimInfo = await lstat(claimPath).catch(() => undefined);
      if (claimInfo) {
        if (!claimInfo.isFile() || claimInfo.isSymbolicLink()) {
          throw new Error(`invalid clean ownership recovery claim: ${claimPath}`);
        }
        await rm(claimPath, { force: false });
      }
    } finally {
      if (!await removeRecoveryClaimOwnerIfNonceMatches(ownerPath, owner.nonce)) {
        throw new Error(`clean ownership recovery claim owner changed: ${ownerPath}`);
      }
    }
  }
}

async function recoverAbandonedOwnershipLock(lockPath: string): Promise<boolean> {
  const previous = ownershipRecoveryTails.get(lockPath) ?? Promise.resolve();
  let release!: () => void;
  const turn = new Promise<void>((resolveTurn) => {
    release = resolveTurn;
  });
  const tail = previous.catch(() => {}).then(() => turn);
  ownershipRecoveryTails.set(lockPath, tail);
  await previous.catch(() => {});
  try {
    return await recoverAbandonedOwnershipLockExclusive(lockPath);
  } finally {
    release();
    if (ownershipRecoveryTails.get(lockPath) === tail) {
      ownershipRecoveryTails.delete(lockPath);
    }
  }
}

async function recoverAbandonedOwnershipLockExclusive(lockPath: string): Promise<boolean> {
  const info = await normalizeExclusivePublication(lockPath);
  if (!info) {
    return false;
  }
  if (!info.isFile() || info.isSymbolicLink() || info.nlink > 1) {
    return false;
  }
  const identity = fileIdentity(info);
  const initial = await readOwnershipLock(lockPath);
  if (!initial) {
    if (Date.now() - info.mtimeMs <= INITIALIZATION_GRACE_MS) {
      return false;
    }
    return await removeFileWithExclusiveRecoveryClaim(lockPath, identity, async () => true);
  }
  const heartbeat = Date.parse(initial.heartbeatAt);
  if (!Number.isFinite(heartbeat) || Date.now() - heartbeat <= LOCK_LEASE_MS || isProcessAlive(initial.pid)) {
    return false;
  }
  return await removeFileWithExclusiveRecoveryClaim(lockPath, identity, async (claimPath) => {
    const claimed = await readOwnershipLockAtPath(claimPath, false);
    if (!claimed || claimed.nonce !== initial.nonce) {
      return false;
    }
    const claimedHeartbeat = Date.parse(claimed.heartbeatAt);
    return Number.isFinite(claimedHeartbeat) &&
      Date.now() - claimedHeartbeat > LOCK_LEASE_MS &&
      !isProcessAlive(claimed.pid);
  });
}

async function readOwnershipLock(lockPath: string): Promise<CleanOwnershipLock | undefined> {
  const info = await normalizeExclusivePublication(lockPath);
  if (!info) {
    return undefined;
  }
  return await readOwnershipLockAtPath(lockPath, true, info);
}

async function readOwnershipLockAtPath(
  path: string,
  requireExclusive: boolean,
  knownInfo?: Stats
): Promise<CleanOwnershipLock | undefined> {
  const info = knownInfo ?? await lstat(path).catch(() => undefined);
  if (!info?.isFile() || info.isSymbolicLink() || (requireExclusive && info.nlink > 1)) {
    return undefined;
  }
  let lock: CleanOwnershipLock;
  try {
    lock = JSON.parse(await readFile(path, "utf8")) as CleanOwnershipLock;
  } catch {
    return undefined;
  }
  if (
    lock.schemaVersion !== CLEAN_OWNERSHIP_LOCK_SCHEMA ||
    !/^[a-f0-9]{32}$/u.test(lock.nonce) ||
    !Number.isSafeInteger(lock.pid) ||
    lock.pid <= 0 ||
    Number.isNaN(Date.parse(lock.createdAt)) ||
    Number.isNaN(Date.parse(lock.heartbeatAt))
  ) {
    return undefined;
  }
  return lock;
}

async function removeOwnershipLockIfNonceMatches(
  lockPath: string,
  expectedNonce: string
): Promise<boolean> {
  const deadline = Date.now() + LOCK_WAIT_MS;
  while (true) {
    const info = await normalizeExclusivePublication(lockPath);
    if (!info?.isFile() || info.isSymbolicLink()) {
      return false;
    }
    const confirmed = await readOwnershipLockAtPath(lockPath, false, info);
    if (!confirmed || confirmed.nonce !== expectedNonce) {
      return false;
    }
    if (info.nlink <= 1 && await removeFileWithExclusiveRecoveryClaim(
      lockPath,
      fileIdentity(info),
      async (claimPath) => {
        const claimed = await readOwnershipLockAtPath(claimPath, false);
        return claimed?.nonce === expectedNonce;
      }
    )) {
      return true;
    }
    if (Date.now() >= deadline) {
      return false;
    }
    await delay(10);
  }
}

async function publishExclusiveFile(finalPath: string, contents: string): Promise<boolean> {
  const tempPath = join(dirname(finalPath), `.${randomBytes(16).toString("hex")}.init.tmp`);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(tempPath, "wx", KEY_FILE_MODE);
    await handle.writeFile(contents, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    try {
      await link(tempPath, finalPath);
      return true;
    } catch (error: unknown) {
      if (isNodeErrorWithCode(error, "EEXIST")) {
        return false;
      }
      throw error;
    }
  } finally {
    await handle?.close().catch(() => {});
    await rm(tempPath, { force: true }).catch(() => {});
  }
}

async function normalizeExclusivePublication(finalPath: string): Promise<Stats | undefined> {
  let finalInfo = await lstat(finalPath).catch(() => undefined);
  if (!finalInfo || !finalInfo.isFile() || finalInfo.isSymbolicLink() || finalInfo.nlink <= 1) {
    return finalInfo;
  }
  const expected = fileIdentity(finalInfo);
  const entries = await readdir(dirname(finalPath), { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.name.startsWith(".") || !entry.name.endsWith(".init.tmp")) {
      continue;
    }
    const tempPath = join(dirname(finalPath), entry.name);
    const tempInfo = await lstat(tempPath).catch(() => undefined);
    if (!tempInfo || !tempInfo.isFile() || tempInfo.isSymbolicLink() || !matchesFileIdentity(tempInfo, expected)) {
      continue;
    }
    try {
      await rm(tempPath, { force: false });
    } catch (error: unknown) {
      if (!isNodeErrorWithCode(error, "ENOENT")) {
        throw error;
      }
    }
    finalInfo = await lstat(finalPath).catch(() => undefined);
    if (!finalInfo || finalInfo.nlink <= 1) {
      break;
    }
  }
  return finalInfo;
}

async function removeFileWithExclusiveRecoveryClaim(
  path: string,
  expected: FileIdentity,
  validateClaim: (claimPath: string) => Promise<boolean>
): Promise<boolean> {
  const claimPath = recoveryClaimPath(path, expected);
  const ownerPath = `${claimPath}.owner`;
  const owner = await acquireRecoveryClaimOwner(ownerPath);
  if (!owner) {
    return false;
  }
  let claimEstablished = false;
  try {
    try {
      await link(path, claimPath);
      claimEstablished = true;
    } catch (error: unknown) {
      if (isNodeErrorWithCode(error, "EEXIST")) {
        claimEstablished = true;
      } else {
        const [claimInfo, current] = await Promise.all([
          lstat(claimPath).catch(() => undefined),
          lstat(path).catch(() => undefined)
        ]);
        if (claimInfo?.isFile() && !claimInfo.isSymbolicLink() && matchesFileIdentity(claimInfo, expected)) {
          claimEstablished = true;
        } else if (
          (isNodeErrorWithCode(error, "ENOENT") || isNodeErrorWithCode(error, "EPERM")) &&
          (!current || !matchesFileIdentity(current, expected))
        ) {
          return false;
        } else {
          throw error;
        }
      }
    }
    const [claimInfo, current] = await Promise.all([
      lstat(claimPath).catch(() => undefined),
      lstat(path).catch(() => undefined)
    ]);
    if (
      !claimInfo?.isFile() ||
      claimInfo.isSymbolicLink() ||
      !matchesFileIdentity(claimInfo, expected) ||
      (current !== undefined && (
        !current.isFile() ||
        current.isSymbolicLink() ||
        !matchesFileIdentity(current, expected) ||
        !matchesFileIdentity(current, fileIdentity(claimInfo))
      ))
    ) {
      return false;
    }
    if (!await validateClaim(claimPath)) {
      return false;
    }
    if (current) {
      const finalCheck = await lstat(path).catch(() => undefined);
      if (!finalCheck || !matchesFileIdentity(finalCheck, fileIdentity(claimInfo))) {
        return false;
      }
      await rm(path, { force: false });
    }
    await recoveryClaimBeforeCleanupTestHook?.({ path, claimPath });
    await rm(claimPath, { force: false });
    claimEstablished = false;
    return true;
  } finally {
    if (claimEstablished) {
      await rm(claimPath, { force: true });
    }
    if (!await removeRecoveryClaimOwnerIfNonceMatches(ownerPath, owner.nonce)) {
      throw new Error(`clean ownership recovery claim owner changed: ${ownerPath}`);
    }
  }
}

async function acquireRecoveryClaimOwner(ownerPath: string): Promise<RecoveryClaimOwner | undefined> {
  const owner: RecoveryClaimOwner = {
    schemaVersion: CLEAN_OWNERSHIP_RECOVERY_OWNER_SCHEMA,
    nonce: randomBytes(16).toString("hex"),
    pid: process.pid,
    createdAt: new Date().toISOString()
  };
  const deadline = Date.now() + LOCK_WAIT_MS;
  while (!await publishExclusiveFile(ownerPath, `${JSON.stringify(owner)}\n`)) {
    if (await reclaimAbandonedRecoveryClaimOwner(ownerPath)) {
      continue;
    }
    if (Date.now() >= deadline) {
      return undefined;
    }
    await delay(10);
  }
  return owner;
}

async function reclaimAbandonedRecoveryClaimOwner(ownerPath: string): Promise<boolean> {
  const ownerInfo = await normalizeExclusivePublication(ownerPath);
  const owner = ownerInfo
    ? await readRecoveryClaimOwnerAtPath(ownerPath, false, ownerInfo)
    : undefined;
  if (!owner || Date.now() - Date.parse(owner.createdAt) <= INITIALIZATION_GRACE_MS || isProcessAlive(owner.pid)) {
    return false;
  }
  const reclaimPath = `${ownerPath}.reclaim.${owner.nonce}`;
  try {
    await link(ownerPath, reclaimPath);
  } catch (error: unknown) {
    if (isNodeErrorWithCode(error, "ENOENT")) {
      return false;
    }
    if (isNodeErrorWithCode(error, "EEXIST")) {
      const [claimed, current] = await Promise.all([
        readRecoveryClaimOwnerAtPath(reclaimPath, false),
        readRecoveryClaimOwnerAtPath(ownerPath, false)
      ]);
      if (!claimed || claimed.nonce !== owner.nonce) {
        throw new Error(`invalid clean ownership recovery owner reclaim artifact: ${reclaimPath}`);
      }
      if (!current) {
        await rm(reclaimPath, { force: false }).catch((removeError: unknown) => {
          if (!isNodeErrorWithCode(removeError, "ENOENT")) {
            throw removeError;
          }
        });
        return true;
      }
      if (current.nonce !== owner.nonce) {
        await rm(reclaimPath, { force: false }).catch((removeError: unknown) => {
          if (!isNodeErrorWithCode(removeError, "ENOENT")) {
            throw removeError;
          }
        });
        return false;
      }
      throw new Error(
        `clean ownership recovery owner reclaim was interrupted and requires manual inspection: ${reclaimPath}`
      );
    }
    throw error;
  }
  try {
    const [claimed, current] = await Promise.all([
      readRecoveryClaimOwnerAtPath(reclaimPath, false),
      readRecoveryClaimOwnerAtPath(ownerPath, false)
    ]);
    if (!claimed || !current || claimed.nonce !== owner.nonce || current.nonce !== owner.nonce) {
      return false;
    }
    await rm(ownerPath, { force: false });
    return true;
  } finally {
    await rm(reclaimPath, { force: true });
  }
}

async function readRecoveryClaimOwner(ownerPath: string): Promise<RecoveryClaimOwner | undefined> {
  const info = await normalizeExclusivePublication(ownerPath);
  if (!info) {
    return undefined;
  }
  return await readRecoveryClaimOwnerAtPath(ownerPath, true, info);
}

async function readRecoveryClaimOwnerAtPath(
  path: string,
  requireExclusive: boolean,
  knownInfo?: Stats
): Promise<RecoveryClaimOwner | undefined> {
  const info = knownInfo ?? await lstat(path).catch(() => undefined);
  if (!info?.isFile() || info.isSymbolicLink() || (requireExclusive && info.nlink > 1)) {
    return undefined;
  }
  try {
    const owner = JSON.parse(await readFile(path, "utf8")) as RecoveryClaimOwner;
    if (
      owner.schemaVersion !== CLEAN_OWNERSHIP_RECOVERY_OWNER_SCHEMA ||
      !/^[a-f0-9]{32}$/u.test(owner.nonce) ||
      !Number.isSafeInteger(owner.pid) ||
      owner.pid <= 0 ||
      Number.isNaN(Date.parse(owner.createdAt))
    ) {
      return undefined;
    }
    return owner;
  } catch {
    return undefined;
  }
}

async function removeRecoveryClaimOwnerIfNonceMatches(ownerPath: string, nonce: string): Promise<boolean> {
  const owner = await readRecoveryClaimOwner(ownerPath);
  if (!owner || owner.nonce !== nonce) {
    return false;
  }
  await rm(ownerPath, { force: false });
  return true;
}

function recoveryClaimPath(path: string, identity: FileIdentity): string {
  const identityToken = sha256(JSON.stringify(identity)).slice(0, 24);
  return `${path}.recovery.${identityToken}.claim`;
}

function fileIdentity(info: Stats): FileIdentity {
  return {
    dev: info.dev,
    ino: info.ino,
    size: info.size,
    mtimeMs: info.mtimeMs,
    birthtimeMs: info.birthtimeMs
  };
}

function matchesFileIdentity(info: Stats, expected: FileIdentity): boolean {
  return info.dev === expected.dev &&
    info.ino === expected.ino &&
    info.size === expected.size &&
    info.mtimeMs === expected.mtimeMs &&
    info.birthtimeMs === expected.birthtimeMs;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    return !isNodeErrorWithCode(error, "ESRCH");
  }
}

function resolveOwnershipKeyRoot(): string {
  const configured = process.env["MARTIN_CLEAN_OWNERSHIP_KEY_DIR"]?.trim();
  return configured ? resolve(configured) : join(homedir(), ".martin", "clean-ownership");
}

function resolveOwnershipKeyPath(runsRoot: string): string {
  return join(resolveOwnershipKeyRoot(), `${sha256(runsRoot).slice(0, 16)}.key`);
}

async function ensureOwnershipKey(runsRoot: string): Promise<string> {
  const keyPath = resolveOwnershipKeyPath(runsRoot);
  const previous = ownershipKeyInitializationTails.get(keyPath) ?? Promise.resolve();
  let release!: () => void;
  const turn = new Promise<void>((resolveTurn) => {
    release = resolveTurn;
  });
  const tail = previous.catch(() => {}).then(() => turn);
  ownershipKeyInitializationTails.set(keyPath, tail);
  await previous.catch(() => {});
  try {
    return await ensureOwnershipKeyExclusive(runsRoot, keyPath);
  } finally {
    release();
    if (ownershipKeyInitializationTails.get(keyPath) === tail) {
      ownershipKeyInitializationTails.delete(keyPath);
    }
  }
}

async function ensureOwnershipKeyExclusive(runsRoot: string, keyPath: string): Promise<string> {
  await assertSafeOwnershipDirectory(dirname(keyPath), false, KEY_DIRECTORY_MODE);
  await cleanupAbandonedRecoveryClaims(keyPath);
  const existing = await readOwnershipKey(runsRoot).catch(() => undefined);
  if (existing) {
    return existing;
  }
  const key = randomBytes(32).toString("hex");
  const keyInfo = await normalizeExclusivePublication(keyPath);
  if (keyInfo) {
    const racedValid = await readOwnershipKey(runsRoot).catch(() => undefined);
    if (racedValid) {
      return racedValid;
    }
    if (!keyInfo.isFile() || keyInfo.isSymbolicLink()) {
      throw new Error("invalid clean ownership key");
    }
    if (keyInfo.nlink > 1) {
      const settled = await waitForOwnershipKey(runsRoot, Date.now() + LOCK_WAIT_MS);
      if (settled) {
        return settled;
      }
      throw new Error("clean ownership key publication or recovery did not settle");
    }
    const identity = fileIdentity(keyInfo);
    if (Date.now() - keyInfo.mtimeMs <= INITIALIZATION_GRACE_MS) {
      throw new Error("invalid clean ownership key may belong to a live initialization and was not replaced");
    }
    const recoveryDeadline = Date.now() + LOCK_WAIT_MS;
    while (!await removeFileWithExclusiveRecoveryClaim(keyPath, identity, async () => true)) {
      const recovered = await readOwnershipKey(runsRoot).catch(() => undefined);
      if (recovered) {
        return recovered;
      }
      const current = await normalizeExclusivePublication(keyPath);
      if (!current) {
        break;
      }
      if (!matchesFileIdentity(current, identity)) {
        const replacedValid = await readOwnershipKey(runsRoot).catch(() => undefined);
        if (replacedValid) {
          return replacedValid;
        }
        throw new Error("clean ownership key changed during stale-key recovery");
      }
      if (Date.now() >= recoveryDeadline) {
        throw new Error("invalid clean ownership key recovery claim did not complete");
      }
      await delay(10);
    }
  }
  if (!await publishExclusiveFile(keyPath, `${key}\n`)) {
    const raced = await waitForOwnershipKey(runsRoot, Date.now() + LOCK_WAIT_MS);
    if (!raced) {
      throw new Error("clean ownership key publication raced with an invalid key");
    }
    return raced;
  }
  const published = await waitForOwnershipKey(runsRoot, Date.now() + LOCK_WAIT_MS);
  if (!published) {
    throw new Error("clean ownership key publication did not settle");
  }
  return published;
}

async function waitForOwnershipKey(runsRoot: string, deadline: number): Promise<string | undefined> {
  while (true) {
    const key = await readOwnershipKey(runsRoot).catch(() => undefined);
    if (key) {
      return key;
    }
    if (Date.now() >= deadline) {
      return undefined;
    }
    await delay(10);
  }
}

async function readOwnershipKey(runsRoot: string): Promise<string> {
  const keyPath = resolveOwnershipKeyPath(runsRoot);
  const keyInfo = await normalizeExclusivePublication(keyPath);
  if (!keyInfo) {
    throw new Error("missing clean ownership key");
  }
  if (!keyInfo.isFile() || keyInfo.isSymbolicLink() || keyInfo.nlink > 1) {
    throw new Error("invalid clean ownership key");
  }
  const key = (await readFile(keyPath, "utf8")).trim();
  if (!/^[a-f0-9]{64}$/u.test(key)) {
    throw new Error("invalid clean ownership key");
  }
  return key;
}

function signOwnership(key: string, value: Omit<CleanOwnershipMarker, "signatureHmacSha256">): string {
  return createHmac("sha256", key).update(JSON.stringify(value)).digest("hex");
}

function safeHexEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left, "hex");
  const rightBuffer = Buffer.from(right, "hex");
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function isSameCanonicalPath(left: string, right: string): boolean {
  return process.platform === "win32"
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;
}

function isNodeErrorWithCode(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === code;
}
