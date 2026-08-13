/**
 * Mission Governance contracts — C2
 *
 * A MissionRecord governs one software mission: intent → budget → runs →
 * verification → decision → receipt. It never replaces LoopRecord; it
 * aggregates above it.
 *
 * Invariants:
 *   - One accountable human owner per mission.
 *   - State transitions are append-only in the ledger.
 *   - Ledger is the authority; mission.json is a rebuildable cache.
 *   - A mission cannot become "verified" without verified run evidence.
 *   - A mission cannot become "shipped" without an explicit ship decision.
 *   - Unknown schema versions fail closed.
 *   - Budgets cannot be raised silently.
 */

export const MISSION_SCHEMA_VERSION = "martin.mission.v1" as const;

// ─── Status and transitions ───────────────────────────────────────────────────

export const MISSION_STATUSES = [
  "planned",
  "running",
  "blocked",
  "verified",
  "shipped",
  "rolled_back",
  "killed"
] as const;

export type MissionStatus = (typeof MISSION_STATUSES)[number];

export const ALLOWED_MISSION_TRANSITIONS: Record<MissionStatus, readonly MissionStatus[]> = {
  planned: ["running", "killed"],
  running: ["blocked", "verified", "rolled_back", "killed"],
  blocked: ["running", "rolled_back", "killed"],
  verified: ["shipped", "running", "rolled_back", "killed"],
  shipped: [],
  rolled_back: ["running", "killed"],
  killed: []
};

export type MissionDecision = "ship" | "retry" | "rollback" | "kill";

// ─── Budget and cost ──────────────────────────────────────────────────────────

export interface MissionBudget {
  maxUsd: number;
  maxTokens: number;
  maxRuns: number;
  maxConcurrentRuns: number;
}

export interface MissionCost {
  /** Sum of actualUsd across all linked runs. */
  totalActualUsd: number;
  /** Number of linked runs with status "completed" (verified outcome). */
  verifiedOutcomeCount: number;
  /** Number of linked runs regardless of outcome. */
  totalRunCount: number;
}

// ─── Run linkage ──────────────────────────────────────────────────────────────

export type MissionRunRole = "primary" | "experiment" | "validation";

export interface MissionRunLink {
  loopId: string;
  role: MissionRunRole;
  attachedAt: string;
  /** Set to true when the linked run completed with verification passed. */
  verifiedOutcome?: boolean;
  /** Actual cost of this run in USD. */
  actualUsd?: number;
}

// ─── Approvals and outcome ────────────────────────────────────────────────────

export interface MissionApproval {
  approvalId: string;
  kind: "ship" | "budget_increase" | "scope_change";
  decision: "approved" | "denied";
  approvedBy: string;
  approvedAt: string;
  note?: string;
}

export interface MissionOutcome {
  decision: MissionDecision;
  decidedAt: string;
  decidedBy: string;
  note?: string;
}

// ─── Events (ledger entries) ──────────────────────────────────────────────────

export type MissionEventKind =
  | "mission.created"
  | "mission.status_changed"
  | "mission.run_attached"
  | "mission.run_verified"
  | "mission.approved"
  | "mission.closed"
  | "mission.collision_blocked";

export interface MissionEvent {
  eventId: string;
  kind: MissionEventKind;
  missionId: string;
  timestamp: string;
  payload: Record<string, unknown>;
}

// ─── Core record ─────────────────────────────────────────────────────────────

export interface MissionRecord {
  schemaVersion: typeof MISSION_SCHEMA_VERSION;
  missionId: string;
  /** Monotonically increasing write counter. Used for CAS enforcement. */
  revision: number;
  title: string;
  objective: string;
  ownerId: string;
  workspaceId: string;
  projectId: string;
  status: MissionStatus;
  budget: MissionBudget;
  cost: MissionCost;
  runLinks: MissionRunLink[];
  approvals: MissionApproval[];
  outcome?: MissionOutcome;
  acceptanceCriteria: string[];
  createdAt: string;
  updatedAt: string;
}

// ─── Draft ────────────────────────────────────────────────────────────────────

export interface MissionDraft {
  missionId?: string;
  title: string;
  objective: string;
  ownerId: string;
  workspaceId: string;
  projectId: string;
  budget: MissionBudget;
  acceptanceCriteria?: string[];
}

// ─── Factory ──────────────────────────────────────────────────────────────────

export function createMissionRecord(
  draft: MissionDraft,
  options: { now?: () => string; idFactory?: (prefix: string) => string } = {}
): MissionRecord {
  const now = options.now ?? (() => new Date().toISOString());
  const makeId = options.idFactory ?? ((prefix: string) => `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`);
  const ts = now();
  return {
    schemaVersion: MISSION_SCHEMA_VERSION,
    missionId: draft.missionId ?? makeId("mission"),
    revision: 0,
    title: draft.title,
    objective: draft.objective,
    ownerId: draft.ownerId,
    workspaceId: draft.workspaceId,
    projectId: draft.projectId,
    status: "planned",
    budget: { ...draft.budget },
    cost: { totalActualUsd: 0, verifiedOutcomeCount: 0, totalRunCount: 0 },
    runLinks: [],
    approvals: [],
    acceptanceCriteria: draft.acceptanceCriteria ?? [],
    createdAt: ts,
    updatedAt: ts
  };
}

// ─── Transition guard ─────────────────────────────────────────────────────────

export function isMissionTransitionAllowed(
  from: MissionStatus,
  to: MissionStatus
): boolean {
  return (ALLOWED_MISSION_TRANSITIONS[from] as readonly string[]).includes(to);
}
