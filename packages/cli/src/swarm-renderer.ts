import type {
  SwarmDossierProjection,
  SwarmEvidenceVerification,
  SwarmOperationalState,
} from "@martin/core";
import type { SwarmOperationalCancellationResult } from "../../core/dist/swarm/operations.js";

export function toSwarmDossierData(dossier: SwarmDossierProjection) {
  return { command: "swarm dossier", ...dossier };
}

export function renderSwarmDossierHuman(data: ReturnType<typeof toSwarmDossierData>): string[] {
  return [
    `Swarm ${data.swarmId}`,
    `Outcome: ${data.parentOutcome.state.toUpperCase()} — ${data.parentOutcome.reason}`,
    `Integrity: ${data.integrityState.toUpperCase()}`,
    `Task verification: ${data.taskVerificationState.toUpperCase()}`,
    `Receipt: ${data.receiptId}`,
    `Plan: ${data.planHash}`,
    `Tasks: ${data.taskCounts.accepted ?? 0}/${data.taskCounts.total} accepted`,
    `Agents: ${data.agentCounts.verified ?? 0}/${data.agentCounts.total} verified`,
    `Budget: $${data.budget.settledUsd.toFixed(2)} settled of $${data.budget.capUsd.toFixed(2)}`,
    `Evidence: ${data.evidence.files} files, ${data.evidence.events} events, ${data.evidence.childReceipts} child receipts`,
    `Sealed: ${data.sealedAt}`,
  ];
}

export function toSwarmVerifyData(verification: SwarmEvidenceVerification) {
  return { command: "swarm verify", ...verification };
}

export function renderSwarmVerifyHuman(data: ReturnType<typeof toSwarmVerifyData>): string[] {
  return [
    `Swarm ${data.swarmId}: ${data.verified ? "VERIFIED" : "NOT VERIFIED"}`,
    `Integrity: ${data.integrityState.toUpperCase()}`,
    `Task verification: ${data.taskVerificationState.toUpperCase()}`,
    `Parent outcome: ${data.parentOutcomeState.toUpperCase()}`,
    `Receipt: ${data.receiptId}`,
    `Verified at: ${data.verifiedAt}`,
  ];
}

export function toSwarmStatusData(state: SwarmOperationalState, watching: boolean) {
  return {
    command: "swarm status",
    swarmId: state.snapshot.swarmId,
    planHash: state.snapshot.planHash,
    revision: state.snapshot.revision,
    state: state.snapshot.outcome.state,
    reason: state.snapshot.outcome.reason,
    eventCount: state.snapshot.eventCount,
    ...(state.snapshot.lastEventType ? { lastEventType: state.snapshot.lastEventType } : {}),
    ...(state.snapshot.cancellation ? { cancellation: { ...state.snapshot.cancellation } } : {}),
    updatedAt: state.snapshot.updatedAt,
    watching,
  };
}

export function renderSwarmStatusHuman(data: ReturnType<typeof toSwarmStatusData>): string[] {
  return [
    `Swarm ${data.swarmId}: ${data.state.toUpperCase()}`,
    `Revision: ${data.revision} (${data.eventCount} events)`,
    `Last event: ${data.lastEventType ?? "none"}`,
    `Updated: ${data.updatedAt}`,
    data.reason,
  ];
}

export function toSwarmInspectData(state: SwarmOperationalState) {
  return {
    command: "swarm inspect",
    swarmId: state.snapshot.swarmId,
    plan: state.plan,
    snapshot: state.snapshot,
    events: state.events,
  };
}

export function renderSwarmInspectHuman(data: ReturnType<typeof toSwarmInspectData>): string[] {
  return [
    `Swarm ${data.swarmId}`,
    `Plan: ${data.plan.planHash}`,
    `Outcome: ${data.snapshot.outcome.state.toUpperCase()} — ${data.snapshot.outcome.reason}`,
    "Events:",
    ...(data.events.length === 0
      ? ["  none"]
      : data.events.map((event) => `  ${event.sequence}. ${event.timestamp} ${event.type}`)),
  ];
}

export function toSwarmCancelData(result: SwarmOperationalCancellationResult) {
  return {
    command: "swarm cancel",
    swarmId: result.state.snapshot.swarmId,
    outcome: result.outcome,
    revision: result.state.snapshot.revision,
    state: result.state.snapshot.outcome.state,
    ...(result.state.snapshot.cancellation ? { cancellation: { ...result.state.snapshot.cancellation } } : {}),
  };
}

export function renderSwarmCancelHuman(data: ReturnType<typeof toSwarmCancelData>): string[] {
  return [
    `Swarm ${data.swarmId}: ${data.outcome.replaceAll("_", " ")}`,
    `State: ${data.state}`,
    `Revision: ${data.revision}`,
  ];
}
