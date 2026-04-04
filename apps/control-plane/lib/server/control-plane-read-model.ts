import type { ExceptionRow } from "../../components/exception-panel";
import type { OverviewKpiItem } from "../../components/overview-kpi-band";
import type { TrendPoint } from "../../components/primary-trend-panel";
import type { TrustStripItem } from "../../components/trust-strip";
import type { LabeledDetail } from "../../components/dashboard-primitives";
import {
  type AttemptRow,
  getControlPlaneRepository,
  type BudgetMetricRow,
  type ControlPlaneRepository,
  type EventRow,
  type PolicyRow,
  type RunRow,
  type ViolationRow,
  type WorkspaceRow
} from "./control-plane-repository";

export interface ExecutiveContextModel {
  workspaceLabel: string;
  reportingWindow: string;
  policyProfile: string;
  labels: LabeledDetail[];
}

export interface OverviewViewModel {
  workspace: WorkspaceRow | null;
  executiveContext: ExecutiveContextModel;
  kpiBand: OverviewKpiItem[];
  trustStrip: TrustStripItem[];
  primaryTrend: {
    points: TrendPoint[];
    labels: LabeledDetail[];
  };
  exceptions: ExceptionRow[];
}

export interface OperationsViewModel {
  workspace: WorkspaceRow | null;
  executiveContext: ExecutiveContextModel;
  kpiBand: OverviewKpiItem[];
  trustStrip: TrustStripItem[];
  focusAreas: Array<{
    title: string;
    summary: string;
    owner: string;
    status: string;
    labels: LabeledDetail[];
  }>;
  exceptions: ExceptionRow[];
}

export interface GovernanceViewModel {
  workspace: WorkspaceRow | null;
  executiveContext: ExecutiveContextModel;
  trustStrip: TrustStripItem[];
  policyRows: Array<{
    id: string;
    title: string;
    value: string;
    status: string;
    labels: LabeledDetail[];
  }>;
  approvals: Array<{
    id: string;
    title: string;
    summary: string;
    owner: string;
    status: string;
    labels: LabeledDetail[];
  }>;
}

export interface BillingViewModel {
  workspace: WorkspaceRow | null;
  account: {
    planName: string;
    monthlyCommitUsd: number;
    forecastSpendUsd: number;
    realizedSavingsUsd: number;
    paymentStatus: string;
    seatUtilizationPct: number;
    invoices: Array<{ invoiceId: string; month: string; amountUsd: number; status: "Paid" | "Due" | "Draft" }>;
  } | null;
  seatMix: Array<{ label: string; count: number }>;
}

export interface SettingsViewModel {
  workspace: WorkspaceRow | null;
  roles: Array<{ label: string; count: number }>;
}

export interface RunPortfolioItem extends RunRow {
  attempts: AttemptRow[];
  violations: ViolationRow[];
  budgetMetrics: BudgetMetricRow[];
}

interface DashboardDataset {
  workspace: WorkspaceRow | null;
  workspaceId: string | null;
  workspaces: WorkspaceRow[];
  policies: PolicyRow[];
  runs: RunRow[];
  attempts: AttemptRow[];
  events: EventRow[];
  violations: ViolationRow[];
  budgetMetrics: BudgetMetricRow[];
}

