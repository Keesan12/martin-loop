import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { writeReceiptIntegrityMaterial } from "@martin/core";
import type { LoopRecord } from "@martin/contracts";

const RUN_INDEX_FILENAME = "run-index.ndjson";

export type PersistedLoopState = {
  loopId: string;
  workspaceId: string;
  projectId: string;
  status: LoopRecord["status"];
  lifecycleState: LoopRecord["lifecycleState"];
  createdAt: string;
  updatedAt: string;
  task: {
    title: string;
    objective: string;
    repoRoot?: string;
  };
  budget: LoopRecord["budget"];
  cost: LoopRecord["cost"];
  metrics: {
    attemptCount: number;
    eventCount: number;
    failureCount: number;
  };
};

export function resolveRunsRoot(env: NodeJS.ProcessEnv = process.env): string {
  return (env["MARTIN_RUNS_DIR"] as string | undefined)?.trim() ??
    join(homedir(), ".martin", "runs");
}

/**
 * Write all loop artifacts to disk at the end of a run.
 * Uses the Phase 3 flat path: ~/.martin/runs/<loopId>/
 *   - contract.json   (task + budget, immutable)
 *   - state.json      (status, cost, metrics summary)
 *   - ledger.jsonl    (all events, one JSON per line)
 *   - attempts/       (per-attempt JSON files)
 */
export async function persistLoopArtifacts(
  loop: LoopRecord,
  options: { runsRoot?: string } = {}
): Promise<void> {
  const runsRoot = options.runsRoot ?? resolveRunsRoot();
  const loopRoot = join(runsRoot, loop.loopId);
  const attemptsRoot = join(loopRoot, "attempts");

  await mkdir(attemptsRoot, { recursive: true });

  const state = buildLoopState(loop);
  const contract = {
    loopId: loop.loopId,
    workspaceId: loop.workspaceId,
    projectId: loop.projectId,
    task: loop.task,
    budget: loop.budget,
    metadata: loop.metadata,
    createdAt: loop.createdAt
  };

  await Promise.all([
    writeJsonFile(join(loopRoot, "contract.json"), contract),
    writeJsonFile(join(loopRoot, "state.json"), state),
    writeJsonFile(join(loopRoot, "loop-record.json"), loop),
    writeJsonFile(join(loopRoot, "loop.json"), loop),
    writeEvents(join(loopRoot, "events.jsonl"), loop.events),
    ...loop.attempts.map((attempt) =>
      writeJsonFile(
        join(attemptsRoot, `${String(attempt.index).padStart(3, "0")}-${attempt.attemptId}.json`),
        attempt
      )
    )
  ]);

  // Append summary to workspace-level index
  await appendFile(
    join(runsRoot, `${loop.workspaceId}.jsonl`),
    `${JSON.stringify({ loopId: loop.loopId, status: loop.status, cost: loop.cost, updatedAt: loop.updatedAt })}\n`,
    "utf8"
  );

  await appendFile(
    join(runsRoot, RUN_INDEX_FILENAME),
    `${JSON.stringify({
      loopId: loop.loopId,
      workspaceId: loop.workspaceId,
      projectId: loop.projectId,
      status: loop.status,
      lifecycleState: loop.lifecycleState,
      updatedAt: loop.updatedAt
    })}\n`,
    "utf8"
  );

  await writeReceiptIntegrityMaterial({
    runId: loop.loopId,
    runsRoot,
    loopRecord: loop,
    ledgerEntries: loop.events,
    scope:
      loop.receiptScope ??
      {
        ...(loop.task.repoRoot ? { repoRoot: loop.task.repoRoot } : {}),
        ...(loop.task.repoRoot ? { workingDirectory: loop.task.repoRoot } : {}),
        runsRoot
      },
    signedAt: loop.updatedAt
  });
}

function buildLoopState(loop: LoopRecord): PersistedLoopState {
  return {
    loopId: loop.loopId,
    workspaceId: loop.workspaceId,
    projectId: loop.projectId,
    status: loop.status,
    lifecycleState: loop.lifecycleState,
    createdAt: loop.createdAt,
    updatedAt: loop.updatedAt,
    task: {
      title: loop.task.title,
      objective: loop.task.objective,
      ...(loop.task.repoRoot ? { repoRoot: loop.task.repoRoot } : {})
    },
    budget: loop.budget,
    cost: loop.cost,
    metrics: {
      attemptCount: loop.attempts.length,
      eventCount: loop.events.length,
      failureCount: loop.events.filter((e) => e.type === "failure.classified").length
    }
  };
}

async function writeJsonFile(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function writeEvents(path: string, events: LoopRecord["events"]): Promise<void> {
  const existing = await loadExistingEvents(path);
  if (existing.malformed) {
    if (events.length === 0) {
      return;
    }
    const appended = events.map((event) => `${JSON.stringify(event)}\n`).join("");
    await appendFile(path, appended, "utf8");
    return;
  }

  const merged = mergeEvents(existing.events, events);
  const body = merged.map((event) => JSON.stringify(event)).join("\n");
  await writeFile(path, body.length > 0 ? `${body}\n` : "", "utf8");
}

async function loadExistingEvents(path: string): Promise<{
  events: LoopRecord["events"];
  malformed: boolean;
}> {
  try {
    const raw = await readFile(path, "utf8");
    const trimmedLines = raw
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);

    const parsed: LoopRecord["events"] = [];
    for (const line of trimmedLines) {
      try {
        parsed.push(JSON.parse(line) as LoopRecord["events"][number]);
      } catch {
        return { events: [], malformed: true };
      }
    }

    return { events: parsed, malformed: false };
  } catch {
    return { events: [], malformed: false };
  }
}

function mergeEvents(
  existing: LoopRecord["events"],
  incoming: LoopRecord["events"]
): LoopRecord["events"] {
  const seen = new Set<string>();
  const merged: LoopRecord["events"] = [];

  for (const event of [...existing, ...incoming]) {
    const key = event.eventId && event.eventId.trim().length > 0
      ? `eventId:${event.eventId}`
      : `event:${event.type}:${event.timestamp}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    merged.push(event);
  }

  merged.sort(
    (left, right) => safeTimestamp(left.timestamp) - safeTimestamp(right.timestamp)
  );
  return merged;
}

function safeTimestamp(value: string): number {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}
