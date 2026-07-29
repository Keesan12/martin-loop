// SPDX-FileCopyrightText: MartinLoop contributors
//
// SPDX-License-Identifier: Apache-2.0

import { buildLoopCollectionSummary, buildLoopPreview } from "./tool-support.js";
import { listLoopRecords } from "./run-store.js";

export interface MartinListRunsInput {
  runsDir?: string;
  limit?: number;
  status?: string;
  lifecycleState?: string;
  adapterId?: string;
  model?: string;
  updatedAfter?: string;
}

export interface MartinListRunsOutput {
  source: string;
  runsRoot: string;
  filters: {
    limit: number;
    status?: string;
    lifecycleState?: string;
    adapterId?: string;
    model?: string;
    updatedAfter?: string;
  };
  loopCount: number;
  latestRun?: ReturnType<typeof buildLoopPreview>;
  recentRuns: Array<ReturnType<typeof buildLoopPreview>>;
  statusBreakdown: Record<string, number>;
  lifecycleBreakdown: Record<string, number>;
  warnings: string[];
}

export async function martinListRunsTool(
  input: MartinListRunsInput
): Promise<MartinListRunsOutput> {
  const result = await listLoopRecords(input);
  const summary = buildLoopCollectionSummary(result.loops);

  return {
    source: result.source,
    runsRoot: result.runsRoot,
    filters: {
      limit: input.limit ?? 20,
      ...(input.status ? { status: input.status } : {}),
      ...(input.lifecycleState ? { lifecycleState: input.lifecycleState } : {}),
      ...(input.adapterId ? { adapterId: input.adapterId } : {}),
      ...(input.model ? { model: input.model } : {}),
      ...(input.updatedAfter ? { updatedAfter: input.updatedAfter } : {})
    },
    loopCount: result.loops.length,
    ...(summary.latestRun ? { latestRun: summary.latestRun } : {}),
    recentRuns: result.loops.map((loop) => buildLoopPreview(loop)),
    statusBreakdown: summary.statusBreakdown,
    lifecycleBreakdown: summary.lifecycleBreakdown,
    warnings: result.warnings
  };
}
