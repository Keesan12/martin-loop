/// <reference types="node" />
import { createHash, randomBytes } from "node:crypto";
import { link, lstat, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";

import type { LoopRecord, RollbackBoundaryArtifact } from "@martin/contracts";

import { artifactDir, resolveReceiptIntegrityRoot, runDir } from "./persistence/index.js";
import { authenticateManagedPathExclusions, RollbackStateUnavailableError } from "./rollback.js";

const locallyOwnedExecutionLeases = new Map<string, string>();

export interface RunExecutionLease {
  schemaVersion: "martin.execution-lease.v2";
  runId: string;
  token: string;
  owner: string;
  pid: number;
  hostname: string;
  acquiredAt: string;
  capabilities: { runControl: boolean };
  processInstanceId: string;
  heartbeatAt: string;
  heartbeatSequence: number;
}

export interface AcquiredRunExecutionLease {
  lease: RunExecutionLease;
  path: string;
  release(): Promise<void>;
}

export interface ActiveRunExecutionLease {
  lease: RunExecutionLease;
  path: string;
}


export interface ResumeVerifierFailure {
  command: string;
  exitCode?: number;
  crashed?: boolean;
  timedOut?: boolean;
  failureExcerpt: string;
  attemptId: string;
  attemptIndex: number;
}

export interface ResumabilityDecision {
  allowed: boolean;
  reason: string;
}

export function evaluateRunResumability(loop: LoopRecord): ResumabilityDecision {
  if (loop.terminationEnvelope) {
    return { allowed: false, reason: "The run already has authoritative terminal evidence." };
  }
  if (!["queued", "running", "verifying"].includes(loop.status)) {
    return { allowed: false, reason: `Run status ${loop.status} is terminal and cannot be continued.` };
  }
  if (!["created", "running", "verifying"].includes(loop.lifecycleState)) {
    return {
      allowed: false,
      reason: `Run lifecycle ${loop.lifecycleState} is terminal and cannot be continued.`
    };
  }
  if (loop.task.taskClass === "irreversible" || loop.task.approvalPolicy?.externalWrites === true) {
    return {
      allowed: false,
      reason: "Automatic execution continuation is disabled for irreversible/external-write tasks."
    };
  }
  if (loop.attempts.length >= loop.budget.maxIterations) {
    return { allowed: false, reason: "The run has no remaining iteration authority." };
  }
  if (loop.cost.actualUsd >= loop.budget.maxUsd) {
    return { allowed: false, reason: "The run has no remaining USD budget authority." };
  }
  if (
    loop.budget.maxTokens !== undefined &&
    loop.cost.tokensIn + loop.cost.tokensOut >= loop.budget.maxTokens
  ) {
    return { allowed: false, reason: "The run has no remaining token budget authority." };
  }

  const started = new Set(
    loop.events
      .filter((event) => event.type === "attempt.started")
      .map((event) => String(event.payload["attemptId"] ?? ""))
      .filter(Boolean)
  );
  for (const event of loop.events) {
    if (event.type === "attempt.completed") {
      const attemptId = String(event.payload["attemptId"] ?? "");
      if (attemptId) started.delete(attemptId);
    }
  }
  if (started.size > 0) {
    return {
      allowed: false,
      reason: "A persisted attempt is still marked active; provider-process ownership is uncertain."
    };
  }

  return { allowed: true, reason: "Persisted run has remaining safe execution authority." };
}

export async function loadResumeCandidateBoundary(
  runsRoot: string,
  loop: LoopRecord
): Promise<RollbackBoundaryArtifact | undefined> {
  const latestAttempt = loop.attempts.at(-1);
  if (latestAttempt?.candidateRetained !== true) return undefined;

  // Recover the first rollback boundary in the current contiguous retained-candidate
  // suffix. Earlier retained candidates that were later discarded must not become
  // authority for a new resume.
  let firstRetainedAttempt = latestAttempt;
  for (let index = loop.attempts.length - 2; index >= 0; index -= 1) {
    const candidate = loop.attempts[index];
    if (candidate?.candidateRetained !== true) break;
    firstRetainedAttempt = candidate;
  }

  const path = join(
    artifactDir(runsRoot, loop.loopId, firstRetainedAttempt.index),
    "rollback-boundary.json"
  );
  const raw = await readFile(path, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") {
      throw new Error(
        `Cannot continue ${loop.loopId}: retained candidate boundary evidence is missing for attempt ${firstRetainedAttempt.index}.`
      );
    }
    throw error;
  });
  const boundary = JSON.parse(raw) as RollbackBoundaryArtifact;
  if (loop.task.repoRoot) {
    authenticateManagedPathExclusions(
      loop.task.repoRoot,
      boundary,
      [runsRoot, resolveReceiptIntegrityRoot()]
    );
  } else if (boundary.managedPathExclusions !== undefined) {
    throw new RollbackStateUnavailableError(
      "Rollback boundary managed path exclusions cannot be authenticated without a repository root."
    );
  }
  return boundary;
}

