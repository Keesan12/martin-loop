export type SpendProvenance = "actual" | "estimated" | "unavailable";

export interface WorkspaceRow {
  id: string;
  name: string;
  primaryContact: string;
  billingEmail: string;
  plan: string;
  monthlyBudgetUsd: number;
  seatsUsed: number;
  seatsTotal: number;
  region: string;
  renewalDate: string;
  operatingCadence: string;
  createdAt: string;
  updatedAt: string;
}

export interface PolicyRow {
  id: string;
  workspaceId: string;
  name: string;
  scope: string;
  owner: string;
  status: "Active" | "Draft" | "Needs Review";
  monthlyBudgetUsd: number;
  maxIterations: number;
  fallbackModel: string;
  alertThresholdPct: number;
  autoStopAfterMinutes: number;
  description: string;
  provenance: string;
  createdAt: string;
  updatedAt: string;
}

export interface RunRow {
  runId: string;
  workspaceId: string;
  projectId: string;
  title: string;
  objective: string;
  repoRoot: string | null;
  status: string;
  lifecycleState: string;
  stopReason: string | null;
  activeModel: string | null;
  adapterId: string | null;
  providerId: string | null;
  transport: string | null;
  actualUsd: number;
  estimatedUsd: number;
  costProvenance: SpendProvenance;
  modeledAvoidedUsd: number;
  tokensIn: number;
  tokensOut: number;
  attemptsCount: number;
  keptAttempts: number;
  discardedAttempts: number;
  latestPatchDecision: string | null;
  latestPatchSummary: string | null;
  latestPatchReasonCodes: string[];
  latestPatchScore: number | null;
  groundingViolationCount: number;
  groundingContentOnlyCount: number;
  blockedSafetyViolationCount: number;
  lastSafetySurface: string | null;
  budgetVarianceUsd: number;
  accountingMode: SpendProvenance;
  createdAt: string;
  updatedAt: string;
}

export interface AttemptRow {
  runId: string;
  attemptIndex: number;
  adapterId: string | null;
  providerId: string | null;
  model: string | null;
  transport: string | null;
  status: string | null;
  summary: string | null;
  failureClass: string | null;
  intervention: string | null;
  verifierPassed: boolean | null;
  verificationSummary: string | null;
  patchDecision: string | null;
  patchSummary: string | null;
  patchReasonCodes: string[];
  patchScore: number | null;
  groundingViolationCount: number;
  groundingContentOnly: boolean;
  groundingResolvedFiles: string[];
  safetyViolationCount: number;
  safetySurface: string | null;
  safetyBlocked: boolean;
  safetyProfile: string | null;
  budgetActualUsd: number;
  budgetEstimatedUsd: number;
  budgetVarianceUsd: number;
  budgetProvenance: SpendProvenance | null;
  startedAt: string | null;
  completedAt: string | null;
}

export interface EventRow {
  eventId: string;
  runId: string;
  attemptIndex: number | null;
  kind: string;
  lifecycleState: string | null;
  timestamp: string;
  payload: Record<string, unknown>;
}

export interface ViolationRow {
  violationId: string;
  runId: string;
  attemptIndex: number | null;
  surface: string;
  blocked: boolean;
  violationKind: string;
  detail: string;
  createdAt: string;
}

export interface BudgetMetricRow {
  metricId: string;
  runId: string;
  attemptIndex: number;
  actualUsd: number;
  estimatedUsd: number;
  provenance: SpendProvenance;
  patchCostUsd: number;
  verificationCostUsd: number;
  varianceUsd: number;
  tokensIn: number;
  tokensOut: number;
  createdAt: string;
}

export interface RunGraph {
  run: RunRow;
  attempts: AttemptRow[];
  events: EventRow[];
  violations: ViolationRow[];
  budgetMetrics: BudgetMetricRow[];
}

export type RepositoryMode = "supabase" | "memory" | "unavailable";

export interface ControlPlaneRepository {
  readonly mode: RepositoryMode;
  listWorkspaces(): Promise<WorkspaceRow[]>;
  upsertWorkspace(workspace: WorkspaceRow): Promise<WorkspaceRow>;
  listPolicies(workspaceId?: string): Promise<PolicyRow[]>;
  replacePolicies(workspaceId: string, policies: PolicyRow[]): Promise<PolicyRow[]>;
  listRuns(workspaceId?: string): Promise<RunRow[]>;
  listAttempts(runIds?: string[]): Promise<AttemptRow[]>;
  listEvents(runIds?: string[]): Promise<EventRow[]>;
  listViolations(runIds?: string[]): Promise<ViolationRow[]>;
  listBudgetMetrics(runIds?: string[]): Promise<BudgetMetricRow[]>;
  replaceRunGraph(graph: RunGraph): Promise<void>;
}

type RepositoryState = {
  workspaces: Map<string, WorkspaceRow>;
  policies: Map<string, PolicyRow>;
  runs: Map<string, RunRow>;
  attempts: Map<string, AttemptRow>;
  events: Map<string, EventRow>;
  violations: Map<string, ViolationRow>;
  budgetMetrics: Map<string, BudgetMetricRow>;
};

