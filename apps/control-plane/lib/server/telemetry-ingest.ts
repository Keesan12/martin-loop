import type { TelemetryEnvelope, TelemetryLoop } from "../domain/models";
import type { ControlPlaneRepository, RunGraph, RunRow } from "./control-plane-repository";

export async function ingestTelemetryEnvelope(
  repository: ControlPlaneRepository,
  envelope: TelemetryEnvelope
): Promise<{ runCount: number }> {
  for (const loop of envelope.loops) {
    await repository.replaceRunGraph(buildTelemetryRunGraph(envelope, loop));
  }

  return { runCount: envelope.loops.length };
}

function buildTelemetryRunGraph(
  envelope: TelemetryEnvelope,
  loop: TelemetryLoop
): RunGraph {
  const lifecycle = lifecycleFromHealth(loop.status);
  const run: RunRow = {
    runId: loop.loopId,
    workspaceId: envelope.workspaceId,
    projectId: loop.project,
    title: loop.name,
    objective: `External telemetry snapshot from ${envelope.source}.`,
    repoRoot: null,
    status: lifecycle.status,
    lifecycleState: lifecycle.lifecycleState,
    stopReason: lifecycle.stopReason,
    activeModel: null,
    adapterId: `telemetry:${envelope.source}`,
    providerId: envelope.source,
    transport: "telemetry",
    actualUsd: roundUsd(loop.actualCostUsd),
    estimatedUsd: 0,
    costProvenance: "actual",
    modeledAvoidedUsd: roundUsd(loop.avoidedCostUsd),
    tokensIn: loop.tokensProcessed,
    tokensOut: 0,
    attemptsCount: 0,
    keptAttempts: 0,
    discardedAttempts: 0,
    latestPatchDecision: null,
    latestPatchSummary: null,
    latestPatchReasonCodes: [],
    latestPatchScore: null,
    groundingViolationCount: 0,
    groundingContentOnlyCount: 0,
    blockedSafetyViolationCount: 0,
    lastSafetySurface: null,
    budgetVarianceUsd: 0,
    accountingMode: "actual",
    createdAt: loop.lastSeenAt,
    updatedAt: envelope.submittedAt
  };

  return {
    run,
    attempts: [],
    events: [
      {
        eventId: `${loop.loopId}:telemetry.ingested:${envelope.submittedAt}`,
        runId: loop.loopId,
        attemptIndex: null,
        kind: "telemetry.ingested",
        lifecycleState: lifecycle.lifecycleState,
        timestamp: envelope.submittedAt,
        payload: {
          source: envelope.source,
          health: loop.status,
          ownerTeam: loop.ownerTeam,
          agentCount: loop.agentCount,
          savingsRatio: loop.savingsRatio
        }
      }
    ],
    violations: [],
    budgetMetrics: [
      {
        metricId: `${loop.loopId}:telemetry:spend`,
        runId: loop.loopId,
        attemptIndex: 0,
        actualUsd: roundUsd(loop.actualCostUsd),
        estimatedUsd: 0,
        provenance: "actual",
        patchCostUsd: roundUsd(loop.actualCostUsd),
        verificationCostUsd: 0,
        varianceUsd: 0,
        tokensIn: loop.tokensProcessed,
        tokensOut: 0,
        createdAt: envelope.submittedAt
      }
    ]
  };
}

function lifecycleFromHealth(status: TelemetryLoop["status"]): {
  status: RunRow["status"];
  lifecycleState: RunRow["lifecycleState"];
  stopReason: string | null;
} {
  switch (status) {
    case "healthy":
      return {
        status: "completed",
        lifecycleState: "completed",
        stopReason: "Telemetry reports healthy."
      };
    case "watch":
      return {
        status: "running",
        lifecycleState: "running",
        stopReason: "Telemetry reports watch status."
      };
    case "alert":
      return {
        status: "exited",
        lifecycleState: "human_escalation",
        stopReason: "Telemetry reports alert status."
      };
    case "critical":
      return {
        status: "exited",
        lifecycleState: "human_escalation",
        stopReason: "Telemetry reports critical status."
      };
  }
}

function roundUsd(value: number): number {
  return Math.round(value * 100) / 100;
}
