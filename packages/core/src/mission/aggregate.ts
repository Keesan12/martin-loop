/**
 * Mission aggregation — C2
 *
 * Computes verified-outcome and cost metrics from a mission's linked runs.
 * Does not hit the filesystem — operates on already-loaded MissionRecord.
 */

import type { MissionCost, MissionRecord, MissionRunLink } from "@martin/contracts";

// ─── Aggregated metrics ───────────────────────────────────────────────────────

export interface MissionMetrics {
  totalActualUsd: number;
  verifiedOutcomeCount: number;
  totalRunCount: number;
  /** USD per verified outcome. Infinity when verifiedOutcomeCount === 0. */
  costPerVerifiedOutcome: number;
  /** Fraction of runs with verified outcomes (0–1). */
  verifiedRate: number;
}

/**
 * Re-derive mission cost metrics from the run links.
 * Use this to rebuild the cost object from ledger-authoritative data
 * rather than trusting the cached mission.json cost field.
 */
export function aggregateMissionMetrics(runLinks: MissionRunLink[]): MissionMetrics {
  let totalActualUsd = 0;
  let verifiedOutcomeCount = 0;

  for (const link of runLinks) {
    totalActualUsd += link.actualUsd ?? 0;
    if (link.verifiedOutcome === true) verifiedOutcomeCount += 1;
  }

  const totalRunCount = runLinks.length;
  const costPerVerifiedOutcome =
    verifiedOutcomeCount === 0 ? Infinity : totalActualUsd / verifiedOutcomeCount;
  const verifiedRate = totalRunCount === 0 ? 0 : verifiedOutcomeCount / totalRunCount;

  return {
    totalActualUsd,
    verifiedOutcomeCount,
    totalRunCount,
    costPerVerifiedOutcome,
    verifiedRate
  };
}

/**
 * Rebuild the MissionCost record from the authoritative run links.
 * Call after loading from ledger to ensure the cached cost field is consistent.
 */
export function rebuildMissionCost(mission: MissionRecord): MissionCost {
  const metrics = aggregateMissionMetrics(mission.runLinks);
  return {
    totalActualUsd: metrics.totalActualUsd,
    verifiedOutcomeCount: metrics.verifiedOutcomeCount,
    totalRunCount: metrics.totalRunCount
  };
}
