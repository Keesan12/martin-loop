import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import {
  createUnavailableControlPlaneRepository,
  type AttemptRow,
  type BudgetMetricRow,
  type ControlPlaneRepository,
  type EventRow,
  type PolicyRow,
  type RunGraph,
  type RunRow,
  type ViolationRow,
  type WorkspaceRow
} from "./control-plane-repository";

type SqlWorkspaceRow = {
  id: string;
  name: string;
  primary_contact: string;
  billing_email: string;
  plan: string;
  monthly_budget_usd: number;
  seats_used: number;
  seats_total: number;
  region: string;
  renewal_date: string;
  operating_cadence: string;
  created_at: string;
  updated_at: string;
};

type SqlPolicyRow = {
  id: string;
  workspace_id: string;
  name: string;
  scope: string;
  owner: string;
  status: PolicyRow["status"];
  monthly_budget_usd: number;
  max_iterations: number;
  fallback_model: string;
  alert_threshold_pct: number;
  auto_stop_after_minutes: number;
  description: string;
  provenance: string;
  created_at: string;
  updated_at: string;
};

type SqlRunRow = {
  run_id: string;
  workspace_id: string;
  project_id: string;
  title: string;
  objective: string;
  repo_root: string | null;
  status: string;
  lifecycle_state: string;
  stop_reason: string | null;
  active_model: string | null;
  adapter_id: string | null;
  provider_id: string | null;
  transport: string | null;
  actual_usd: number;
  estimated_usd: number;
  cost_provenance: RunRow["costProvenance"];
  modeled_avoided_usd: number;
  tokens_in: number;
  tokens_out: number;
  attempts_count: number;
  kept_attempts: number;
  discarded_attempts: number;
  created_at: string;
  updated_at: string;
};

type SqlAttemptRow = {
  run_id: string;
  attempt_index: number;
  adapter_id: string | null;
  provider_id: string | null;
  model: string | null;
  transport: string | null;
  status: string | null;
  summary: string | null;
  failure_class: string | null;
  intervention: string | null;
  verifier_passed: boolean | null;
  verification_summary: string | null;
  started_at: string | null;
  completed_at: string | null;
};

type SqlEventRow = {
  event_id: string;
  run_id: string;
  attempt_index: number | null;
  kind: string;
  lifecycle_state: string | null;
  timestamp: string;
  payload: Record<string, unknown>;
};

type SqlViolationRow = {
  violation_id: string;
  run_id: string;
  attempt_index: number | null;
  surface: string;
  blocked: boolean;
  violation_kind: string;
  detail: string;
  created_at: string;
};

type SqlBudgetMetricRow = {
  metric_id: string;
  run_id: string;
  attempt_index: number;
  actual_usd: number;
  estimated_usd: number;
  provenance: BudgetMetricRow["provenance"];
  patch_cost_usd: number;
  verification_cost_usd: number;
  variance_usd: number;
  tokens_in: number;
  tokens_out: number;
  created_at: string;
};

