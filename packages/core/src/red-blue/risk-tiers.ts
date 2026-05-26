// ─── Risk Tier Definitions ────────────────────────────────────────────────────
// Governs how aggressively Red phase probes a patch and whether a model call
// is permitted. Budget caps are expressed as fractions of the Blue phase budget.

export type RiskTier = "baseline" | "high_risk" | "release_critical";

export interface RedBudgetPolicy {
  riskTier: RiskTier;
  blueBudgetUsd: number;
  /** Cap on Red phase spend: 30% / 100% / 150% of Blue */
  redBudgetCapUsd: number;
  /** Only release_critical permits a Haiku model call */
  modelCallAllowed: boolean;
}

const BUDGET_MULTIPLIERS: Record<RiskTier, number> = {
  baseline: 0.30,
  high_risk: 1.00,
  release_critical: 1.50
};

/**
 * Returns the Red phase budget policy for a given risk tier and Blue budget.
 */
export function resolveRedBudgetPolicy(
  tier: RiskTier,
  blueBudgetUsd: number
): RedBudgetPolicy {
  return {
    riskTier: tier,
    blueBudgetUsd,
    redBudgetCapUsd: blueBudgetUsd * BUDGET_MULTIPLIERS[tier],
    modelCallAllowed: tier === "release_critical"
  };
}

/**
 * Probe counts per tier.
 * baseline = standard 6-probe sweep
 * high_risk = paranoid 12-probe sweep
 * release_critical = paranoid 12-probe sweep + model
 */
export const PROBE_COUNTS: Record<RiskTier, number> = {
  baseline: 6,
  high_risk: 12,
  release_critical: 12
};

/** The only model ever permitted in the Red phase. */
export const RED_PHASE_MODEL = "claude-haiku-4-5-20251001" as const;

export function resolveRedPhaseModel(model?: string): string {
  return model ?? process.env.MARTIN_RED_PHASE_MODEL ?? RED_PHASE_MODEL;
}
