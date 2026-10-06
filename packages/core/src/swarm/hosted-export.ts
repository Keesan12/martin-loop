import { createHash, createHmac } from "node:crypto";
import { realpath } from "node:fs/promises";
import { resolve } from "node:path";

import {
  SWARM_PARENT_RECEIPT_SCHEMA_VERSION,
  SWARM_SCHEMA_VERSION,
  computeSwarmLivePlanHash,
  type SwarmLiveEvent,
  type SwarmParentReceipt,
} from "@martin/contracts";
import {
  SWARM_EVIDENCE_INDEX_SCHEMA_VERSION,
  SWARM_HOSTED_SCHEMA_VERSION,
  canonicalSwarmHostedTransportBytes,
  computeSwarmHostedEnvelopeIdentity,
  validateSwarmHostedEnvelope,
  type SwarmHostedConflict,
  type SwarmHostedEnvelope,
  type SwarmHostedEvent,
  type SwarmHostedEvidenceReference,
  type SwarmHostedIntegrationDecision,
} from "../../../contracts/dist/swarm-hosted.js";

import { readPrivateIntegrityKey } from "../persistence/integrity.js";
import { readSwarmReceiptProjection, type SwarmReceiptProjection } from "./receipt-projection.js";
import { assertSwarmPathIdentifier } from "./workspaces.js";
import { readSwarmOperationalState, type SwarmOperationalState } from "./operations.js";

export const SWARM_HOSTED_TRANSPORT_DOMAIN = "martin.swarm-hosted.v1" as const;

async function deriveSwarmHostedTransportKeyMaterialFromReceipt(input: {
  runsRoot: string;
  swarmId: string;
  domain: typeof SWARM_HOSTED_TRANSPORT_DOMAIN;
}): Promise<{ secret: string; keyId: string }> {
  assertSwarmPathIdentifier(input.swarmId, "swarm ID");
  const runsRoot = await realpath(resolve(input.runsRoot));
  const receiptSecret = await readPrivateIntegrityKey(runsRoot, `swarm-${input.swarmId}.key`);
  if (!receiptSecret) throw new Error("SWARM_SEAL_KEY_UNAVAILABLE");
  const secret = createHmac("sha256", receiptSecret)
    .update(`${input.domain}\n${input.swarmId}\n`)
    .digest("hex");
  return { secret, keyId: `hosted-${sha256(secret).slice(0, 16)}` };
}

export interface BuildSwarmHostedEnvelopeInput {
  runsRoot: string;
  swarmId: string;
  runtimeVersion: string;
}

export interface SwarmHostedTransportKeyLocator {
  keyId: string;
  keyLocatorHash: string;
  domain: typeof SWARM_HOSTED_TRANSPORT_DOMAIN;
}

export interface BuiltSwarmHostedEnvelope {
  envelope: SwarmHostedEnvelope;
  canonicalBody: string;
  payloadSha256: string;
  envelopeIdentity: string;
  transportKey: SwarmHostedTransportKeyLocator;
}

export interface BuildSwarmHostedEnvelopeDependencies {
  readOperationalState(input: { runsRoot: string; swarmId: string }): Promise<SwarmOperationalState>;
  readReceiptProjection(input: { runsRoot: string; swarmId: string }): Promise<SwarmReceiptProjection>;
  ensureHostedTransportKey(input: { runsRoot: string; swarmId: string }): Promise<{
    secret: string;
    keyId: string;
  }>;
}

const productionDependencies: BuildSwarmHostedEnvelopeDependencies = {
  readOperationalState: (input) => readSwarmOperationalState(input),
  readReceiptProjection: (input) => readSwarmReceiptProjection(input),
  ensureHostedTransportKey: deriveHostedTransportKeyMaterial,
};

/** @internal Direct-module seam for proving derivation never creates another secret file. */
export async function deriveHostedTransportKeyMaterial(input: {
  runsRoot: string;
  swarmId: string;
}): Promise<{ secret: string; keyId: string }> {
  try {
    return await deriveSwarmHostedTransportKeyMaterialFromReceipt({
      ...input,
      domain: SWARM_HOSTED_TRANSPORT_DOMAIN,
    });
  } catch {
    throw hostedError("SWARM_HOSTED_KEY_UNAVAILABLE", "Authenticated receipt key material is unavailable for hosted derivation.");
  }
}