export function createSupabaseControlPlaneRepository(
  env: Record<string, string | undefined> = process.env
): ControlPlaneRepository {
  const url = env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const serviceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY?.trim();

  if (!url || !serviceRoleKey) {
    return createUnavailableControlPlaneRepository();
  }

  const client = createClient(url, serviceRoleKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false
    }
  });

  return {
    mode: "supabase",

    async listWorkspaces() {
      const { data, error } = await client
        .from("workspaces")
        .select("*")
        .order("updated_at", { ascending: false });

      throwIfError(error, "workspaces");
      return (data ?? []).map((row) => fromWorkspaceRow(row as SqlWorkspaceRow));
    },

    async upsertWorkspace(workspace) {
      const { data, error } = await client
        .from("workspaces")
        .upsert(toWorkspaceRow(workspace))
        .select()
        .single();

      throwIfError(error, "workspaces");
      return fromWorkspaceRow(data as SqlWorkspaceRow);
    },

    async listPolicies(workspaceId) {
      let query = client.from("policies").select("*").order("updated_at", { ascending: false });
      if (workspaceId) {
        query = query.eq("workspace_id", workspaceId);
      }

      const { data, error } = await query;
      throwIfError(error, "policies");
      return (data ?? []).map((row) => fromPolicyRow(row as SqlPolicyRow));
    },

    async replacePolicies(workspaceId, policies) {
      const { error: deleteError } = await client
        .from("policies")
        .delete()
        .eq("workspace_id", workspaceId);
      throwIfError(deleteError, "policies");

      if (policies.length === 0) {
        return [];
      }

      const { data, error } = await client
        .from("policies")
        .insert(policies.map(toPolicyRow))
        .select();

      throwIfError(error, "policies");
      return (data ?? []).map((row) => fromPolicyRow(row as SqlPolicyRow));
    },

    async listRuns(workspaceId) {
      let query = client.from("runs").select("*").order("updated_at", { ascending: false });
      if (workspaceId) {
        query = query.eq("workspace_id", workspaceId);
      }

      const { data, error } = await query;
      throwIfError(error, "runs");
      return (data ?? []).map((row) => fromRunRow(row as SqlRunRow));
    },

    async listAttempts(runIds) {
      return listRunScopedRows<SqlAttemptRow, AttemptRow>(client, "attempts", runIds, fromAttemptRow);
    },

    async listEvents(runIds) {
      return listRunScopedRows<SqlEventRow, EventRow>(client, "events", runIds, fromEventRow);
    },

    async listViolations(runIds) {
      return listRunScopedRows<SqlViolationRow, ViolationRow>(client, "violations", runIds, fromViolationRow);
    },

    async listBudgetMetrics(runIds) {
      return listRunScopedRows<SqlBudgetMetricRow, BudgetMetricRow>(
        client,
        "budget_metrics",
        runIds,
        fromBudgetMetricRow
      );
    },

    async replaceRunGraph(graph) {
      const { error: runError } = await client.from("runs").upsert(toRunRow(graph.run));
      throwIfError(runError, "runs");

      await deleteRunScopedRows(client, "attempts", graph.run.runId);
      await deleteRunScopedRows(client, "events", graph.run.runId);
      await deleteRunScopedRows(client, "violations", graph.run.runId);
      await deleteRunScopedRows(client, "budget_metrics", graph.run.runId);

      if (graph.attempts.length > 0) {
        const { error } = await client.from("attempts").insert(graph.attempts.map(toAttemptRow));
        throwIfError(error, "attempts");
      }

      if (graph.events.length > 0) {
        const { error } = await client.from("events").insert(graph.events.map(toEventRow));
        throwIfError(error, "events");
      }

      if (graph.violations.length > 0) {
        const { error } = await client
          .from("violations")
          .insert(graph.violations.map(toViolationRow));
        throwIfError(error, "violations");
      }

      if (graph.budgetMetrics.length > 0) {
        const { error } = await client
          .from("budget_metrics")
          .insert(graph.budgetMetrics.map(toBudgetMetricRow));
        throwIfError(error, "budget_metrics");
      }
    }
  };
}

async function listRunScopedRows<TSql, TDomain>(
  client: SupabaseClient,
  tableName: "attempts" | "events" | "violations" | "budget_metrics",
  runIds: string[] | undefined,
  mapper: (row: TSql) => TDomain
): Promise<TDomain[]> {
  let query = client.from(tableName).select("*");
  if (runIds && runIds.length > 0) {
    query = query.in("run_id", runIds);
  }

  const { data, error } = await query;
  throwIfError(error, tableName);
  return (data ?? []).map((row) => mapper(row as TSql));
}

async function deleteRunScopedRows(
  client: SupabaseClient,
  tableName: "attempts" | "events" | "violations" | "budget_metrics",
  runId: string
): Promise<void> {
  const { error } = await client.from(tableName).delete().eq("run_id", runId);
  throwIfError(error, tableName);
}

function throwIfError(
  error: { message: string } | null,
  tableName: string
): asserts error is null {
  if (error) {
    throw new Error(`Supabase ${tableName} query failed: ${error.message}`);
  }
}

