/// <reference types="node" />
import { mkdir, open, readFile, unlink } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";

import type { LoopRecord, RollbackBoundaryArtifact } from "@martin/contracts";

import { artifactDir, runDir } from "./persistence/index.js";

export interface RunExecutionLease {
  schemaVersion: "martin.execution-lease.v1";
  runId: string;
  token: string;
  owner: string;
  pid: number;
  hostname: string;
  acquiredAt: string;
}

export interface AcquiredRunExecutionLease {
  lease: RunExecutionLease;
  path: string;
  release(): Promise<void>;
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
  return JSON.parse(raw) as RollbackBoundaryArtifact;
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
}): Promise<AcquiredRunExecutionLease> {
  const now = input.now ?? (() => new Date().toISOString());
  const host = input.host ?? hostname();
  const pid = input.pid ?? process.pid;
  const directory = runDir(input.runsRoot, input.runId);
  const path = join(directory, "execution-lease.json");
  await mkdir(directory, { recursive: true });

  const token = `${pid}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const lease: RunExecutionLease = {
    schemaVersion: "martin.execution-lease.v1",
    runId: input.runId,
    token,
    owner: input.owner,
    pid,
    hostname: host,
    acquiredAt: now()
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
      return {
        lease,
        path,
        async release(): Promise<void> {
          try {
            const existing = JSON.parse(await readFile(path, "utf8")) as RunExecutionLease;
            if (existing.token === token) await unlink(path);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          }
        }
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const existing = await readLease(path);
      if (!existing) continue;
      if (existing.hostname !== host) {
        throw new Error(
          `Run ${input.runId} is leased by ${existing.owner} on ${existing.hostname}; refusing cross-host takeover.`
        );
      }
      if (isProcessAlive(existing.pid)) {
        throw new Error(
          `Run ${input.runId} is already executing under ${existing.owner} (pid ${existing.pid}).`
        );
      }
      await unlink(path).catch((unlinkError: NodeJS.ErrnoException) => {
        if (unlinkError.code !== "ENOENT") throw unlinkError;
      });
    }
  }

  throw new Error(`Unable to acquire execution lease for run ${input.runId}.`);
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