export async function buildSwarmHostedEnvelope(
  input: BuildSwarmHostedEnvelopeInput,
): Promise<BuiltSwarmHostedEnvelope> {
  return buildSwarmHostedEnvelopeWithDependencies(input, productionDependencies);
}

export async function buildSwarmHostedEnvelopeWithDependencies(
  input: BuildSwarmHostedEnvelopeInput,
  dependencies: BuildSwarmHostedEnvelopeDependencies,
): Promise<BuiltSwarmHostedEnvelope> {
  const selector = { runsRoot: input.runsRoot, swarmId: input.swarmId };
  const [operational, projection] = await Promise.all([
    dependencies.readOperationalState(selector),
    dependencies.readReceiptProjection(selector),
  ]);
  assertAuthenticatedSource(input, operational, projection);

  const unsigned = projectEnvelope(input.runtimeVersion, operational, projection);
  const key = await dependencies.ensureHostedTransportKey(selector);
  const keyLocatorHash = sha256(`${SWARM_HOSTED_TRANSPORT_DOMAIN}\n${input.swarmId}\n${key.keyId}\n`);
  const envelopeWithLocator: SwarmHostedEnvelope = {
    ...unsigned,
    transportSignature: {
      algorithm: "hmac-sha256",
      keyId: key.keyId,
      keyLocatorHash,
      signatureHmacSha256: "0".repeat(64),
    },
  };
  envelopeWithLocator.envelopeId = computeSwarmHostedEnvelopeIdentity(envelopeWithLocator);
  const signatureHmacSha256 = createHmac("sha256", key.secret)
    .update(`${SWARM_HOSTED_TRANSPORT_DOMAIN}\n${canonicalSwarmHostedTransportBytes(envelopeWithLocator)}`)
    .digest("hex");
  const envelope: SwarmHostedEnvelope = {
    ...envelopeWithLocator,
    transportSignature: { ...envelopeWithLocator.transportSignature, signatureHmacSha256 },
  };
  const validation = validateSwarmHostedEnvelope(envelope);
  if (!validation.ok) {
    throw hostedError(
      "SWARM_HOSTED_PROJECTION_INVALID",
      `Hosted swarm projection failed validation: ${validation.errors.map((error) => `${error.code}:${error.path}`).join(",")}`,
    );
  }
  const canonicalBody = `${JSON.stringify(envelope)}\n`;
  return {
    envelope,
    canonicalBody,
    payloadSha256: sha256(canonicalBody),
    envelopeIdentity: envelope.envelopeId,
    transportKey: { keyId: key.keyId, keyLocatorHash, domain: SWARM_HOSTED_TRANSPORT_DOMAIN },
  };
}