function fromWorkspaceRow(row: SqlWorkspaceRow): WorkspaceRow {
  return {
    id: row.id,
    name: row.name,
    primaryContact: row.primary_contact,
    billingEmail: row.billing_email,
    plan: row.plan,
    monthlyBudgetUsd: row.monthly_budget_usd,
    seatsUsed: row.seats_used,
    seatsTotal: row.seats_total,
    region: row.region,
    renewalDate: row.renewal_date,
    operatingCadence: row.operating_cadence,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function toWorkspaceRow(row: WorkspaceRow): SqlWorkspaceRow {
  return {
    id: row.id,
    name: row.name,
    primary_contact: row.primaryContact,
    billing_email: row.billingEmail,
    plan: row.plan,
    monthly_budget_usd: row.monthlyBudgetUsd,
    seats_used: row.seatsUsed,
    seats_total: row.seatsTotal,
    region: row.region,
    renewal_date: row.renewalDate,
    operating_cadence: row.operatingCadence,
    created_at: row.createdAt,
    updated_at: row.updatedAt
  };
}

function fromPolicyRow(row: SqlPolicyRow): PolicyRow {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    name: row.name,
    scope: row.scope,
    owner: row.owner,
    status: row.status,
    monthlyBudgetUsd: row.monthly_budget_usd,
    maxIterations: row.max_iterations,
    fallbackModel: row.fallback_model,
    alertThresholdPct: row.alert_threshold_pct,
    autoStopAfterMinutes: row.auto_stop_after_minutes,
    description: row.description,
    provenance: row.provenance,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function toPolicyRow(row: PolicyRow): SqlPolicyRow {
  return {
    id: row.id,
    workspace_id: row.workspaceId,
    name: row.name,
    scope: row.scope,
    owner: row.owner,
    status: row.status,
    monthly_budget_usd: row.monthlyBudgetUsd,
    max_iterations: row.maxIterations,
    fallback_model: row.fallbackModel,
    alert_threshold_pct: row.alertThresholdPct,
    auto_stop_after_minutes: row.autoStopAfterMinutes,
    description: row.description,
    provenance: row.provenance,
    created_at: row.createdAt,
    updated_at: row.updatedAt
  };
}

function fromRunRow(row: SqlRunRow): RunRow {
  return {
    runId: row.run_id,
    workspaceId: row.workspace_id,
    projectId: row.project_id,
    title: row.title,
    objective: row.objective,
    repoRoot: row.repo_root,
    status: row.status,
    lifecycleState: row.lifecycle_state,
    stopReason: row.stop_reason,
    activeModel: row.active_model,
    adapterId: row.adapter_id,
    providerId: row.provider_id,
    transport: row.transport,
    actualUsd: row.actual_usd,
    estimatedUsd: row.estimated_usd,
    costProvenance: row.cost_provenance,
    modeledAvoidedUsd: row.modeled_avoided_usd,
    tokensIn: row.tokens_in,
    tokensOut: row.tokens_out,
    attemptsCount: row.attempts_count,
    keptAttempts: row.kept_attempts,
    discardedAttempts: row.discarded_attempts,
    latestPatchDecision: null,
    latestPatchSummary: null,
    latestPatchReasonCodes: [],
    latestPatchScore: null,
    groundingViolationCount: 0,
    groundingContentOnlyCount: 0,
    blockedSafetyViolationCount: 0,
    lastSafetySurface: null,
    budgetVarianceUsd: 0,
    accountingMode: row.cost_provenance,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function toRunRow(row: RunRow): SqlRunRow {
  return {
    run_id: row.runId,
    workspace_id: row.workspaceId,
    project_id: row.projectId,
    title: row.title,
    objective: row.objective,
    repo_root: row.repoRoot,
    status: row.status,
    lifecycle_state: row.lifecycleState,
    stop_reason: row.stopReason,
    active_model: row.activeModel,
    adapter_id: row.adapterId,
    provider_id: row.providerId,
    transport: row.transport,
    actual_usd: row.actualUsd,
    estimated_usd: row.estimatedUsd,
    cost_provenance: row.costProvenance,
    modeled_avoided_usd: row.modeledAvoidedUsd,
    tokens_in: row.tokensIn,
    tokens_out: row.tokensOut,
    attempts_count: row.attemptsCount,
    kept_attempts: row.keptAttempts,
    discarded_attempts: row.discardedAttempts,
    created_at: row.createdAt,
    updated_at: row.updatedAt
  };
}

function fromAttemptRow(row: SqlAttemptRow): AttemptRow {
  return {
    runId: row.run_id,
    attemptIndex: row.attempt_index,
    adapterId: row.adapter_id,
    providerId: row.provider_id,
    model: row.model,
    transport: row.transport,
    status: row.status,
    summary: row.summary,
    failureClass: row.failure_class,
    intervention: row.intervention,
    verifierPassed: row.verifier_passed,
    verificationSummary: row.verification_summary,
    patchDecision: null,
    patchSummary: null,
    patchReasonCodes: [],
    patchScore: null,
    groundingViolationCount: 0,
    groundingContentOnly: false,
    groundingResolvedFiles: [],
    safetyViolationCount: 0,
    safetySurface: null,
    safetyBlocked: false,
    safetyProfile: null,
    budgetActualUsd: 0,
    budgetEstimatedUsd: 0,
    budgetVarianceUsd: 0,
    budgetProvenance: null,
    startedAt: row.started_at,
    completedAt: row.completed_at
  };
}

function toAttemptRow(row: AttemptRow): SqlAttemptRow {
  return {
    run_id: row.runId,
    attempt_index: row.attemptIndex,
    adapter_id: row.adapterId,
    provider_id: row.providerId,
    model: row.model,
    transport: row.transport,
    status: row.status,
    summary: row.summary,
    failure_class: row.failureClass,
    intervention: row.intervention,
    verifier_passed: row.verifierPassed,
    verification_summary: row.verificationSummary,
    started_at: row.startedAt,
    completed_at: row.completedAt
  };
}

function fromEventRow(row: SqlEventRow): EventRow {
  return {
    eventId: row.event_id,
    runId: row.run_id,
    attemptIndex: row.attempt_index,
    kind: row.kind,
    lifecycleState: row.lifecycle_state,
    timestamp: row.timestamp,
    payload: row.payload
  };
}

function toEventRow(row: EventRow): SqlEventRow {
  return {
    event_id: row.eventId,
    run_id: row.runId,
    attempt_index: row.attemptIndex,
    kind: row.kind,
    lifecycle_state: row.lifecycleState,
    timestamp: row.timestamp,
    payload: row.payload
  };
}

function fromViolationRow(row: SqlViolationRow): ViolationRow {
  return {
    violationId: row.violation_id,
    runId: row.run_id,
    attemptIndex: row.attempt_index,
    surface: row.surface,
    blocked: row.blocked,
    violationKind: row.violation_kind,
    detail: row.detail,
    createdAt: row.created_at
  };
}

function toViolationRow(row: ViolationRow): SqlViolationRow {
  return {
    violation_id: row.violationId,
    run_id: row.runId,
    attempt_index: row.attemptIndex,
    surface: row.surface,
    blocked: row.blocked,
    violation_kind: row.violationKind,
    detail: row.detail,
    created_at: row.createdAt
  };
}

function fromBudgetMetricRow(row: SqlBudgetMetricRow): BudgetMetricRow {
  return {
    metricId: row.metric_id,
    runId: row.run_id,
    attemptIndex: row.attempt_index,
    actualUsd: row.actual_usd,
    estimatedUsd: row.estimated_usd,
    provenance: row.provenance,
    patchCostUsd: row.patch_cost_usd,
    verificationCostUsd: row.verification_cost_usd,
    varianceUsd: row.variance_usd,
    tokensIn: row.tokens_in,
    tokensOut: row.tokens_out,
    createdAt: row.created_at
  };
}

function toBudgetMetricRow(row: BudgetMetricRow): SqlBudgetMetricRow {
  return {
    metric_id: row.metricId,
    run_id: row.runId,
    attempt_index: row.attemptIndex,
    actual_usd: row.actualUsd,
    estimated_usd: row.estimatedUsd,
    provenance: row.provenance,
    patch_cost_usd: row.patchCostUsd,
    verification_cost_usd: row.verificationCostUsd,
    variance_usd: row.varianceUsd,
    tokens_in: row.tokensIn,
    tokens_out: row.tokensOut,
    created_at: row.createdAt
  };
}
