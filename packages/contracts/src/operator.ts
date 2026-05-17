export const MARTIN_ERROR_CATEGORIES = [
  "invalid_input",
  "environment",
  "auth",
  "not_found",
  "store_unreadable",
  "verification_failed",
  "policy_blocked",
  "budget_exit",
  "transient"
] as const;

export type MartinErrorCategory = (typeof MARTIN_ERROR_CATEGORIES)[number];

export type MartinOutputMode = "human" | "json" | "quiet";

export interface MartinRunSelector {
  runsDir?: string;
  file?: string;
  loopId?: string;
  latest?: boolean;
  attemptIndex?: number;
}

export interface MartinRunListFilters {
  runsDir?: string;
  limit?: number;
  status?: string;
  lifecycleState?: string;
  adapterId?: string;
  model?: string;
  updatedAfter?: string;
}