let repositoryOverride: ControlPlaneRepository | null = null;
let cachedRepository: ControlPlaneRepository | null = null;

export function setControlPlaneRepositoryForTests(
  repository: ControlPlaneRepository | null
): void {
  repositoryOverride = repository;
}

export function resetControlPlaneRepository(): void {
  cachedRepository = null;
}

export async function getControlPlaneRepository(): Promise<ControlPlaneRepository> {
  if (repositoryOverride) {
    return repositoryOverride;
  }

  if (cachedRepository) {
    return cachedRepository;
  }

  const { createSupabaseControlPlaneRepository } = await import("./supabase-repository");
  cachedRepository = createSupabaseControlPlaneRepository();
  return cachedRepository;
}

export function createUnavailableControlPlaneRepository(): ControlPlaneRepository {
  return {
    mode: "unavailable",
    async listWorkspaces() {
      return [];
    },
    async upsertWorkspace() {
      throw new Error("Supabase is not configured for workspace writes.");
    },
    async listPolicies() {
      return [];
    },
    async replacePolicies() {
      throw new Error("Supabase is not configured for policy writes.");
    },
    async listRuns() {
      return [];
    },
    async listAttempts() {
      return [];
    },
    async listEvents() {
      return [];
    },
    async listViolations() {
      return [];
    },
    async listBudgetMetrics() {
      return [];
    },
    async replaceRunGraph() {
      throw new Error("Supabase is not configured for run ingestion.");
    }
  };
}

export function createInMemoryControlPlaneRepository(
  seed: Partial<RepositoryState> = {}
): ControlPlaneRepository {
  const state: RepositoryState = {
    workspaces: cloneMap(seed.workspaces),
    policies: cloneMap(seed.policies),
    runs: cloneMap(seed.runs),
    attempts: cloneMap(seed.attempts),
    events: cloneMap(seed.events),
    violations: cloneMap(seed.violations),
    budgetMetrics: cloneMap(seed.budgetMetrics)
  };

  return {
    mode: "memory",

    async listWorkspaces() {
      return sortByUpdatedAt([...state.workspaces.values()]);
    },

    async upsertWorkspace(workspace) {
      state.workspaces.set(workspace.id, workspace);
      return workspace;
    },

    async listPolicies(workspaceId) {
      const policies = [...state.policies.values()];
      return sortByUpdatedAt(
        workspaceId ? policies.filter((policy) => policy.workspaceId === workspaceId) : policies
      );
    },

    async replacePolicies(workspaceId, policies) {
      for (const [id, policy] of state.policies.entries()) {
        if (policy.workspaceId === workspaceId) {
          state.policies.delete(id);
        }
      }

      for (const policy of policies) {
        state.policies.set(policy.id, policy);
      }

      return policies;
    },

    async listRuns(workspaceId) {
      const runs = [...state.runs.values()];
      return sortByUpdatedAt(
        workspaceId ? runs.filter((run) => run.workspaceId === workspaceId) : runs
      );
    },

    async listAttempts(runIds) {
      return filterRows([...state.attempts.values()], runIds);
    },

    async listEvents(runIds) {
      return filterRows([...state.events.values()], runIds);
    },

    async listViolations(runIds) {
      return filterRows([...state.violations.values()], runIds);
    },

    async listBudgetMetrics(runIds) {
      return filterRows([...state.budgetMetrics.values()], runIds);
    },

    async replaceRunGraph(graph) {
      state.runs.set(graph.run.runId, graph.run);
      replaceRunScopedRows(state.attempts, graph.run.runId, graph.attempts, (row) =>
        makeAttemptKey(row.runId, row.attemptIndex)
      );
      replaceRunScopedRows(state.events, graph.run.runId, graph.events, (row) => row.eventId);
      replaceRunScopedRows(state.violations, graph.run.runId, graph.violations, (row) => row.violationId);
      replaceRunScopedRows(state.budgetMetrics, graph.run.runId, graph.budgetMetrics, (row) => row.metricId);
    }
  };
}

function cloneMap<T>(map: Map<string, T> | undefined): Map<string, T> {
  return new Map(map ? [...map.entries()] : []);
}

function replaceRunScopedRows<T extends { runId: string }>(
  map: Map<string, T>,
  runId: string,
  rows: T[],
  keyFactory: (row: T) => string
): void {
  for (const [key, row] of map.entries()) {
    if (row.runId === runId) {
      map.delete(key);
    }
  }

  for (const row of rows) {
    map.set(keyFactory(row), row);
  }
}

function sortByUpdatedAt<T extends { updatedAt: string }>(rows: T[]): T[] {
  return rows.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

function filterRows<T extends { runId: string }>(rows: T[], runIds?: string[]): T[] {
  if (!runIds || runIds.length === 0) {
    return rows;
  }

  const allow = new Set(runIds);
  return rows.filter((row) => allow.has(row.runId));
}

export function makeAttemptKey(runId: string, attemptIndex: number): string {
  return `${runId}:${String(attemptIndex)}`;
}
