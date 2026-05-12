import { buildPortfolioSnapshot, type LoopRecord, type PortfolioSnapshot } from "@martin/contracts";

import { loadLoopRecordsForInspect } from "./run-store.js";

export interface InspectLoopInput {
  /** Optional path to a JSON, JSONL, or run-store directory under the Martin runs root. */
  file?: string;
  /** Optional Martin runs directory. Defaults to MARTIN_RUNS_DIR or ~/.martin/runs. */
  runsDir?: string;
}

export interface InspectLoopOutput {
  source: string;
  loopCount: number;
  portfolio: PortfolioSnapshot;
}

export async function inspectLoopTool(input: InspectLoopInput): Promise<InspectLoopOutput> {
  const inspection = await loadLoopRecordsForInspect(input);
  const loops = inspection.loops as LoopRecord[];

  return {
    source: inspection.source,
    loopCount: loops.length,
    portfolio: buildPortfolioSnapshot(loops)
  };
}
