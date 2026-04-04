import { createTelemetryEnvelope } from "../../../lib/domain/models";
import { getControlPlaneRepository } from "../../../lib/server/control-plane-repository";
import { ingestRunsIntoControlPlane } from "../../../lib/server/ingest-run-read-model";
import { requireControlPlaneAuth } from "../../../lib/server/auth";
import { jsonError, jsonResponse } from "../../../lib/server/http";
import {
  isBoundedArray,
  isFiniteNonNegativeNumber,
  isIsoTimestamp,
  isNonEmptyString,
  isNonNegativeInteger,
  isOneOf,
  isPositiveInteger
} from "../../../lib/server/validation";

type TelemetryPayload = {
  workspaceId: string;
  source: string;
  loops: Parameters<typeof createTelemetryEnvelope>[0]["loops"];
};

export async function POST(request: Request): Promise<Response> {
  const auth = await requireControlPlaneAuth(request);

  if (!auth.ok) {
    return auth.response;
  }

  let payload: unknown;

  try {
    payload = await request.json();
  } catch {
    return jsonError("invalid_telemetry_payload", "Telemetry payload must be valid JSON.");
  }

  if (!isTelemetryPayload(payload)) {
    return jsonError(
      "invalid_telemetry_payload",
      "Telemetry payload must include a workspace, source, and at least one valid loop record."
    );
  }

  const scopedAuth = await requireControlPlaneAuth(request, {
    workspaceId: payload.workspaceId
  });

  if (!scopedAuth.ok) {
    return scopedAuth.response;
  }

  const envelope = createTelemetryEnvelope(payload, new Date().toISOString());
  const repository = await getControlPlaneRepository();

  if (repository.mode === "unavailable") {
    return jsonError("supabase_not_configured", "Supabase is not configured.", {
      status: 503
    });
  }

  const ingested = await ingestRunsIntoControlPlane(repository);

  return jsonResponse(
    {
      accepted: true,
      summary: {
        loops: envelope.loops.length,
        totalActualUsd: envelope.totalActualUsd,
        runsIngested: ingested.runCount
      },
      envelope
    },
    { status: 202 }
  );
}

function isTelemetryPayload(value: unknown): value is TelemetryPayload {
  if (!isObject(value)) {
    return false;
  }

  return (
    isNonEmptyString(value.workspaceId) &&
    isOneOf(value.source, ["sdk", "api", "partner"] as const) &&
    isBoundedArray(value.loops, {
      min: 1,
      max: 100,
      itemGuard: isTelemetryLoop
    })
  );
}

function isTelemetryLoop(
  value: unknown
): value is Parameters<typeof createTelemetryEnvelope>[0]["loops"][number] {
  if (!isObject(value)) {
    return false;
  }

  return (
    isNonEmptyString(value.loopId) &&
    isNonEmptyString(value.name) &&
    isNonEmptyString(value.project) &&
    isNonEmptyString(value.ownerTeam) &&
    isPositiveInteger(value.agentCount) &&
    isOneOf(value.status, ["healthy", "watch", "alert", "critical"] as const) &&
    isFiniteNonNegativeNumber(value.actualCostUsd) &&
    isFiniteNonNegativeNumber(value.avoidedCostUsd) &&
    isNonNegativeInteger(value.tokensProcessed) &&
    isIsoTimestamp(value.lastSeenAt)
  );
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
