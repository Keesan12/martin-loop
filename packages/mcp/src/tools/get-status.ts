import { evaluateCostGovernor } from "@martin/core";
import type { CostProvenance } from "@martin/contracts";

import { loadLoopRecordForStatus } from "./run-store.js";
import { buildLoopPreview, type LoopPreview } from "./tool-support.js";
import { readRunControlState } from "./run-controls.js";

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
  source: string;
  loopId: string;
  status: string;
  lifecycleState: string;
  attempts: number;
  costUsd: number;
  costProvenance: CostProvenance;
  avoidedUsd: number;
  pressure: string;
  shouldStop: boolean;
  remainingBudgetUsd: number;
  remainingIterations: number;
  remainingTokens: number;
  budget: {
    maxUsd: number;
    softLimitUsd: number;
    maxIterations: number;
    maxTokens: number;
  };
  inspection: {
    loop: LoopPreview;
  };
  live: {
    phase: string;
    pauseState: "active" | "paused" | "cancellation_requested";
    approvalState: "not_required" | "resume_requested";
    commandsRun: number;
    filesTouched: number;
    verifierStep?: string;
  };
}

export async function getStatusTool(input: GetStatusInput): Promise<GetStatusOutput> {
  const resolved = await loadLoopRecordForStatus(input);
  const loop = resolved.loop;
  const control =
    input.loopJson !== undefined
      ? {
          requestedState: "active" as const,
          approvalState: "not_required" as const,
          receipts: []
        }
      : await readRunControlState(input);
  const latestEvent = loop.events?.at(-1);
  const changedFiles = loop.artifacts?.filter((artifact) => artifact.kind === "diff").length ?? 0;

  const costState = evaluateCostGovernor({
    budget: loop.budget,
    cost: {
      actualUsd: loop.cost.actualUsd,
      avoidedUsd: loop.cost.avoidedUsd ?? 0,
      tokensIn: loop.cost.tokensIn,
      tokensOut: loop.cost.tokensOut
    },
    attemptsUsed: loop.attempts.length
  });

  return {
    source: resolved.source,
    loopId: loop.loopId,
    status: loop.status,
    lifecycleState: loop.lifecycleState,
    attempts: loop.attempts.length,
    costUsd: loop.cost.actualUsd,
    costProvenance: loop.cost.provenance ?? "unavailable",
    avoidedUsd: loop.cost.avoidedUsd ?? 0,
    pressure: costState.pressure,
    shouldStop: costState.shouldStop,
    remainingBudgetUsd: costState.remainingBudgetUsd,
    remainingIterations: costState.remainingIterations,
    remainingTokens: costState.remainingTokens,
    budget: {
      maxUsd: loop.budget.maxUsd,
      softLimitUsd: loop.budget.softLimitUsd,
      maxIterations: loop.budget.maxIterations,
      maxTokens: loop.budget.maxTokens
    },
    inspection: {
      loop: buildLoopPreview(loop)
    },
    live: {
      phase: latestEvent?.lifecycleState ?? loop.lifecycleState,
      pauseState: control.requestedState,
      approvalState: control.approvalState,
      commandsRun: loop.attempts.length,
      filesTouched: changedFiles,
      ...(loop.task?.verificationPlan?.[0] ? { verifierStep: loop.task.verificationPlan[0] } : {})
    }
  };
}