export async function buildExecutiveOverviewViewModel(
  repository?: ControlPlaneRepository
): Promise<OverviewViewModel> {
  const dataset = await loadDashboardDataset(repository);
  const runs = buildRunPortfolio(dataset);
  const summary = summarizeRuns(runs, dataset.budgetMetrics);

  return {
    workspace: dataset.workspace,
    executiveContext: buildExecutiveContext(dataset, runs),
    kpiBand: [
      {
        label: "Actual AI Spend",
        value: formatUsd(summary.totalActualUsd),
        delta: `${String(summary.runCount)} run${summary.runCount === 1 ? "" : "s"} ingested`,
        tone: "neutral",
        labels: actualLabels("Ledger settlements", summary.lastUpdated)
      },
      {
        label: "Month-End Forecast",
        value: formatUsd(summary.forecastUsd),
        delta: "Estimated from current burn rate",
        tone: summary.activeRuns > 0 ? "warning" : "neutral",
        labels: estimatedLabels("Budget settlements", summary.lastUpdated)
      },
      {
        label: "Modeled Avoided Spend",
        value: formatUsd(summary.totalModeledAvoidedUsd),
        delta: "Modeled vs uncapped attempt path",
        tone: "positive",
        labels: modeledLabels("Run-level modeled avoidance", summary.lastUpdated)
      },
      {
        label: "Verified Solve Rate",
        value: `${String(summary.solveRatePct)}%`,
        delta: `${String(summary.completedRuns)} completed / ${String(summary.runCount)} total`,
        tone: summary.solveRatePct >= 50 ? "positive" : "warning",
        labels: actualLabels("run.exited lifecycle", summary.lastUpdated)
      }
    ],
    trustStrip: buildTrustStrip(dataset, runs, summary.lastUpdated),
    primaryTrend: {
      points: buildDailyTrend(runs),
      labels: [
        { label: "Actual", value: "Ledger settlements" },
        { label: "Estimated", value: "Forecast from current burn" },
        { label: "Modeled", value: "Avoided spend estimate" },
        { label: "Budget", value: "Workspace commit reference" }
      ]
    },
    exceptions: buildExceptions(dataset, runs)
  };
}

export async function buildEconomicsViewModel(
  repository?: ControlPlaneRepository
): Promise<OverviewViewModel & { methodologyNotes: string[] }> {
  const overview = await buildExecutiveOverviewViewModel(repository);

  return {
    ...overview,
    executiveContext: {
      ...overview.executiveContext,
      reportingWindow: "Economics rollup, live read model"
    },
    methodologyNotes: [
      "Actual spend comes from budget.settled ledger events ingested into Supabase.",
      "Forecast spend is estimated from the observed average settled attempt cost on active runs.",
      "Modeled avoided spend is derived from unused attempt budget multiplied by observed average attempt cost."
    ]
  };
}

export async function buildOperationsViewModel(
  repository?: ControlPlaneRepository
): Promise<OperationsViewModel> {
  const overview = await buildExecutiveOverviewViewModel(repository);
  const dataset = await loadDashboardDataset(repository);
  const runs = buildRunPortfolio(dataset);

  return {
    workspace: overview.workspace,
    executiveContext: {
      ...overview.executiveContext,
      reportingWindow: "Operational pulse, live run portfolio"
    },
    kpiBand: overview.kpiBand,
    trustStrip: overview.trustStrip,
    exceptions: overview.exceptions,
    focusAreas: buildFocusAreas(runs)
  };
}

export async function buildGovernanceViewModel(
  repository?: ControlPlaneRepository
): Promise<GovernanceViewModel> {
  const dataset = await loadDashboardDataset(repository);
  const runs = buildRunPortfolio(dataset);
  const summary = summarizeRuns(runs, dataset.budgetMetrics);

  return {
    workspace: dataset.workspace,
    executiveContext: buildExecutiveContext(dataset, runs),
    trustStrip: buildTrustStrip(dataset, runs, summary.lastUpdated),
    policyRows:
      dataset.policies.length > 0
        ? dataset.policies.map((policy) => ({
            id: policy.id,
            title: policy.name,
            value: `${policy.scope} · ${policy.fallbackModel}`,
            status: policy.status,
            labels: [
              { label: "Policy provenance", value: policy.provenance },
              { label: "Estimated", value: `${String(policy.alertThresholdPct)}% alert` },
              { label: "Actual", value: `${String(policy.maxIterations)} max iterations` }
            ]
          }))
        : [
            {
              id: "no-policies",
              title: "No policies configured",
              value: "Add a workspace policy record in Supabase to populate this panel.",
              status: "Needs setup",
              labels: [
                { label: "Actual", value: "0 policy rows" },
                { label: "Source", value: "Supabase policies table" }
              ]
            }
          ],
    approvals: buildApprovalQueue(runs)
  };
}