export async function loadResumeVerifierFailure(
  runsRoot: string,
  loop: LoopRecord
): Promise<ResumeVerifierFailure | undefined> {
  const attempt = loop.attempts.at(-1);
  if (!attempt || attempt.verifierScore === 1) return undefined;
  const path = join(artifactDir(runsRoot, loop.loopId, attempt.index), "verification.json");
  const raw = await readFile(path, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (!raw) return undefined;
  const verification = JSON.parse(raw) as {
    summary?: string;
    warnings?: string[];
    steps?: Array<{
      command?: string;
      launched?: boolean;
      completed?: boolean;
      crashed?: boolean;
      exitCode?: number;
      timedOut?: boolean;
      detail?: string;
    }>;
  };
  const step = verification.steps?.find(
    (candidate) =>
      candidate.launched === true &&
      (candidate.crashed === true ||
        candidate.timedOut === true ||
        (candidate.exitCode !== undefined && candidate.exitCode !== 0))
  );
  const excerpt = (
    step?.detail ??
    [verification.summary, ...(verification.warnings ?? [])].filter(Boolean).join("\n")
  ).trim();
  return {
    command: step?.command ?? loop.task.verificationPlan[0] ?? "unknown",
    ...(!step?.crashed && !step?.timedOut && step?.exitCode !== undefined
      ? { exitCode: step.exitCode }
      : {}),
    ...(step?.crashed ? { crashed: true } : {}),
    ...(step?.timedOut ? { timedOut: true } : {}),
    failureExcerpt: excerpt.slice(-1500),
    attemptId: attempt.attemptId,
    attemptIndex: attempt.index
  };
}

export async function acquireRunExecutionLease(input: {
  runsRoot: string;
  runId: string;
  owner: string;
  now?: () => string;
  host?: string;
  pid?: number;
  runControlCapable?: boolean;
}, hooks: {
  beforeStaleReclaim?: () => Promise<void>;
} = {}): Promise<AcquiredRunExecutionLease> {
  const now = input.now ?? (() => new Date().toISOString());
  const host = input.host ?? hostname();
  const pid = input.pid ?? process.pid;
  const directory = join(input.runsRoot, ".execution-leases");
  const leaseFile = `${createHash("sha256").update(input.runId).digest("hex")}.json`;
  const path = join(directory, leaseFile);
  await mkdir(directory, { recursive: true });

  const token = `${pid}-${randomBytes(16).toString("hex")}`;
  let lease: RunExecutionLease = {
    schemaVersion: "martin.execution-lease.v2",
    runId: input.runId,
    token,
    owner: input.owner,
    pid,
    hostname: host,
    acquiredAt: now(),
    capabilities: { runControl: input.runControlCapable === true },
    processInstanceId: randomBytes(16).toString("hex"),
    heartbeatAt: wallClockIso(),
    heartbeatSequence: 0
  };

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await open(path, "wx", 0o600);
      try {
        await handle.writeFile(`${JSON.stringify(lease, null, 2)}\n`, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      const heartbeatPath = executionLeaseHeartbeatPath(path, lease.processInstanceId);
      await writeLeaseAtomically(heartbeatPath, lease);
      locallyOwnedExecutionLeases.set(path, `${lease.token}:${lease.processInstanceId}`);
      let active = true;
      let heartbeatPromise: Promise<void> | undefined;
      const heartbeat = setInterval(() => {
        if (!active || heartbeatPromise) return;
        const nextLease: RunExecutionLease = {
          ...lease,
          heartbeatAt: wallClockIso(),
          heartbeatSequence: lease.heartbeatSequence + 1
        };
        heartbeatPromise = writeLeaseAtomically(heartbeatPath, nextLease)
          .then(() => { lease = nextLease; })
          .catch(() => undefined)
          .finally(() => { heartbeatPromise = undefined; });
      }, 500);
      heartbeat.unref();
      return {
        lease,
        path,
        async release(): Promise<void> {
          active = false;
          clearInterval(heartbeat);
          await heartbeatPromise;
          if (
            locallyOwnedExecutionLeases.get(path) ===
            `${lease.token}:${lease.processInstanceId}`
          ) {
            locallyOwnedExecutionLeases.delete(path);
          }
          try {
            const existing = JSON.parse(await readFile(path, "utf8")) as RunExecutionLease;
            if (existing.token === token) await unlink(path);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          }
          await unlink(heartbeatPath).catch((error: NodeJS.ErrnoException) => {
            if (error.code !== "ENOENT") throw error;
          });
        }
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const existing = await readLeaseWithHeartbeat(path);
      if (!existing) continue;
      if (existing.hostname !== host) {
        throw new Error(
          `Run ${input.runId} is leased by ${existing.owner} on ${existing.hostname}; refusing cross-host takeover.`
        );
      }
      if (isProcessAlive(existing.pid) && isFreshExecutionLease(existing)) {
        throw new Error(
          `Run ${input.runId} is already executing under ${existing.owner} (pid ${existing.pid}).`
        );
      }
      await hooks.beforeStaleReclaim?.();
      await reclaimStaleExecutionLease(path, existing);
    }
  }

  throw new Error(`Unable to acquire execution lease for run ${input.runId}.`);
}

async function reclaimStaleExecutionLease(
  path: string,
  observed: RunExecutionLease
): Promise<boolean> {
  const claimPath = `${path}.reclaim-${createHash("sha256")
    .update(`${observed.token}:${observed.processInstanceId}`)
    .digest("hex")
    .slice(0, 24)}`;
  try {
    // The deterministic hard-link claim atomically elects one reclaimer for
    // the observed lease inode. A stale observer can never unlink a successor.
    await link(path, claimPath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EEXIST" || code === "ENOENT") return false;
    throw error;
  }

  try {
    const claimedStat = await lstat(claimPath);
    const claimed = await readLease(claimPath);
    const currentStat = await lstat(path).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (
      !claimed ||
      !currentStat ||
      claimed.token !== observed.token ||
      claimed.processInstanceId !== observed.processInstanceId ||
      claimedStat.dev !== currentStat.dev ||
      claimedStat.ino !== currentStat.ino
    ) {
      return false;
    }
    await unlink(path);
    await unlink(executionLeaseHeartbeatPath(path, observed.processInstanceId)).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
      }
    );
    return true;
  } finally {
    await unlink(claimPath).catch(() => undefined);
  }
}

/**
 * Returns the persisted execution lease only when its schema, run identity,
 * supported owner and local process liveness are all authoritative. Control
 * surfaces use this to avoid accepting commands for an abandoned or incapable
 * executor.
 */
export async function readActiveRunExecutionLease(input: {
  runsRoot: string;
  runId: string;
  host?: string;
}): Promise<ActiveRunExecutionLease | undefined> {
  const host = input.host ?? hostname();
  const directory = join(input.runsRoot, ".execution-leases");
  const leaseFile = `${createHash("sha256").update(input.runId).digest("hex")}.json`;
  const path = join(directory, leaseFile);
  const lease = await readLeaseWithHeartbeat(path);
  if (!isAdmissibleActiveLease(lease, input.runId, host)) return undefined;
  // Same-process executors have a stronger identity proof than a sampled
  // heartbeat: the unguessable token/instance pair is held in live memory.
  // A stale lease whose PID was reused cannot satisfy this binding.
  if (
    lease.pid === process.pid &&
    locallyOwnedExecutionLeases.get(path) === `${lease.token}:${lease.processInstanceId}`
  ) {
    return { lease, path };
  }
  // A PID can be reused after the former owner crashes. Require the same
  // unguessable process instance to advance its heartbeat before admitting a
  // mutation; PID liveness alone is never authority.
  await new Promise<void>((resolve) => setTimeout(resolve, 650));
  const confirmed = await readLeaseWithHeartbeat(path);
  if (
    !isAdmissibleActiveLease(confirmed, input.runId, host) ||
    confirmed.token !== lease.token ||
    confirmed.processInstanceId !== lease.processInstanceId ||
    confirmed.heartbeatSequence <= lease.heartbeatSequence
  ) {
    return undefined;
  }
  return { lease: confirmed, path };
}

function isAdmissibleActiveLease(
  lease: RunExecutionLease | undefined,
  runId: string,
  host: string
): lease is RunExecutionLease {
  return Boolean(
    lease &&
    lease.schemaVersion === "martin.execution-lease.v2" &&
    lease.runId === runId &&
    Boolean(lease.token) &&
    ["runMartin", "runMartin:resume"].includes(lease.owner) &&
    lease.capabilities?.runControl === true &&
    lease.hostname === host &&
    isProcessAlive(lease.pid) &&
    isFreshExecutionLease(lease)
  );
}

function isFreshExecutionLease(lease: Pick<RunExecutionLease, "heartbeatAt">): boolean {
  const heartbeat = Date.parse(lease.heartbeatAt);
  const now = wallClockMs();
  return Number.isFinite(heartbeat) && now - heartbeat <= 2_000 && heartbeat <= now + 5_000;
}

function wallClockMs(): number {
  return performance.timeOrigin + performance.now();
}

function wallClockIso(): string {
  return new Date(wallClockMs()).toISOString();
}

async function writeLeaseAtomically(path: string, lease: RunExecutionLease): Promise<void> {
  const temporaryPath = `${path}.heartbeat-${process.pid}-${randomBytes(8).toString("hex")}`;
  const handle = await open(temporaryPath, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(lease, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temporaryPath, path);
  } finally {
    await unlink(temporaryPath).catch(() => undefined);
  }
}

function executionLeaseHeartbeatPath(path: string, processInstanceId: string): string {
  return `${path}.${processInstanceId}.heartbeat`;
}

async function readLeaseWithHeartbeat(path: string): Promise<RunExecutionLease | undefined> {
  const lease = await readLease(path);
  if (!lease || lease.schemaVersion !== "martin.execution-lease.v2" || !lease.processInstanceId) {
    return lease;
  }
  const heartbeat = await readLease(executionLeaseHeartbeatPath(path, lease.processInstanceId));
  if (
    !heartbeat ||
    heartbeat.token !== lease.token ||
    heartbeat.processInstanceId !== lease.processInstanceId
  ) {
    return lease;
  }
  return heartbeat;
}

async function readLease(path: string): Promise<RunExecutionLease | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as RunExecutionLease;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error(`Existing execution lease is unreadable: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return false;
    return true;
  }
}
