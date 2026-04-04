import { getControlPlaneRepository } from "../../../lib/server/control-plane-repository";
import { requireControlPlaneAuth } from "../../../lib/server/auth";
import { jsonError, jsonResponse } from "../../../lib/server/http";
import { isEmail, isNonEmptyString } from "../../../lib/server/validation";

type WorkspacePayload = {
  id: string;
  name: string;
  primaryContact: string;
  billingEmail: string;
};

export async function GET(request: Request): Promise<Response> {
  const auth = await requireControlPlaneAuth(request, { requireAdmin: true });

  if (!auth.ok) {
    return auth.response;
  }

  const repository = await getControlPlaneRepository();
  const workspaces = await repository.listWorkspaces();
  return jsonResponse({
    workspaces
  });
}

export async function POST(request: Request): Promise<Response> {
  const auth = await requireControlPlaneAuth(request, { requireAdmin: true });

  if (!auth.ok) {
    return auth.response;
  }

  let payload: unknown;

  try {
    payload = await request.json();
  } catch {
    return jsonError("invalid_workspace_payload", "Workspace request must be valid JSON.");
  }

  if (!isWorkspacePayload(payload)) {
    return jsonError(
      "invalid_workspace_payload",
      "Workspace requests must include an id, name, primary contact, and valid billing email."
    );
  }

  const repository = await getControlPlaneRepository();
  if (repository.mode === "unavailable") {
    return jsonError("supabase_not_configured", "Supabase is not configured.", {
      status: 503
    });
  }

  const now = new Date().toISOString();
  const created = await repository.upsertWorkspace({
    id: payload.id,
    name: payload.name,
    primaryContact: payload.primaryContact,
    billingEmail: payload.billingEmail,
    plan: "Growth",
    monthlyBudgetUsd: 45_000,
    seatsUsed: 0,
    seatsTotal: 5,
    region: "Unspecified",
    renewalDate: "",
    operatingCadence: "",
    createdAt: now,
    updatedAt: now
  });

  return jsonResponse(
    {
      accepted: true,
      workspace: created
    },
    { status: 201 }
  );
}

function isWorkspacePayload(value: unknown): value is WorkspacePayload {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const record = value as Record<string, unknown>;

  return (
    isNonEmptyString(record.id) &&
    isNonEmptyString(record.name) &&
    isNonEmptyString(record.primaryContact) &&
    isEmail(record.billingEmail)
  );
}
