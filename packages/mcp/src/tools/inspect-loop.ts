// SPDX-FileCopyrightText: MartinLoop contributors
//
// SPDX-License-Identifier: Apache-2.0

import { buildPortfolioSnapshot, type LoopRecord, type PortfolioSnapshot } from "@martin/contracts";

import { loadLoopRecordsForInspect } from "./run-store.js";
import { buildLoopCollectionSummary, type LoopPreview } from "./tool-support.js";

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
  latestRun?: LoopPreview;
  recentRuns: LoopPreview[];
  statusBreakdown: Record<string, number>;
  lifecycleBreakdown: Record<string, number>;
  inspection: {
    sourceKind: "file" | "runs_root";
  };
  warnings: string[];
}

export async function inspectLoopTool(input: InspectLoopInput): Promise<InspectLoopOutput> {
  const inspection = await loadLoopRecordsForInspect(input);
  const loops = inspection.loops as LoopRecord[];
  const summary = buildLoopCollectionSummary(inspection.loops);

  return {
    source: inspection.source,
    loopCount: loops.length,
    portfolio: buildPortfolioSnapshot(loops),
    ...(summary.latestRun ? { latestRun: summary.latestRun } : {}),
    recentRuns: summary.recentRuns,
    statusBreakdown: summary.statusBreakdown,
    lifecycleBreakdown: summary.lifecycleBreakdown,
    inspection: {
      sourceKind: input.file ? "file" : "runs_root"
    },
    warnings: inspection.warnings
  };
}