function projectEnvelope(
  runtimeVersion: string,
  operational: SwarmOperationalState,
  projection: SwarmReceiptProjection,
): SwarmHostedEnvelope {
  const { plan } = operational;
  const { receipt, integrity } = projection;
  const childReceiptById = new Map(receipt.childReceipts.map((child) => [child.childRunId, child]));
  const events = receipt.events.map((event) => projectEvent(event, childReceiptById));
  const eventById = new Map(events.map((event) => [event.eventId, event]));
  const plannedTaskAgent = new Map(plan.tasks.map((task) => [task.taskId, task.assignedAgentId]));
  const effectiveTaskAgent = new Map(receipt.tasks.map((task) => [task.taskId, task.assignedAgentId]));
  const agentTasks = new Map(receipt.agents.map((agent) => [agent.agentId, new Set(agent.contract.taskIds)]));
  for (const task of receipt.tasks) {
    for (const agentId of [plannedTaskAgent.get(task.taskId), effectiveTaskAgent.get(task.taskId)]) {
      if (agentId) agentTasks.get(agentId)?.add(task.taskId);
    }
  }
  const agentById = new Map(receipt.agents.map((agent) => [agent.agentId, agent]));

  const parentEvent = findSingleEvent(events, parentTerminalType(receipt.parentOutcome.state), undefined);
  const globalEvent = receipt.globalVerificationId
    ? findSingleEvent(
      events,
      receipt.taskVerificationState === "passed" ? "GLOBAL_VERIFIER_PASSED" : "GLOBAL_VERIFIER_FAILED",
      receipt.globalVerificationId,
    )
    : undefined;

  const envelope: SwarmHostedEnvelope = {
    schemaVersion: SWARM_HOSTED_SCHEMA_VERSION,
    envelopeId: "0".repeat(64),
    sourceSchemas: {
      swarm: SWARM_SCHEMA_VERSION,
      receipt: SWARM_PARENT_RECEIPT_SCHEMA_VERSION,
      evidenceIndex: SWARM_EVIDENCE_INDEX_SCHEMA_VERSION,
    },
    sourceIdentities: {
      receiptId: receipt.receiptId,
      receiptSha256: receipt.receiptSha256,
      evidenceIndexSha256: receipt.evidenceIndexSha256,
      eventChainSha256: integrity.eventChainHead!,
    },
    runtimeVersion,
    createdAt: receipt.sealedAt,
    swarm: {
      swarmId: receipt.swarmId,
      workspaceId: plan.workspaceId,
      projectId: plan.projectId,
      planHash: receipt.planHash,
      baselineCommit: receipt.baselineCommit,
    },
    topology: {
      tasks: receipt.tasks.map((task) => ({
        taskId: task.taskId,
        required: task.required,
        dependsOn: [...task.dependsOn],
        ...(plannedTaskAgent.get(task.taskId) ? { plannedAgentId: plannedTaskAgent.get(task.taskId) } : {}),
        ...(task.assignedAgentId ? { effectiveAgentId: task.assignedAgentId } : {}),
        status: task.status,
      })),
      agents: receipt.agents.map((agent) => ({
        agentId: agent.agentId,
        role: agent.role,
        status: agent.status,
        taskIds: [...(agentTasks.get(agent.agentId) ?? [])].sort(),
        ...(agent.childRunId ? { childRunId: agent.childRunId } : {}),
      })),
      children: receipt.childReceipts.map((child) => {
        const agent = agentById.get(child.agentId);
        const evidence = events
          .filter((event) => event.childRunId === child.childRunId
            && event.agentId === child.agentId
            && event.attemptId === child.attemptId
            && (event.taskId === undefined || child.taskIds.includes(event.taskId)))
          .map(eventReference);
        return {
          childRunId: child.childRunId,
          agentId: child.agentId,
          attemptId: child.attemptId,
          taskIds: [...child.taskIds],
          status: agent?.status ?? "needs_review",
          receiptIntegrityState: "verified" as const,
          evidence,
        };
      }),
    },
    budget: {
      capUsd: receipt.budgetLedger.capUsd,
      ...(receipt.budgetLedger.capTokens !== undefined ? { capTokens: receipt.budgetLedger.capTokens } : {}),
      settledUsd: receipt.budgetLedger.settledUsd,
      settledTokens: receipt.budgetLedger.settledTokens,
    },
    interventions: {
      blockedActions: receipt.blockedActions.map((action) => ({
        action: action.action,
        reasonCode: action.reason,
        taskId: action.taskId,
        agentId: action.agentId,
        attemptId: action.attemptId,
        evidence: [{ eventId: action.eventId, sequence: action.sequence }],
      })),
      reassignments: receipt.reassignments.map((reassignment) => ({
        taskId: reassignment.taskId,
        fromAgentId: reassignment.fromAgentId,
        toAgentId: reassignment.toAgentId,
        fromAttemptId: reassignment.fromAttemptId,
        toAttemptId: reassignment.toAttemptId,
        reasonCode: reassignment.reason,
        evidence: [{ eventId: reassignment.eventId, sequence: reassignment.sequence }],
      })),
    },
    integration: {
      admissions: integrationDecisions(events, "CHILD_PATCH_ADMITTED", "admitted"),
      rejections: integrationDecisions(events, "CHILD_PATCH_REJECTED", "rejected"),
      conflicts: integrationConflicts(events),
      ...(receipt.integratedTreeHash ? { integratedTreeHash: receipt.integratedTreeHash } : {}),
    },
    events,
    globalVerification: globalEvent ? {
      state: receipt.taskVerificationState === "passed" ? "passed" : "failed",
      verificationId: receipt.globalVerificationId!,
      ...(receipt.integratedTreeHash ? { integratedTreeHash: receipt.integratedTreeHash } : {}),
      evidence: [eventReference(globalEvent)],
    } : {
      state: "unknown",
      evidence: [],
    },
    parentOutcome: {
      state: receipt.parentOutcome.state,
      source: "sealed_parent_receipt",
      evidence: [eventReference(parentEvent)],
    },
    taskVerificationState: receipt.taskVerificationState,
    receiptIntegrityState: "verified",
    transportSignature: {
      algorithm: "hmac-sha256",
      keyId: "pending",
      keyLocatorHash: "0".repeat(64),
      signatureHmacSha256: "0".repeat(64),
    },
  };
  for (const reference of allEvidenceReferences(envelope)) {
    if (!eventById.has(reference.eventId)) {
      throw hostedError("SWARM_HOSTED_SOURCE_MISMATCH", "Hosted evidence reference does not resolve to an authenticated event.");
    }
  }
  return envelope;
}