export async function buildBillingViewModel(
  repository?: ControlPlaneRepository
): Promise<BillingViewModel> {
  const dataset = await loadDashboardDataset(repository);
  const runs = buildRunPortfolio(dataset);
  const summary = summarizeRuns(runs, dataset.budgetMetrics);

  if (!dataset.workspace) {
    return {
      workspace: null,
      account: null,
      seatMix: []
    };
  }

  const seatUtilizationPct =
    dataset.workspace.seatsTotal === 0
      ? 0
      : Math.round((dataset.workspace.seatsUsed / dataset.workspace.seatsTotal) * 100);

  return {
    workspace: dataset.workspace,
    account: {
      planName: dataset.workspace.plan,
      monthlyCommitUsd: dataset.workspace.monthlyBudgetUsd,
      forecastSpendUsd: summary.forecastUsd,
      realizedSavingsUsd: summary.totalModeledAvoidedUsd,
      paymentStatus: summary.totalActualUsd > dataset.workspace.monthlyBudgetUsd ? "At risk" : "Healthy",
      seatUtilizationPct,
      invoices: []
    },
    seatMix: [
      { label: "Active seats", count: dataset.workspace.seatsUsed },
      { label: "Available seats", count: Math.max(dataset.workspace.seatsTotal - dataset.workspace.seatsUsed, 0) }
    ]
  };
}

export async function buildSettingsViewModel(
  repository?: ControlPlaneRepository
): Promise<SettingsViewModel> {
  const dataset = await loadDashboardDataset(repository);

  if (!dataset.workspace) {
    return {
      workspace: null,
      roles: []
    };
  }

  return {
    workspace: dataset.workspace,
    roles: [
      { label: "Configured seats", count: dataset.workspace.seatsTotal },
      { label: "Used seats", count: dataset.workspace.seatsUsed },
      { label: "Policies", count: dataset.policies.length }
    ]
  };
}

export async function buildRunPortfolioViewModel(
  repository?: ControlPlaneRepository
): Promise<{ workspace: WorkspaceRow | null; runs: RunPortfolioItem[] }> {
  const dataset = await loadDashboardDataset(repository);

  return {
    workspace: dataset.workspace,
    runs: buildRunPortfolio(dataset)
  };
}

async function loadDashboardDataset(
  repository?: ControlPlaneRepository
): Promise<DashboardDataset> {
  const repo = repository ?? (await getControlPlaneRepository());
  const workspaces = await repo.listWorkspaces();
  const runs = await repo.listRuns();
  const workspaceId = workspaces[0]?.id ?? runs[0]?.workspaceId ?? null;
  const filteredRuns = workspaceId ? runs.filter((run) => run.workspaceId === workspaceId) : runs;
  const runIds = filteredRuns.map((run) => run.runId);
  const [policies, attempts, events, violations, budgetMetrics] = await Promise.all([
    repo.listPolicies(workspaceId ?? undefined),
    repo.listAttempts(runIds),
    repo.listEvents(runIds),
    repo.listViolations(runIds),
    repo.listBudgetMetrics(runIds)
  ]);

  return {
    workspace: workspaceId ? workspaces.find((workspace) => workspace.id === workspaceId) ?? null : null,
    workspaceId,
    workspaces,
    policies,
    runs: filteredRuns,
    attempts,
    events,
    violations,
    budgetMetrics
  };
}

function buildExecutiveContext(
  dataset: DashboardDataset,
  runs: RunPortfolioItem[]
): ExecutiveContextModel {
  const lastUpdated = runs[0]?.updatedAt ?? "No runs yet";
  const policyProfile =
    dataset.policies[0]?.name
    ?? (runs.length > 0 ? "Live runtime defaults" : "No policy rows yet");
  const accountingMode = selectAccountingMode(runs);

  return {
    workspaceLabel: dataset.workspace?.name ?? dataset.workspaceId ?? "No workspace configured",
    reportingWindow: runs.length > 0 ? `Live run portfolio · updated ${lastUpdated}` : "No runs yet",
    policyProfile,
    labels: [
      { label: "Source", value: "Supabase read model" },
      { label: "Freshness", value: runs.length > 0 ? lastUpdated : "No runs yet" },
      { label: "Methodology available", value: "Yes" },
      { label: "Policy provenance", value: dataset.policies.length > 0 ? "Configured" : "Not configured" },
      { label: "Accounting mode", value: accountingMode }
    ]
  };
}

