import { getBillingPageData } from "../../../lib/queries/control-plane-queries";
import { requireControlPlaneAuth } from "../../../lib/server/auth";
import { jsonError, jsonResponse } from "../../../lib/server/http";
import { isEmail, isNonEmptyString, isPositiveInteger } from "../../../lib/server/validation";

type BillingPayload = {
  workspaceId: string;
  requestedPlan: string;
  seatsRequested: number;
  billingEmail: string;
};

export async function GET(request: Request): Promise<Response> {
  const auth = await requireControlPlaneAuth(request);

  if (!auth.ok) {
    return auth.response;
  }

  return jsonResponse(await getBillingPageData());
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
    return jsonError("invalid_billing_request", "Billing request must be valid JSON.");
  }

  if (!isBillingPayload(payload)) {
    return jsonError(
      "invalid_billing_request",
      "Billing requests must include a workspace, requested plan, valid billing email, and positive seat count."
    );
  }

  const scopedAuth = await requireControlPlaneAuth(request, {
    workspaceId: payload.workspaceId
  });

  if (!scopedAuth.ok) {
    return scopedAuth.response;
  }

  return jsonResponse(
    {
      accepted: true,
      workspaceId: payload.workspaceId,
      preview: {
        requestedPlan: payload.requestedPlan,
        seatsRequested: payload.seatsRequested,
        billingEmail: payload.billingEmail
      }
    },
    { status: 202 }
  );
}

function isBillingPayload(value: unknown): value is BillingPayload {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const record = value as Record<string, unknown>;

  return (
    isNonEmptyString(record.workspaceId) &&
    isNonEmptyString(record.requestedPlan) &&
    isPositiveInteger(record.seatsRequested) &&
    isEmail(record.billingEmail)
  );
}