function assertAuthenticatedSource(
  input: BuildSwarmHostedEnvelopeInput,
  operational: SwarmOperationalState,
  projection: SwarmReceiptProjection,
): void {
  const { plan, snapshot, events } = operational;
  const { receipt, integrity, seal } = projection;
  if (integrity.state !== "verified"
    || !integrity.receiptSha256
    || !integrity.evidenceIndexSha256
    || !integrity.eventChainHead) {
    throw hostedError("SWARM_HOSTED_INTEGRITY_NOT_VERIFIED", "Committed swarm receipt integrity is not verified.");
  }
  if (plan.schemaVersion !== SWARM_SCHEMA_VERSION
    || receipt.schemaVersion !== SWARM_PARENT_RECEIPT_SCHEMA_VERSION
    || seal.schemaVersion !== "martin.swarm-receipt-seal.v1") {
    throw hostedError("SWARM_HOSTED_UNSUPPORTED_SOURCE", "Swarm hosted export source schema is unsupported.");
  }
  if (input.swarmId !== plan.swarmId
    || computeSwarmLivePlanHash(plan) !== plan.planHash
    || receipt.swarmId !== plan.swarmId
    || seal.swarmId !== plan.swarmId
    || receipt.planHash !== plan.planHash
    || seal.planHash !== plan.planHash
    || receipt.baselineCommit !== plan.baselineCommit
    || receipt.evidenceIndexSha256 !== integrity.evidenceIndexSha256
    || receipt.receiptSha256 !== integrity.receiptSha256
    || integrity.taskVerificationState !== receipt.taskVerificationState
    || seal.evidenceIndexSha256 !== receipt.evidenceIndexSha256
    || seal.committedAt !== receipt.sealedAt
    || snapshot.outcome.state !== receipt.parentOutcome.state
    || stableJson(events) !== stableJson(receipt.events)) {
    throw hostedError("SWARM_HOSTED_SOURCE_MISMATCH", "Committed swarm source identities disagree.");
  }
}

