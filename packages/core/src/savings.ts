import type { LoopRecord } from "@martin/contracts";
import type { ExitDecision } from "./policy.js";

export interface AvoidedUsdInput {
  lifecycleState: LoopRecord["lifecycleState"];
  actualUsd: number;
  uncontrolledBaselineUsd?: number;
}

export function calculateAvoidedUsd(input: AvoidedUsdInput): number {
  if (input.lifecycleState !== "completed") return 0;
  if (!Number.isFinite(input.actualUsd) || input.actualUsd < 0) return 0;
  if (
    input.uncontrolledBaselineUsd === undefined ||
    !Number.isFinite(input.uncontrolledBaselineUsd) ||
    input.uncontrolledBaselineUsd <= input.actualUsd
  ) {
    return 0;
  }

  return roundUsd(input.uncontrolledBaselineUsd - input.actualUsd);
}

export function calculateLoopAvoidedUsd(input: {
  loop: LoopRecord;
  decision: ExitDecision;
  uncontrolledBaselineUsd?: number;
}): number {
  return calculateAvoidedUsd({
    lifecycleState: input.decision.lifecycleState,
    actualUsd: input.loop.cost.actualUsd,
    uncontrolledBaselineUsd: input.uncontrolledBaselineUsd
  });
}

function roundUsd(value: number): number {
  return Math.round(value * 100) / 100;
}
