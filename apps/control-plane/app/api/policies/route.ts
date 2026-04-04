import { getControlPlaneRepository } from "../../../lib/server/control-plane-repository";
import { requireControlPlaneAuth } from "../../../lib/server/auth";
import { jsonError, jsonResponse } from "../../../lib/server/http";
import {
  isBoundedArray,
  isFiniteNonNegativeNumber,
  isNonEmptyString,
  isOneOf,
  isPercentage,
  isPositiveInteger
} from "../../../lib/server/validation";

type PolicyPayload = {
  workspaceId: string;
  policies: unknown[];
};

export async function GET(request: Request): Promise<Response> {
  const auth = await requireControlPlaneAuth(request);

  if (!auth.ok) {
    return auth.response;
  }

  const repository = await getControlPlaneRepository();
  const policies = await repository.listPolicies(auth.auth.role === "workspace" ? auth.auth.workspaceId : undefined);
  return jsonResponse({
    policies
  });
}

export async function POST(request: Request): Promise<Response> {
  const auth = await requireControlPlaneAuth(request);

  if (!auth.ok) {
    return auth.response;
  }

  let payload: unknown;

  try {
    payload = await request.json();
  } catch {
    return jsonError("invalid_policy_payload", "Policy update request must be valid JSON.");
  }

  if (!isPolicyPayload(payload)) {
    return jsonError(
      "invalid_policy_payload",
      "Policy update requests must include a workspace and at least one bounded policy record."
    );
  }

  const scopedAuth = await requireControlPlaneAuth(request, {
    workspaceId: payload.workspaceId
  });

  if (!scopedAuth.ok) {
    return scopedAuth.response;
  }

  const repository = await getControlPlaneRepository();
  if (repository.mode === "unavailable") {
    return jsonError("supabase_not_configured", "Supabase is not configured.", {
      status: 503
    });
  }

  const now = new Date().toISOString();
  await repository.replacePolicies(
    payload.workspaceId,
    payload.policies.map((policy) => ({
      id: String((policy as Record<string, unknown>).id),
      workspaceId: payload.workspaceId,
      name: String((policy as Record<string, unknown>).name),
      scope: String((policy as Record<string, unknown>).scope),
      owner: String((policy as Record<string, unknown>).owner),
      status: normalizePolicyStatus(String((policy as Record<string, unknown>).status)),
      monthlyBudgetUsd: Number((policy as Record<string, unknown>).monthlyBudgetUsd),
      maxIterations: Number((policy as Record<string, unknown>).maxIterations),
      fallbackModel: String((policy as Record<string, unknown>).fallbackModel),
      alertThresholdPct: Number((policy as Record<string, unknown>).alertThresholdPct),
      autoStopAfterMinutes: Number((policy as Record<string, unknown>).autoStopAfterMinutes),
      description: String((policy as Record<string, unknown>).description),
      provenance: "workspace_policy",
      createdAt: now,
      updatedAt: now
    }))
  );

  return jsonResponse(
    {
      accepted: true,
      workspaceId: payload.workspaceId,
      updatedCount: payload.policies.length
    },
    { status: 202 }
  );
}

function normalizePolicyStatus(value: string): "Active" | "Draft" | "Needs Review" {
  if (value === "Active") {
    return "Active";
  }
  if (value === "Needs Review") {
    return "Needs Review";
  }
  return "Draft";
}

function isPolicyPayload(value: unknown): value is PolicyPayload {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const record = value as Record<string, unknown>;

  return (
    isNonEmptyString(record.workspaceId) &&
    isBoundedArray(record.policies, {
      min: 1,
      max: 50,
      itemGuard: isPolicyRecord
    })
  );
}

function isPolicyRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const record = value as Record<string, unknown>;

  return (
    isNonEmptyString(record.id) &&
    isNonEmptyString(record.name) &&
    isNonEmptyString(record.scope) &&
    isNonEmptyString(record.owner) &&
    isOneOf(record.status, ["Active", "Draft", "Needs Review", "Review"] as const) &&
    isFiniteNonNegativeNumber(record.monthlyBudgetUsd) &&
    isPositiveInteger(record.maxIterations) &&
    isNonEmptyString(record.fallbackModel) &&
    isPercentage(record.alertThresholdPct) &&
    isPositiveInteger(record.autoStopAfterMinutes) &&
    isNonEmptyString(record.description)
  );
}