function buildTrustStrip(
  dataset: DashboardDataset,
  runs: RunPortfolioItem[],
  lastUpdated: string
): TrustStripItem[] {
  const groundingFlags = runs.reduce((total, run) => total + run.groundingViolationCount, 0);
  const patchDiscards = runs.reduce((total, run) => total + run.discardedAttempts, 0);

  return [
    {
      label: "Runs ingested",
      value: String(runs.length),
      labels: actualLabels("runs table", lastUpdated)
    },
    {
      label: "Safety blocks",
      value: String(dataset.violations.filter((violation) => violation.blocked).length),
      labels: actualLabels("violations table", lastUpdated)
    },
    {
      label: "Budget settlements",
      value: String(dataset.budgetMetrics.length),
      labels: actualLabels("budget_metrics table", lastUpdated)
    },
    {
      label: "Policies configured",
      value: String(dataset.policies.length),
      labels: actualLabels("policies table", lastUpdated)
    },
    {
      label: "Grounding flags",
      value: String(groundingFlags),
      labels: actualLabels("grounding artifacts", lastUpdated)
    },
    {
      label: "Patch discards",
      value: String(patchDiscards),
      labels: actualLabels("patch-decision artifacts", lastUpdated)
    }
  ];
}

function buildDailyTrend(runs: RunRow[]): TrendPoint[] {
  const dayMap = new Map<
    string,
    { actualUsd: number; modeledAvoidedUsd: number; budgetUsd: number }
  >();

  for (const run of runs) {
    const key = run.updatedAt.slice(0, 10);
    const current = dayMap.get(key) ?? {
      actualUsd: 0,
      modeledAvoidedUsd: 0,
      budgetUsd: 0
    };
    current.actualUsd += run.actualUsd;
    current.modeledAvoidedUsd += run.modeledAvoidedUsd;
    dayMap.set(key, current);
  }

  return [...dayMap.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .slice(-7)
    .map(([label, point]) => ({
      label,
      actualUsd: roundUsd(point.actualUsd),
      forecastUsd: roundUsd(point.actualUsd),
      modeledAvoidedUsd: roundUsd(point.modeledAvoidedUsd),
      budgetUsd: roundUsd(point.budgetUsd)
    }));
}

function buildExceptions(dataset: DashboardDataset, runs: RunPortfolioItem[]): ExceptionRow[] {
  if (runs.length === 0) {
    return [
      {
        id: "empty-runs",
        title: "No runs yet",
        summary: "The control plane is live, but no persisted runs have been ingested yet.",
        severity: "Low",
        owner: "Operator",
        dueBy: "Await first run",
        labels: [
          { label: "Actual", value: "0 runs" },
          { label: "Source", value: "Supabase runs table" }
        ]
      }
    ];
  }

  const rows: ExceptionRow[] = [];

  for (const violation of dataset.violations.slice(0, 3)) {
    const run = runs.find((candidate) => candidate.runId === violation.runId);
    rows.push({
      id: violation.violationId,
      title: `${capitalize(violation.surface)} violation`,
      summary: violation.detail,
      severity: violation.blocked ? "High" : "Medium",
      owner: "Safety leash",
      dueBy: violation.createdAt,
      labels: [
        { label: "Actual", value: violation.violationKind },
        { label: "Source", value: "violations table" },
        { label: "Leash surface", value: violation.surface },
        { label: "Patch decision", value: run?.latestPatchDecision ?? "Unrecorded" }
      ]
    });
  }

  const escalations = runs
    .filter((run) => run.lifecycleState === "human_escalation")
    .slice(0, 2);

  for (const run of escalations) {
    rows.push({
      id: `${run.runId}:escalation`,
      title: run.title,
      summary: run.stopReason ?? "Human escalation required.",
      severity: "High",
      owner: run.projectId,
      dueBy: run.updatedAt,
      labels: [
        { label: "Actual", value: "human_escalation" },
        { label: "Source", value: "runs table" },
        { label: "Stop reason", value: run.stopReason ?? run.lifecycleState },
        { label: "Patch decision", value: run.latestPatchDecision ?? "Unrecorded" }
      ]
    });
  }

  return rows.slice(0, 4);
}

function buildFocusAreas(runs: RunPortfolioItem[]): OperationsViewModel["focusAreas"] {
  if (runs.length === 0) {
    return [
      {
        title: "No active operational focus areas",
        summary: "Once runs land, this panel will highlight the top stop reasons and safety incidents.",
        owner: "Operator",
        status: "Waiting for data",
        labels: [
          { label: "Actual", value: "0 runs" },
          { label: "Source", value: "Supabase read model" }
        ]
      }
    ];
  }

  return runs.slice(0, 3).map((run) => ({
    title: run.title,
    summary: run.stopReason ?? `Lifecycle: ${run.lifecycleState}`,
    owner: run.projectId,
    status: deriveRunStatus(run),
    labels: [
      { label: "Stop reason", value: run.stopReason ?? run.lifecycleState },
      { label: "Patch decision", value: run.latestPatchDecision ?? "Unrecorded" },
      { label: "Grounding evidence", value: `${String(run.groundingViolationCount)} flagged` },
      { label: "Leash surface", value: run.lastSafetySurface ?? "none" },
      { label: "Budget variance", value: formatSignedUsd(run.budgetVarianceUsd) },
      { label: "Accounting mode", value: run.accountingMode }
    ]
  }));
}

function buildApprovalQueue(runs: RunPortfolioItem[]): GovernanceViewModel["approvals"] {
  const escalations = runs.filter((run) => run.lifecycleState === "human_escalation");
  if (escalations.length === 0) {
    return [
      {
        id: "no-approvals",
        title: "No approval queue items",
        summary: "No runs currently require human escalation.",
        owner: "Control plane",
        status: "Clear",
        labels: [
          { label: "Actual", value: "0 escalations" },
          { label: "Source", value: "runs table" }
        ]
      }
    ];
  }

  return escalations.map((run) => ({
    id: `${run.runId}:approval`,
    title: run.title,
    summary: run.stopReason ?? "Escalated for human review.",
    owner: run.projectId,
    status: "Pending review",
    labels: [
      { label: "Actual", value: run.lifecycleState },
      { label: "Source", value: "run.exited ledger event" },
      { label: "Stop reason", value: run.stopReason ?? run.lifecycleState },
      { label: "Patch decision", value: run.latestPatchDecision ?? "Unrecorded" },
      { label: "Grounding evidence", value: `${String(run.groundingViolationCount)} flagged` }
    ]
  }));
}

function summarizeRuns(runs: RunRow[], budgetMetrics: BudgetMetricRow[]) {
  const completedRuns = runs.filter((run) => run.lifecycleState === "completed").length;
  const activeRuns = runs.filter((run) => run.status === "running").length;
  const totalActualUsd = roundUsd(runs.reduce((total, run) => total + run.actualUsd, 0));
  const totalModeledAvoidedUsd = roundUsd(
    runs.reduce((total, run) => total + run.modeledAvoidedUsd, 0)
  );
  const averageSettledCost =
    budgetMetrics.length === 0
      ? 0
      : budgetMetrics.reduce((total, metric) => total + metric.actualUsd, 0)
        / budgetMetrics.length;
  const forecastUsd = roundUsd(totalActualUsd + activeRuns * averageSettledCost);
  const lastUpdated = runs[0]?.updatedAt ?? "No runs yet";

  return {
    runCount: runs.length,
    completedRuns,
    activeRuns,
    solveRatePct: runs.length === 0 ? 0 : Math.round((completedRuns / runs.length) * 100),
    totalActualUsd,
    totalModeledAvoidedUsd,
    forecastUsd,
    lastUpdated
  };
}

function buildRunPortfolio(dataset: DashboardDataset): RunPortfolioItem[] {
  return dataset.runs.map((run) => {
    const attempts = dataset.attempts
      .filter((attempt) => attempt.runId === run.runId)
      .sort((left, right) => left.attemptIndex - right.attemptIndex)
      .map((attempt) => enrichAttemptTruth(attempt, dataset));
    const violations = dataset.violations.filter((violation) => violation.runId === run.runId);
    const budgetMetrics = dataset.budgetMetrics.filter((metric) => metric.runId === run.runId);
    const latestPatchAttempt = [...attempts]
      .reverse()
      .find((attempt) => attempt.patchDecision !== null);
    const latestSafetyAttempt = [...attempts]
      .reverse()
      .find((attempt) => attempt.safetySurface !== null);
    const groundingViolationCount = attempts.reduce(
      (total, attempt) => total + attempt.groundingViolationCount,
      0
    );
    const groundingContentOnlyCount = attempts.reduce(
      (total, attempt) =>
        total + (attempt.groundingContentOnly ? attempt.groundingViolationCount : 0),
      0
    );
    const blockedSafetyViolationCount = attempts.reduce(
      (total, attempt) =>
        total + (attempt.safetyBlocked ? attempt.safetyViolationCount : 0),
      0
    );
    const budgetVarianceUsd = roundUsd(
      budgetMetrics.reduce((total, metric) => total + metric.varianceUsd, 0)
    );
    const accountingMode = selectProvenance(
      attempts
        .map((attempt) => attempt.budgetProvenance)
        .filter((value): value is BudgetMetricRow["provenance"] => value !== null),
      run.costProvenance
    );

    return {
      ...run,
      latestPatchDecision: latestPatchAttempt?.patchDecision ?? run.latestPatchDecision,
      latestPatchSummary: latestPatchAttempt?.patchSummary ?? run.latestPatchSummary,
      latestPatchReasonCodes: latestPatchAttempt?.patchReasonCodes ?? run.latestPatchReasonCodes,
      latestPatchScore: latestPatchAttempt?.patchScore ?? run.latestPatchScore,
      groundingViolationCount:
        groundingViolationCount > 0 ? groundingViolationCount : run.groundingViolationCount,
      groundingContentOnlyCount:
        groundingContentOnlyCount > 0
          ? groundingContentOnlyCount
          : run.groundingContentOnlyCount,
      blockedSafetyViolationCount:
        blockedSafetyViolationCount > 0
          ? blockedSafetyViolationCount
          : run.blockedSafetyViolationCount,
      lastSafetySurface: latestSafetyAttempt?.safetySurface ?? run.lastSafetySurface,
      budgetVarianceUsd:
        budgetMetrics.length > 0 || attempts.some((attempt) => attempt.budgetProvenance !== null)
          ? budgetVarianceUsd
          : run.budgetVarianceUsd,
      accountingMode,
      attempts,
      violations,
      budgetMetrics
    };
  });
}

function enrichAttemptTruth(
  attempt: AttemptRow,
  dataset: DashboardDataset
): AttemptRow {
  const attemptEvents = dataset.events.filter(
    (event) => event.runId === attempt.runId && event.attemptIndex === attempt.attemptIndex
  );
  const attemptViolations = dataset.violations.filter(
    (violation) => violation.runId === attempt.runId && violation.attemptIndex === attempt.attemptIndex
  );
  const budgetMetric = dataset.budgetMetrics.find(
    (metric) => metric.runId === attempt.runId && metric.attemptIndex === attempt.attemptIndex
  );
  const patchEvent = [...attemptEvents]
    .reverse()
    .find((event) => event.kind === "attempt.kept" || event.kind === "attempt.discarded");
  const groundingEvent = [...attemptEvents]
    .reverse()
    .find((event) => event.kind === "grounding.violations_found");
  const safetyEvent = [...attemptEvents]
    .reverse()
    .find((event) => event.kind === "safety.violations_found");
  const groundingViolationCount =
    readEventNumber(groundingEvent?.payload, "violationCount") ||
    attemptViolations.filter((violation) => violation.violationKind === "grounding.violations_found").length ||
    attempt.groundingViolationCount;
  const safetyViolations = attemptViolations.filter(
    (violation) => violation.violationKind === "safety.violations_found"
  );
  const safetyViolationCount =
    readEventArrayLength(safetyEvent?.payload, "violations") ||
    safetyViolations.length ||
    attempt.safetyViolationCount;
  const patchReasonCodes = readEventStringArray(patchEvent?.payload, "reasonCodes");
  const groundingResolvedFiles = readEventStringArray(groundingEvent?.payload, "resolvedFiles");

  return {
    ...attempt,
    patchDecision: readEventString(patchEvent?.payload, "decision") ?? attempt.patchDecision,
    patchSummary: readEventString(patchEvent?.payload, "reason") ?? attempt.patchSummary,
    patchReasonCodes: patchReasonCodes.length > 0 ? patchReasonCodes : attempt.patchReasonCodes,
    patchScore: readEventNullableNumber(patchEvent?.payload, "score") ?? attempt.patchScore,
    groundingViolationCount,
    groundingContentOnly:
      readEventBoolean(groundingEvent?.payload, "contentOnly") || attempt.groundingContentOnly,
    groundingResolvedFiles:
      groundingResolvedFiles.length > 0 ? groundingResolvedFiles : attempt.groundingResolvedFiles,
    safetyViolationCount,
    safetySurface: readEventString(safetyEvent?.payload, "surface") ?? attempt.safetySurface,
    safetyBlocked: readEventBoolean(safetyEvent?.payload, "blocked") || attempt.safetyBlocked,
    safetyProfile: readEventString(safetyEvent?.payload, "profile") ?? attempt.safetyProfile,
    budgetActualUsd: budgetMetric?.actualUsd ?? attempt.budgetActualUsd,
    budgetEstimatedUsd: budgetMetric?.estimatedUsd ?? attempt.budgetEstimatedUsd,
    budgetVarianceUsd: budgetMetric?.varianceUsd ?? attempt.budgetVarianceUsd,
    budgetProvenance: budgetMetric?.provenance ?? attempt.budgetProvenance
  };
}

function deriveRunStatus(run: RunPortfolioItem): string {
  if (run.lifecycleState === "human_escalation") {
    return "Needs review";
  }
  if (run.blockedSafetyViolationCount > 0 || run.groundingViolationCount > 0) {
    return "Watching";
  }
  if (run.lifecycleState === "completed") {
    return "Stable";
  }
  return capitalize(run.lifecycleState.replace(/_/g, " "));
}

function selectAccountingMode(runs: RunPortfolioItem[]): string {
  if (runs.length === 0) {
    return "unavailable";
  }

  return selectProvenance(runs.map((run) => run.accountingMode), "unavailable");
}

function selectProvenance(
  values: BudgetMetricRow["provenance"][],
  fallback: BudgetMetricRow["provenance"]
): BudgetMetricRow["provenance"] {
  if (values.includes("actual")) {
    return "actual";
  }
  if (values.includes("estimated")) {
    return "estimated";
  }
  return fallback;
}

function readEventString(
  payload: Record<string, unknown> | undefined,
  key: string
): string | null {
  const value = payload?.[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function readEventStringArray(
  payload: Record<string, unknown> | undefined,
  key: string
): string[] {
  const value = payload?.[key];
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter((entry): entry is string => typeof entry === "string" && entry.length > 0);
}

function readEventNumber(
  payload: Record<string, unknown> | undefined,
  key: string
): number {
  const value = payload?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function readEventNullableNumber(
  payload: Record<string, unknown> | undefined,
  key: string
): number | null {
  const value = payload?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function readEventBoolean(
  payload: Record<string, unknown> | undefined,
  key: string
): boolean {
  return payload?.[key] === true;
}

function readEventArrayLength(
  payload: Record<string, unknown> | undefined,
  key: string
): number {
  const value = payload?.[key];
  return Array.isArray(value) ? value.length : 0;
}

function actualLabels(source: string, freshness: string): LabeledDetail[] {
  return [
    { label: "Actual", value: source },
    { label: "Freshness", value: freshness }
  ];
}

function estimatedLabels(source: string, freshness: string): LabeledDetail[] {
  return [
    { label: "Estimated", value: source },
    { label: "Freshness", value: freshness }
  ];
}

function modeledLabels(source: string, freshness: string): LabeledDetail[] {
  return [
    { label: "Modeled", value: source },
    { label: "Freshness", value: freshness }
  ];
}

function formatUsd(value: number): string {
  return `$${value.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  })}`;
}

function formatSignedUsd(value: number): string {
  const formatted = formatUsd(Math.abs(value));
  return value < 0 ? `-${formatted}` : formatted;
}

function roundUsd(value: number): number {
  return Math.round(value * 100) / 100;
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}
