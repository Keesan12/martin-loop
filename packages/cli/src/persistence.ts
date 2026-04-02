import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import type { LoopRecord } from "@martin/contracts";

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
    writeJsonFile(join(loopRoot, "loop.json"), loop),
    writeEvents(join(loopRoot, "ledger.jsonl"), loop.events),
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
  const body = events.map((e) => JSON.stringify(e)).join("\n");
  await writeFile(path, body.length > 0 ? `${body}\n` : "", "utf8");
}
