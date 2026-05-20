import type { LoopRunRecord } from "@martin/core";

import { loadSelectedRun, summarizeRun } from "./cockpit-support.js";

export interface GetRunInput {
  loopId?: string;
  runsDir?: string;
  latest?: boolean;
}

export interface GetRunOutput {
  summary: ReturnType<typeof summarizeRun>;
  task: LoopRunRecord["task"];
  budget: LoopRunRecord["budget"];
  cost: LoopRunRecord["cost"];
  attempts: LoopRunRecord["attempts"];
  createdAt: string;
  updatedAt: string;
}

export async function getRunTool(input: GetRunInput): Promise<GetRunOutput> {
  const loop = await loadSelectedRun(input);
  return {
    summary: summarizeRun(loop),
    task: loop.task,
    budget: loop.budget,
    cost: loop.cost,
    attempts: loop.attempts,
    createdAt: loop.createdAt,
    updatedAt: loop.updatedAt
  };
}
