import { type LoopRecord } from "@martin/contracts";
import { evaluateCostGovernor } from "@martin/core";

export interface GetStatusInput {
  /** JSON-serialized LoopRecord. */
  loopJson: string;
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

export function getStatusTool(input: GetStatusInput): GetStatusOutput {
  const loop = JSON.parse(input.loopJson) as LoopRecord;

  const costState = evaluateCostGovernor({
    budget: loop.budget,
    cost: loop.cost,
    attemptsUsed: loop.attempts.length
  });

  return {
    loopId: loop.loopId,
    status: loop.status,
    lifecycleState: loop.lifecycleState,
    attempts: loop.attempts.length,
    costUsd: loop.cost.actualUsd,
    avoidedUsd: loop.cost.avoidedUsd,
    pressure: costState.pressure,
    shouldStop: costState.shouldStop,
    remainingBudgetUsd: costState.remainingBudgetUsd,
    remainingIterations: costState.remainingIterations,
    remainingTokens: costState.remainingTokens
  };
}
