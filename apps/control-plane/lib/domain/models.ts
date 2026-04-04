export type LoopHealth = "healthy" | "watch" | "alert" | "critical";
export type Tone = "positive" | "warning" | "danger" | "neutral";

export interface NavigationItem {
  label: string;
  href: string;
  shortLabel?: string;
  description?: string;
}

export interface WorkspaceProfile {
  id: string;
  name: string;
  primaryContact: string;
  billingEmail: string;
  plan: string;
  monthlyBudgetUsd: number;
  seatsUsed: number;
  seatsTotal: number;
  region?: string;
  renewalDate?: string;
  operatingCadence?: string;
}

export interface WorkspaceProfileDraft {
  id: string;
  name: string;
  primaryContact: string;
  billingEmail: string;
  plan?: string;
  monthlyBudgetUsd?: number;
  seatsUsed?: number;
  seatsTotal?: number;
  region?: string;
  renewalDate?: string;
  operatingCadence?: string;
}

export interface BillingInvoice {
  invoiceId: string;
  month: string;
  amountUsd: number;
  status: "Paid" | "Due" | "Draft";
}

export interface BillingProfile {
  workspaceId: string;
  planName: string;
  monthlyCommitUsd: number;
  forecastSpendUsd: number;
  realizedSavingsUsd: number;
  paymentStatus: string;
  seatUtilizationPct: number;
  invoices: BillingInvoice[];
  seatsUsed?: number;
  seatsTotal?: number;
}

export interface BillingChangeRequest {
  workspaceId: string;
  requestedPlan: string;
  seatsRequested: number;
  billingEmail: string;
}

export interface TelemetryLoopInput {
  loopId: string;
  name: string;
  project: string;
  ownerTeam: string;
  agentCount: number;
  status: LoopHealth;
  actualCostUsd: number;
  avoidedCostUsd: number;
  tokensProcessed: number;
  lastSeenAt: string;
}

export interface TelemetryLoop extends TelemetryLoopInput {
  savingsRatio: number;
}

export interface TelemetryEnvelope {
  workspaceId: string;
  source: string;
  submittedAt: string;
  loops: TelemetryLoop[];
  totalActualUsd: number;
  totalAvoidedUsd: number;
}

export interface TelemetryEnvelopeDraft {
  workspaceId: string;
  source: "sdk" | "api" | "partner";
  loops: TelemetryLoopInput[];
}

export interface PolicyRecord {
  id: string;
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
}

export interface PolicyUpdateRequest {
  workspaceId: string;
  policies: Array<
    PolicyRecord & {
      status?: PolicyRecord["status"] | "Review";
    }
  >;
}

export interface AttentionLoop {
  loopId: string;
  name: string;
  reason: string;
  statusTone: Tone;
  team: string;
  lastSeenAt: string;
}

export interface TrendPoint {
  label: string;
  savedUsd: number;
  spendUsd: number;
}

export interface SeatMixItem {
  label: string;
  count: number;
}

export interface IntegrationConnection {
  id: string;
  name: string;
  status: string;
  detail: string;
  owner?: string;
  category?: string;
  tone?: Tone;
}

export interface ExecutiveMetric {
  label: string;
  value: string;
  delta: string;
  tone?: "positive" | "neutral" | "warning";
}

export function createWorkspaceProfile(input: WorkspaceProfileDraft): WorkspaceProfile {
  return {
    id: input.id,
    name: input.name,
    primaryContact: input.primaryContact,
    billingEmail: input.billingEmail,
    plan: input.plan ?? "Growth",
    monthlyBudgetUsd: input.monthlyBudgetUsd ?? 45_000,
    seatsUsed: input.seatsUsed ?? 18,
    seatsTotal: input.seatsTotal ?? 25,
    region: input.region ?? "North America",
    renewalDate: input.renewalDate ?? "2026-07-01",
    operatingCadence: input.operatingCadence ?? "Weekly control review"
  };
}

export function createBillingProfile(input: {
  workspaceId: string;
  planName: string;
  monthlyCommitUsd: number;
  forecastSpendUsd: number;
  realizedSavingsUsd: number;
  seatsUsed?: number;
  seatsTotal?: number;
}): BillingProfile {
  const seatsUsed = input.seatsUsed ?? 18;
  const seatsTotal = input.seatsTotal ?? 25;

  return {
    ...input,
    paymentStatus: "Healthy",
    seatUtilizationPct: Math.round((seatsUsed / seatsTotal) * 100),
    seatsUsed,
    seatsTotal,
    invoices: []
  };
}

export function createTelemetryEnvelope(
  input: {
    workspaceId: string;
    source: string;
    loops: TelemetryLoopInput[];
  },
  submittedAt: string
): TelemetryEnvelope {
  const loops = input.loops.map((loop) => ({
    ...loop,
    savingsRatio:
      loop.actualCostUsd === 0
        ? loop.avoidedCostUsd
        : round(loop.avoidedCostUsd / loop.actualCostUsd)
  }));

  return {
    workspaceId: input.workspaceId,
    source: input.source,
    submittedAt,
    loops,
    totalActualUsd: loops.reduce((total, loop) => total + loop.actualCostUsd, 0),
    totalAvoidedUsd: loops.reduce((total, loop) => total + loop.avoidedCostUsd, 0)
  };
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
