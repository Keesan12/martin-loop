import { evaluateCostGovernor } from "@martin/core";

import { loadLoopRecordForStatus } from "./run-store.js";

export interface GetStatusInput {
  /** JSON-serialized LoopRecord. */
  loopJson?: string;
  /** Optional path to a JSON, JSONL, or run-store directory under the Martin runs root. */
  file?: string;
  /** Optional loop identifier under the Martin runs root. */
  loopId?: string;
  /** Optional Martin runs directory. Defaults to MARTIN_RUNS_DIR or ~/.martin/runs. */
  runsDir?: string;
  /** Load the newest loop record from the runs directory. */
  latest?: boolean;
}

export interface GetStatusOutput {
  loopId: string;
  status: string;
  lifecycleState: string;
  attempts: number;
  costUsd: number;
  avoidedUsd: number;
  pressure: string;
  shouldStop: boolean;
  remainingBudgetUsd: number;
  remainingIterations: number;
  remainingTokens: number;
}

export async function getStatusTool(input: GetStatusInput): Promise<GetStatusOutput> {
  const resolved = await loadLoopRecordForStatus(input);
  const loop = resolved.loop;

  const costState = evaluateCostGovernor({
    budget: loop.budget,
    cost: {
      actualUsd: loop.cost.actualUsd,
      avoidedUsd: loop.cost.avoidedUsd ?? 0,
      tokensIn: loop.cost.tokensIn,
      tokensOut: loop.cost.tokensOut,
      thinkingTokensOut: 0,
      childCostUsd: 0
    },
    attemptsUsed: loop.attempts.length
  });

  return {
    loopId: loop.loopId,
    status: loop.status,
    lifecycleState: loop.lifecycleState,
    attempts: loop.attempts.length,
    costUsd: loop.cost.actualUsd,
    avoidedUsd: loop.cost.avoidedUsd ?? 0,
    pressure: costState.pressure,
    shouldStop: costState.shouldStop,
    remainingBudgetUsd: costState.remainingBudgetUsd,
    remainingIterations: costState.remainingIterations,
    remainingTokens: costState.remainingTokens
  };
}
