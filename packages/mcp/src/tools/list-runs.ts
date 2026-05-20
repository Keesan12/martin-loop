import { listRunSummaries, type RunSummary } from "./cockpit-support.js";

export interface ListRunsInput {
  runsDir?: string;
  limit?: number;
}

export interface ListRunsOutput {
  runs: RunSummary[];
}

export async function listRunsTool(input: ListRunsInput): Promise<ListRunsOutput> {
  return {
    runs: await listRunSummaries(input)
  };
}