function projectEvent(
  event: SwarmLiveEvent,
  childReceiptById: ReadonlyMap<string, SwarmParentReceipt["childReceipts"][number]>,
): SwarmHostedEvent {
  const payload = event.payload;
  const hasExplicitAttemptId = Object.prototype.hasOwnProperty.call(payload, "attemptId");
  if (hasExplicitAttemptId
    && (typeof payload.attemptId !== "string" || payload.attemptId.length === 0)) {
    throw hostedError(
      "SWARM_HOSTED_SOURCE_MISMATCH",
      "Present child attempt identity must be a non-empty string; only true omission may use receipt linkage.",
    );
  }
  const explicitAttemptId = text(payload.attemptId)
    ?? (event.type === "TASK_REASSIGNED" ? text(payload.fromAttemptId) : undefined);
  let attemptId = explicitAttemptId;
  if (event.childRunId && event.type.startsWith("CHILD_")) {
    const child = childReceiptById.get(event.childRunId);
    if (!child
      || event.agentId !== child.agentId
      || (event.taskId !== undefined && !child.taskIds.includes(event.taskId))
      || (explicitAttemptId !== undefined && explicitAttemptId !== child.attemptId)) {
      throw hostedError(
        "SWARM_HOSTED_SOURCE_MISMATCH",
        "Child lifecycle event identities contradict authenticated child receipt linkage.",
      );
    }
    attemptId = child.attemptId;
  }
  const relatedAttemptId = text(payload.toAttemptId);
  const toAgentId = text(payload.toAgentId);
  const candidateId = text(payload.candidateId);
  const verificationId = text(payload.verificationId);
  return {
    eventId: event.idempotencyKey,
    sourceIdempotencyKey: event.idempotencyKey,
    sequence: event.sequence,
    type: event.type,
    timestamp: event.timestamp,
    ...(event.taskId ? { taskId: event.taskId } : {}),
    ...(event.agentId ? { agentId: event.type === "TASK_REASSIGNED" ? text(payload.fromAgentId) ?? event.agentId : event.agentId } : {}),
    ...(event.childRunId ? { childRunId: event.childRunId } : {}),
    ...(attemptId ? { attemptId } : {}),
    ...(relatedAttemptId ? { relatedAttemptId } : {}),
    ...(toAgentId ? { toAgentId } : {}),
    ...(candidateId ? { candidateId } : {}),
    ...(verificationId ? { verificationId } : {}),
    ...(event.failureClass ? { failureClass: event.failureClass } : {}),
  };
}

function integrationDecisions(
  events: SwarmHostedEvent[],
  type: "CHILD_PATCH_ADMITTED" | "CHILD_PATCH_REJECTED",
  state: "admitted" | "rejected",
): SwarmHostedIntegrationDecision[] {
  return events.filter((event) => event.type === type).map((event) => {
    if (!event.candidateId || !event.taskId || !event.agentId || !event.childRunId) {
      throw hostedError("SWARM_HOSTED_SOURCE_MISMATCH", "Integration event lacks authenticated hosted identities.");
    }
    return {
      candidateId: event.candidateId,
      taskId: event.taskId,
      agentId: event.agentId,
      childRunId: event.childRunId,
      state,
      evidence: [eventReference(event)],
    };
  });
}

function integrationConflicts(events: SwarmHostedEvent[]): SwarmHostedConflict[] {
  return events.filter((event) => event.type === "INTEGRATION_CONFLICT").map((event) => ({
    conflictId: event.candidateId ?? event.eventId,
    taskIds: event.taskId ? [event.taskId] : [],
    state: "blocking",
    evidence: [eventReference(event)],
  }));
}

function findSingleEvent(
  events: SwarmHostedEvent[],
  type: SwarmHostedEvent["type"],
  identity: string | undefined,
): SwarmHostedEvent {
  const matches = events.filter((event) => event.type === type
    && (identity === undefined || event.verificationId === identity));
  if (matches.length !== 1) {
    throw hostedError("SWARM_HOSTED_SOURCE_MISMATCH", `Expected one authoritative ${type} event.`);
  }
  return matches[0]!;
}

function parentTerminalType(state: "verified" | "stopped" | "needs_review"): SwarmHostedEvent["type"] {
  return state === "verified" ? "SWARM_VERIFIED" : state === "stopped" ? "SWARM_STOPPED" : "SWARM_NEEDS_REVIEW";
}

function eventReference(event: SwarmHostedEvent): SwarmHostedEvidenceReference {
  return { eventId: event.eventId, sequence: event.sequence };
}

function allEvidenceReferences(envelope: SwarmHostedEnvelope): SwarmHostedEvidenceReference[] {
  return [
    ...envelope.topology.children.flatMap((child) => child.evidence),
    ...envelope.interventions.blockedActions.flatMap((action) => action.evidence),
    ...envelope.interventions.reassignments.flatMap((reassignment) => reassignment.evidence),
    ...envelope.integration.admissions.flatMap((decision) => decision.evidence),
    ...envelope.integration.rejections.flatMap((decision) => decision.evidence),
    ...envelope.integration.conflicts.flatMap((conflict) => conflict.evidence),
    ...envelope.globalVerification.evidence,
    ...envelope.parentOutcome.evidence,
  ];
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function hostedError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(`${code}: ${message}`), { code });
}
