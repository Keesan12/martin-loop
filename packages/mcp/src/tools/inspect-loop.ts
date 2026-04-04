import { readFile } from "node:fs/promises";

import { buildPortfolioSnapshot, type LoopRecord, type PortfolioSnapshot } from "@martin/contracts";

export interface InspectLoopInput {
  /** Absolute or relative path to a JSON file containing a LoopRecord or LoopRecord[]. */
  file: string;
}

export interface InspectLoopOutput {
  source: string;
  loopCount: number;
  portfolio: PortfolioSnapshot;
}

export async function inspectLoopTool(input: InspectLoopInput): Promise<InspectLoopOutput> {
  const raw = await readFile(input.file, "utf8");
  const parsed: unknown = JSON.parse(raw);
  const loops: LoopRecord[] = Array.isArray(parsed)
    ? (parsed as LoopRecord[])
    : [parsed as LoopRecord];

  return {
    source: input.file,
    loopCount: loops.length,
    portfolio: buildPortfolioSnapshot(loops)
  };
}
