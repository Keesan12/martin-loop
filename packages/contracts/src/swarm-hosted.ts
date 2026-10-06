import { createHash } from "node:crypto";

import { FAILURE_CLASSES, type FailureClass, type ReceiptIntegrityState } from "./index.js";
import {
  SWARM_EVENT_TYPES,
  SWARM_PARENT_RECEIPT_SCHEMA_VERSION,
  SWARM_SCHEMA_VERSION,
  type SwarmAgentStatus,
  type SwarmEventType,
  type SwarmOutcomeState,
  type SwarmTaskStatus,
  type SwarmValidationError,
  type SwarmValidationResult,
} from "./swarm.js";

export const SWARM_HOSTED_SCHEMA_VERSION = "martin.swarm-hosted.v1" as const;
export const SWARM_EVIDENCE_INDEX_SCHEMA_VERSION = "martin.swarm-evidence-index.v1" as const;

export type SwarmHostedTaskVerificationState = "passed" | "failed" | "unknown";
export type SwarmHostedGlobalVerificationState = "passed" | "failed" | "unknown";
export type SwarmTraceDerivationKind = "observed" | "deterministic_graph_derivation";
export type SwarmTraceFactKind =
  | "blocking_dependency"
  | "failure"
  | "reassignment"
  | "recovery"
  | "verification_boundary";

export interface SwarmHostedEvidenceReference {
  eventId: string;
  sequence: number;
}

export interface SwarmHostedTask {
  taskId: string;
  required: boolean;
  dependsOn: string[];
  plannedAgentId?: string;
  effectiveAgentId?: string;
  status: SwarmTaskStatus;
}

export interface SwarmHostedAgent {
  agentId: string;
  role: string;
  status: SwarmAgentStatus;
  taskIds: string[];
  childRunId?: string;
}

export interface SwarmHostedChild {
  childRunId: string;
  agentId: string;
  attemptId: string;
  taskIds: string[];
  status: SwarmAgentStatus;
  receiptIntegrityState: ReceiptIntegrityState;
  evidence: SwarmHostedEvidenceReference[];
}

export interface SwarmHostedEvent {
  eventId: string;
  /** Exact persisted Phase 4 event idempotencyKey, retained to make the hosted rename checkable. */
  sourceIdempotencyKey: string;
  sequence: number;
  type: SwarmEventType;
  timestamp: string;
  taskId?: string;
  agentId?: string;
  childRunId?: string;
  attemptId?: string;
  relatedAttemptId?: string;
  toAgentId?: string;
  candidateId?: string;
  verificationId?: string;
  failureClass?: FailureClass;
}

export interface SwarmHostedBlockedAction {
  action: string;
  reasonCode: string;
  taskId: string;
  agentId: string;
  attemptId: string;
  evidence: SwarmHostedEvidenceReference[];
}

export interface SwarmHostedReassignment {
  taskId: string;
  fromAgentId: string;
  toAgentId: string;
  fromAttemptId: string;
  toAttemptId: string;
  reasonCode: string;
  evidence: SwarmHostedEvidenceReference[];
}

export interface SwarmHostedIntegrationDecision {
  candidateId: string;
  taskId: string;
  agentId: string;
  childRunId: string;
  state: "admitted" | "rejected";
  evidence: SwarmHostedEvidenceReference[];
}

export interface SwarmHostedConflict {
  conflictId: string;
  taskIds: string[];
  state: "detected" | "resolved" | "blocking";
  evidence: SwarmHostedEvidenceReference[];
}

export interface SwarmHostedEnvelope {
  schemaVersion: typeof SWARM_HOSTED_SCHEMA_VERSION;
  envelopeId: string;
  sourceSchemas: {
    swarm: typeof SWARM_SCHEMA_VERSION;
    receipt: typeof SWARM_PARENT_RECEIPT_SCHEMA_VERSION;
    evidenceIndex: typeof SWARM_EVIDENCE_INDEX_SCHEMA_VERSION;
  };
  sourceIdentities: {
    receiptId: string;
    receiptSha256: string;
    evidenceIndexSha256: string;
    eventChainSha256: string;
  };
  runtimeVersion: string;
  createdAt: string;
  swarm: {
    swarmId: string;
    workspaceId: string;
    projectId: string;
    planHash: string;
    baselineCommit: string;
  };
  topology: {
    tasks: SwarmHostedTask[];
    agents: SwarmHostedAgent[];
    children: SwarmHostedChild[];
  };
  budget: {
    capUsd: number;
    capTokens?: number;
    settledUsd: number;
    settledTokens: number;
  };
  interventions: {
    blockedActions: SwarmHostedBlockedAction[];
    reassignments: SwarmHostedReassignment[];
  };
  integration: {
    admissions: SwarmHostedIntegrationDecision[];
    rejections: SwarmHostedIntegrationDecision[];
    conflicts: SwarmHostedConflict[];
    integratedTreeHash?: string;
  };
  events: SwarmHostedEvent[];
  globalVerification: {
    state: SwarmHostedGlobalVerificationState;
    verificationId?: string;
    integratedTreeHash?: string;
    evidence: SwarmHostedEvidenceReference[];
  };
  parentOutcome: {
    state: Exclude<SwarmOutcomeState, "running">;
    source: "sealed_parent_receipt";
    evidence: SwarmHostedEvidenceReference[];
  };
  taskVerificationState: SwarmHostedTaskVerificationState;
  receiptIntegrityState: ReceiptIntegrityState;
  transportSignature: {
    algorithm: "hmac-sha256";
    keyId: string;
    keyLocatorHash: string;
    signatureHmacSha256: string;
  };
  extensions?: Record<string, unknown>;
}

export interface SwarmAtlasView {
  schemaVersion: "martin.swarm-atlas-view.v1";
  envelopeId: string;
  sourceIdentities: SwarmHostedEnvelope["sourceIdentities"];
  swarm: SwarmHostedEnvelope["swarm"];
  tasks: SwarmHostedTask[];
  dependencyEdges: Array<{ fromTaskId: string; toTaskId: string }>;
  agents: SwarmHostedAgent[];
  children: SwarmHostedChild[];
  budget: SwarmHostedEnvelope["budget"];
  interventions: SwarmHostedEnvelope["interventions"];
  integration: SwarmHostedEnvelope["integration"];
  globalVerification: SwarmHostedEnvelope["globalVerification"];
  parentOutcome: SwarmHostedEnvelope["parentOutcome"];
  taskVerificationState: SwarmHostedTaskVerificationState;
  receiptIntegrityState: ReceiptIntegrityState;
}

export interface SwarmTraceFact {
  factId: string;
  kind: SwarmTraceFactKind;
  derivationKind: SwarmTraceDerivationKind;
  taskIds: string[];
  agentIds: string[];
  childRunIds: string[];
  attemptIds: string[];
  verificationIds: string[];
  evidence: SwarmHostedEvidenceReference[];
}

export interface SwarmSansaView {
  schemaVersion: "martin.swarm-sansa-view.v1";
  envelopeId: string;
  sourceIdentities: SwarmHostedEnvelope["sourceIdentities"];
  facts: SwarmTraceFact[];
  parentOutcome: SwarmHostedEnvelope["parentOutcome"];
  globalVerification: SwarmHostedEnvelope["globalVerification"];
}

export interface SwarmDashboardView {
  schemaVersion: "martin.swarm-dashboard-view.v1";
  envelopeId: string;
  sourceIdentities: SwarmHostedEnvelope["sourceIdentities"];
  swarmId: string;
  children: SwarmHostedChild[];
  parentOutcome: SwarmHostedEnvelope["parentOutcome"];
  globalVerification: SwarmHostedEnvelope["globalVerification"];
  taskVerificationState: SwarmHostedTaskVerificationState;
  receiptIntegrityState: ReceiptIntegrityState;
  budget: SwarmHostedEnvelope["budget"];
}

export function canonicalSwarmHostedTransportBytes(envelope: SwarmHostedEnvelope): string {
  const { transportSignature: _signature, ...unsigned } = envelope;
  return `${JSON.stringify(sortJson(unsigned))}\n`;
}

export function computeSwarmHostedEnvelopeIdentity(envelope: SwarmHostedEnvelope): string {
  const { envelopeId: _identity, transportSignature: _signature, ...identityMaterial } = envelope;
  return createHash("sha256").update(JSON.stringify(sortJson(identityMaterial))).digest("hex");
}

export function validateSwarmHostedEnvelope(value: unknown): SwarmValidationResult {
  const errors: SwarmValidationError[] = [];
  if (!isRecord(value)) {
    add(errors, "INVALID_HOSTED_ENVELOPE", "envelope", "must be an object");
    return invalid(errors);
  }
  exactKeys(value, [
    "schemaVersion", "envelopeId", "sourceSchemas", "sourceIdentities", "runtimeVersion", "createdAt", "swarm", "topology",
    "budget", "interventions", "integration", "events", "globalVerification", "parentOutcome",
    "taskVerificationState", "receiptIntegrityState", "transportSignature", "extensions",
  ], "envelope", errors);
  equal(value.schemaVersion, SWARM_HOSTED_SCHEMA_VERSION, "schemaVersion", errors);
  hex(value.envelopeId, 64, "envelopeId", errors);
  safeIdentifier(value.runtimeVersion, "runtimeVersion", errors);
  timestamp(value.createdAt, "createdAt", errors);

  const schemas = object(value.sourceSchemas, "sourceSchemas", errors);
  if (schemas) {
    exactKeys(schemas, ["swarm", "receipt", "evidenceIndex"], "sourceSchemas", errors);
    equal(schemas.swarm, SWARM_SCHEMA_VERSION, "sourceSchemas.swarm", errors);
    equal(schemas.receipt, SWARM_PARENT_RECEIPT_SCHEMA_VERSION, "sourceSchemas.receipt", errors);
    equal(schemas.evidenceIndex, SWARM_EVIDENCE_INDEX_SCHEMA_VERSION, "sourceSchemas.evidenceIndex", errors);
  }
  const sourceIdentities = object(value.sourceIdentities, "sourceIdentities", errors);
  if (sourceIdentities) {
    exactKeys(sourceIdentities, ["receiptId", "receiptSha256", "evidenceIndexSha256", "eventChainSha256"], "sourceIdentities", errors);
    safeIdentifier(sourceIdentities.receiptId, "sourceIdentities.receiptId", errors);
    hex(sourceIdentities.receiptSha256, 64, "sourceIdentities.receiptSha256", errors);
    hex(sourceIdentities.evidenceIndexSha256, 64, "sourceIdentities.evidenceIndexSha256", errors);
    hex(sourceIdentities.eventChainSha256, 64, "sourceIdentities.eventChainSha256", errors);
  }
  const swarm = object(value.swarm, "swarm", errors);
  if (swarm) {
    exactKeys(swarm, ["swarmId", "workspaceId", "projectId", "planHash", "baselineCommit"], "swarm", errors);
    for (const key of ["swarmId", "workspaceId", "projectId"] as const) safeIdentifier(swarm[key], `swarm.${key}`, errors);
    hex(swarm.planHash, 64, "swarm.planHash", errors);
    hex(swarm.baselineCommit, 40, "swarm.baselineCommit", errors);
  }

  const topology = object(value.topology, "topology", errors);
  const tasks = topology ? array(topology.tasks, "topology.tasks", errors) : [];
  const agents = topology ? array(topology.agents, "topology.agents", errors) : [];
  const children = topology ? array(topology.children, "topology.children", errors) : [];
  if (topology) exactKeys(topology, ["tasks", "agents", "children"], "topology", errors);
  if (tasks.length === 0) add(errors, "EMPTY_HOSTED_TASKS", "topology.tasks", "must contain at least one task");
  if (agents.length === 0) add(errors, "EMPTY_HOSTED_AGENTS", "topology.agents", "must contain at least one agent");
  if (children.length === 0) add(errors, "EMPTY_HOSTED_CHILDREN", "topology.children", "must contain at least one child");

  const taskIds = new Set<string>();
  tasks.forEach((item, index) => validateTask(item, index, taskIds, errors));
  const agentIds = new Set<string>();
  agents.forEach((item, index) => validateAgent(item, index, agentIds, taskIds, errors));
  tasks.forEach((item, index) => validateTaskLinks(item, index, taskIds, agentIds, errors));

  const eventList = array(value.events, "events", errors);
  const events = new Map<string, SwarmHostedEvent>();
  eventList.forEach((item, index) => validateEvent(item, index, events, taskIds, agentIds, errors));
  for (let index = 0; index < eventList.length; index += 1) {
    const event = eventList[index] as Record<string, unknown> | undefined;
    if (event?.sequence !== index + 1) add(errors, "NON_CONTIGUOUS_HOSTED_EVENTS", `events[${index}].sequence`, `must equal ${index + 1}`);
  }

  const childRunIds = new Set<string>();
  children.forEach((item, index) => validateChild(item, index, childRunIds, taskIds, agentIds, events, errors));
  eventList.forEach((item, index) => validateEventChildLink(item, index, childRunIds, errors));
  validateTopologyConsistency(tasks, agents, children, eventList, events, errors);

  validateBudget(value.budget, errors);
  validateInterventions(value.interventions, taskIds, agentIds, events, errors);
  validateIntegration(value.integration, taskIds, agentIds, childRunIds, events, errors);
  validateGlobal(value.globalVerification, events, errors);
  validateParent(value.parentOutcome, events, errors);
  validateLatestGlobalAuthority(value.globalVerification, value.parentOutcome, eventList, errors);
  const integration = isRecord(value.integration) ? value.integration : undefined;
  const globalVerification = isRecord(value.globalVerification) ? value.globalVerification : undefined;
  if (typeof integration?.integratedTreeHash === "string"
    && typeof globalVerification?.integratedTreeHash === "string"
    && integration.integratedTreeHash !== globalVerification.integratedTreeHash) {
    add(errors, "HOSTED_INTEGRATED_TREE_MISMATCH", "globalVerification.integratedTreeHash", "must match the exact integrated tree verified by the parent");
  }
  enumValue(value.taskVerificationState, ["passed", "failed", "unknown"], "taskVerificationState", errors);
  enumValue(value.receiptIntegrityState, RECEIPT_INTEGRITY_STATES, "receiptIntegrityState", errors);
  validateSignature(value.transportSignature, errors);
  validateExtensions(value.extensions, errors);

  const parent = isRecord(value.parentOutcome) ? value.parentOutcome : undefined;
  const global = isRecord(value.globalVerification) ? value.globalVerification : undefined;
  if (parent?.state === "verified" && (
    global?.state !== "passed"
    || value.taskVerificationState !== "passed"
    || value.receiptIntegrityState !== "verified"
  )) {
    add(errors, "INVALID_HOSTED_AUTHORITY_BINDING", "parentOutcome.state", "verified parent requires persisted passed task/global states and verified receipt integrity");
  }
  if (errors.length === 0) {
    const envelope = value as unknown as SwarmHostedEnvelope;
    if (envelope.envelopeId !== computeSwarmHostedEnvelopeIdentity(envelope)) {
      add(errors, "HOSTED_ENVELOPE_ID_MISMATCH", "envelopeId", "must bind the canonical hosted identity material");
    }
  }
  return errors.length === 0 ? { ok: true, errors: [] } : invalid(errors);
}

const RECEIPT_INTEGRITY_STATES: ReceiptIntegrityState[] = [
  "verified", "unsigned", "tamper_detected", "relocated", "material_missing", "selector_noncanonical",
];
const TASK_STATUSES: SwarmTaskStatus[] = ["queued", "ready", "running", "accepted", "rejected", "stopped", "needs_review"];
const AGENT_STATUSES: SwarmAgentStatus[] = ["queued", "running", "verified", "stopped", "needs_review"];

function validateTask(value: unknown, index: number, ids: Set<string>, errors: SwarmValidationError[]): void {
  const path = `topology.tasks[${index}]`;
  const item = object(value, path, errors);
  if (!item) return;
  exactKeys(item, ["taskId", "required", "dependsOn", "plannedAgentId", "effectiveAgentId", "status"], path, errors);
  uniqueIdentifier(item.taskId, `${path}.taskId`, ids, errors);
  if (typeof item.required !== "boolean") add(errors, "INVALID_HOSTED_BOOLEAN", `${path}.required`, "must be boolean");
  stringArray(item.dependsOn, `${path}.dependsOn`, errors);
  optionalIdentifier(item.plannedAgentId, `${path}.plannedAgentId`, errors);
  optionalIdentifier(item.effectiveAgentId, `${path}.effectiveAgentId`, errors);
  enumValue(item.status, TASK_STATUSES, `${path}.status`, errors);
}

function validateTaskLinks(value: unknown, index: number, taskIds: Set<string>, agentIds: Set<string>, errors: SwarmValidationError[]): void {
  if (!isRecord(value)) return;
  for (const [depIndex, dependency] of (Array.isArray(value.dependsOn) ? value.dependsOn : []).entries()) {
    if (!taskIds.has(String(dependency)) || dependency === value.taskId) add(errors, "DANGLING_HOSTED_TASK_LINK", `topology.tasks[${index}].dependsOn[${depIndex}]`, "must reference another hosted task");
  }
  for (const field of ["plannedAgentId", "effectiveAgentId"] as const) {
    if (typeof value[field] === "string" && !agentIds.has(value[field])) add(errors, "DANGLING_HOSTED_AGENT_LINK", `topology.tasks[${index}].${field}`, "must reference a hosted agent");
  }
}

function validateAgent(value: unknown, index: number, ids: Set<string>, taskIds: Set<string>, errors: SwarmValidationError[]): void {
  const path = `topology.agents[${index}]`;
  const item = object(value, path, errors);
  if (!item) return;
  exactKeys(item, ["agentId", "role", "status", "taskIds", "childRunId"], path, errors);
  uniqueIdentifier(item.agentId, `${path}.agentId`, ids, errors);
  safeIdentifier(item.role, `${path}.role`, errors);
  enumValue(item.status, AGENT_STATUSES, `${path}.status`, errors);
  linkedStringArray(item.taskIds, `${path}.taskIds`, taskIds, errors);
  optionalIdentifier(item.childRunId, `${path}.childRunId`, errors);
}

function validateChild(value: unknown, index: number, ids: Set<string>, taskIds: Set<string>, agentIds: Set<string>, events: Map<string, SwarmHostedEvent>, errors: SwarmValidationError[]): void {
  const path = `topology.children[${index}]`;
  const item = object(value, path, errors);
  if (!item) return;
  exactKeys(item, ["childRunId", "agentId", "attemptId", "taskIds", "status", "receiptIntegrityState", "evidence"], path, errors);
  uniqueIdentifier(item.childRunId, `${path}.childRunId`, ids, errors);
  linkedText(item.agentId, `${path}.agentId`, agentIds, errors);
  safeIdentifier(item.attemptId, `${path}.attemptId`, errors);
  linkedStringArray(item.taskIds, `${path}.taskIds`, taskIds, errors);
  enumValue(item.status, AGENT_STATUSES, `${path}.status`, errors);
  enumValue(item.receiptIntegrityState, RECEIPT_INTEGRITY_STATES, `${path}.receiptIntegrityState`, errors);
  validateEvidence(item.evidence, `${path}.evidence`, events, errors);
}

function validateEvent(value: unknown, index: number, events: Map<string, SwarmHostedEvent>, taskIds: Set<string>, agentIds: Set<string>, errors: SwarmValidationError[]): void {
  const path = `events[${index}]`;
  const item = object(value, path, errors);
  if (!item) return;
  exactKeys(item, ["eventId", "sourceIdempotencyKey", "sequence", "type", "timestamp", "taskId", "agentId", "childRunId", "attemptId", "relatedAttemptId", "toAgentId", "candidateId", "verificationId", "failureClass"], path, errors);
  safeIdentifier(item.eventId, `${path}.eventId`, errors);
  safeIdentifier(item.sourceIdempotencyKey, `${path}.sourceIdempotencyKey`, errors);
  if (typeof item.eventId === "string" && item.eventId.length > 0) {
    if (events.has(item.eventId)) add(errors, "DUPLICATE_HOSTED_EVENT_ID", `${path}.eventId`, "must be unique");
    else events.set(item.eventId, item as unknown as SwarmHostedEvent);
  }
  if (item.eventId !== item.sourceIdempotencyKey) add(errors, "HOSTED_EVENT_IDEMPOTENCY_MISMATCH", `${path}.sourceIdempotencyKey`, "must exactly match the persisted event idempotency identity");
  integer(item.sequence, `${path}.sequence`, errors);
  enumValue(item.type, SWARM_EVENT_TYPES, `${path}.type`, errors);
  timestamp(item.timestamp, `${path}.timestamp`, errors);
  optionalLinkedText(item.taskId, `${path}.taskId`, taskIds, errors);
  optionalLinkedText(item.agentId, `${path}.agentId`, agentIds, errors);
  for (const key of ["childRunId", "attemptId", "relatedAttemptId", "candidateId", "verificationId"] as const) optionalIdentifier(item[key], `${path}.${key}`, errors);
  optionalLinkedText(item.toAgentId, `${path}.toAgentId`, agentIds, errors);
  if (item.failureClass !== undefined) enumValue(item.failureClass, FAILURE_CLASSES, `${path}.failureClass`, errors);
  validateEventTypeIdentities(item, path, errors);
}

function validateEventChildLink(value: unknown, index: number, childIds: Set<string>, errors: SwarmValidationError[]): void {
  if (isRecord(value) && typeof value.childRunId === "string" && !childIds.has(value.childRunId)) add(errors, "DANGLING_HOSTED_CHILD_LINK", `events[${index}].childRunId`, "must reference a hosted child");
}

function validateTopologyConsistency(
  rawTasks: unknown[],
  rawAgents: unknown[],
  rawChildren: unknown[],
  rawEvents: unknown[],
  events: Map<string, SwarmHostedEvent>,
  errors: SwarmValidationError[],
): void {
  const tasks = new Map(rawTasks.filter(isRecord).filter((task) => typeof task.taskId === "string").map((task) => [task.taskId as string, task]));
  const agents = new Map(rawAgents.filter(isRecord).filter((agent) => typeof agent.agentId === "string").map((agent) => [agent.agentId as string, agent]));
  const children = new Map(rawChildren.filter(isRecord).filter((child) => typeof child.childRunId === "string").map((child) => [child.childRunId as string, child]));

  for (const [taskId, task] of tasks) {
    for (const field of ["plannedAgentId", "effectiveAgentId"] as const) {
      if (typeof task[field] !== "string") continue;
      const agent = agents.get(task[field] as string);
      if (!agent || !Array.isArray(agent.taskIds) || !agent.taskIds.includes(taskId)) {
        add(errors, "HOSTED_TASK_AGENT_ASSIGNMENT_MISMATCH", `topology.tasks.${taskId}.${field}`, "assigned agent must include the exact task identity");
      }
    }
  }

  for (const [agentId, agent] of agents) {
    for (const taskId of Array.isArray(agent.taskIds) ? agent.taskIds : []) {
      const task = typeof taskId === "string" ? tasks.get(taskId) : undefined;
      if (task && task.plannedAgentId !== agentId && task.effectiveAgentId !== agentId) {
        add(errors, "HOSTED_AGENT_TASK_ASSIGNMENT_MISMATCH", `topology.agents.${agentId}.taskIds`, "task must name the agent as planned or effective assignee");
      }
    }
    if (typeof agent.childRunId === "string") {
      const child = children.get(agent.childRunId);
      if (!child || child.agentId !== agentId) add(errors, "HOSTED_AGENT_CHILD_MISMATCH", `topology.agents.${agentId}.childRunId`, "must bind the agent's exact child identity");
    }
  }

  for (const [childRunId, child] of children) {
    const agent = typeof child.agentId === "string" ? agents.get(child.agentId) : undefined;
    if (!agent || agent.childRunId !== childRunId) add(errors, "HOSTED_CHILD_AGENT_MISMATCH", `topology.children.${childRunId}.agentId`, "must bind the exact agent child identity");
    for (const taskId of Array.isArray(child.taskIds) ? child.taskIds : []) {
      if (!agent || !Array.isArray(agent.taskIds) || !agent.taskIds.includes(taskId)) add(errors, "HOSTED_CHILD_TASK_MISMATCH", `topology.children.${childRunId}.taskIds`, "child tasks must be assigned to its exact agent");
    }
    const referenced = referencedEvents(child.evidence, events);
    if (referenced.length === 0) add(errors, "EMPTY_HOSTED_CHILD_EVIDENCE", `topology.children.${childRunId}.evidence`, "must bind at least one exact child event");
    for (const event of referenced) {
      if (event.childRunId !== childRunId || event.agentId !== child.agentId || event.attemptId !== child.attemptId || (event.taskId !== undefined && !Array.isArray(child.taskIds)) || (event.taskId !== undefined && !(child.taskIds as unknown[]).includes(event.taskId))) {
        add(errors, "HOSTED_CHILD_EVIDENCE_MISMATCH", `topology.children.${childRunId}.evidence`, "must bind exact child agent attempt and task identities");
      }
    }
  }

  rawEvents.filter(isRecord).forEach((event, index) => {
    if (typeof event.taskId === "string" && typeof event.agentId === "string") {
      const agent = agents.get(event.agentId);
      const task = tasks.get(event.taskId);
      if (!agent || !Array.isArray(agent.taskIds) || !agent.taskIds.includes(event.taskId)
        || !task || (task.plannedAgentId !== event.agentId && task.effectiveAgentId !== event.agentId)) {
        add(errors, "HOSTED_EVENT_ASSIGNMENT_MISMATCH", `events[${index}]`, "event task and agent must match planned or effective topology");
      }
    }
    if (typeof event.childRunId === "string") {
      const child = children.get(event.childRunId);
      if (!child || child.agentId !== event.agentId || child.attemptId !== event.attemptId || (typeof event.taskId === "string" && (!Array.isArray(child.taskIds) || !child.taskIds.includes(event.taskId)))) {
        add(errors, "HOSTED_EVENT_CHILD_IDENTITY_MISMATCH", `events[${index}]`, "event child must match exact agent attempt and task identities");
      }
    }
    if (event.type === "TASK_REASSIGNED") {
      const fromChild = [...children.values()].find((child) => child.agentId === event.agentId
        && child.attemptId === event.attemptId
        && Array.isArray(child.taskIds)
        && child.taskIds.includes(event.taskId));
      const toChild = [...children.values()].find((child) => child.agentId === event.toAgentId
        && child.attemptId === event.relatedAttemptId
        && Array.isArray(child.taskIds)
        && child.taskIds.includes(event.taskId));
      if (!fromChild || !toChild) add(errors, "HOSTED_REASSIGNMENT_ATTEMPT_MISMATCH", `events[${index}]`, "from and to attempts must resolve to real child identities for the exact task and agents");
      else if (event.agentId === event.toAgentId
        || event.attemptId === event.relatedAttemptId
        || fromChild.childRunId === toChild.childRunId) {
        add(errors, "HOSTED_REASSIGNMENT_NOOP", `events[${index}]`, "reassignment must move to a distinct agent attempt and child identity");
      }
    }
  });
}

function validateEventTypeIdentities(item: Record<string, unknown>, path: string, errors: SwarmValidationError[]): void {
  const type = item.type;
  const childTypes: SwarmEventType[] = [
    "CHILD_STARTED", "CHILD_PROGRESS", "CHILD_VERIFIER_STARTED", "CHILD_VERIFIED", "CHILD_STOPPED",
    "CHILD_NEEDS_REVIEW", "CHILD_PATCH_PROPOSED", "CHILD_PATCH_REJECTED", "CHILD_PATCH_ADMITTED",
  ];
  if (typeof type === "string" && childTypes.includes(type as SwarmEventType)) {
    for (const field of ["taskId", "agentId", "childRunId", "attemptId"] as const) requireIdentifier(item[field], `${path}.${field}`, errors);
  }
  if (type === "CHILD_PATCH_PROPOSED" || type === "CHILD_PATCH_REJECTED" || type === "CHILD_PATCH_ADMITTED") requireIdentifier(item.candidateId, `${path}.candidateId`, errors);
  if (type === "TASK_REASSIGNED") for (const field of ["taskId", "agentId", "attemptId", "relatedAttemptId", "toAgentId"] as const) requireIdentifier(item[field], `${path}.${field}`, errors);
  if (type === "ACTION_BLOCKED") for (const field of ["taskId", "agentId", "attemptId"] as const) requireIdentifier(item[field], `${path}.${field}`, errors);
  if (type === "GLOBAL_VERIFIER_PASSED" || type === "GLOBAL_VERIFIER_FAILED") requireIdentifier(item.verificationId, `${path}.verificationId`, errors);
}

function validateBudget(value: unknown, errors: SwarmValidationError[]): void {
  const item = object(value, "budget", errors);
  if (!item) return;
  exactKeys(item, ["capUsd", "capTokens", "settledUsd", "settledTokens"], "budget", errors);
  for (const key of ["capUsd", "settledUsd", "settledTokens"] as const) nonnegative(item[key], `budget.${key}`, errors);
  if (item.capTokens !== undefined) nonnegative(item.capTokens, "budget.capTokens", errors);
  if (typeof item.capUsd === "number" && typeof item.settledUsd === "number" && item.settledUsd > item.capUsd) add(errors, "HOSTED_BUDGET_EXCEEDED", "budget.settledUsd", "must not exceed capUsd");
}

function validateInterventions(value: unknown, taskIds: Set<string>, agentIds: Set<string>, events: Map<string, SwarmHostedEvent>, errors: SwarmValidationError[]): void {
  const item = object(value, "interventions", errors);
  if (!item) return;
  exactKeys(item, ["blockedActions", "reassignments"], "interventions", errors);
  array(item.blockedActions, "interventions.blockedActions", errors).forEach((entry, index) => {
    const path = `interventions.blockedActions[${index}]`;
    const action = object(entry, path, errors);
    if (!action) return;
    exactKeys(action, ["action", "reasonCode", "taskId", "agentId", "attemptId", "evidence"], path, errors);
    safeCodeIdentifier(action.action, `${path}.action`, errors); safeCodeIdentifier(action.reasonCode, `${path}.reasonCode`, errors);
    linkedText(action.taskId, `${path}.taskId`, taskIds, errors); linkedText(action.agentId, `${path}.agentId`, agentIds, errors);
    safeIdentifier(action.attemptId, `${path}.attemptId`, errors); validateEvidence(action.evidence, `${path}.evidence`, events, errors);
    const actionEvent = singleReferencedEvent(action.evidence, events, `${path}.evidence`, errors);
    if (actionEvent && (actionEvent.type !== "ACTION_BLOCKED" || actionEvent.taskId !== action.taskId || actionEvent.agentId !== action.agentId || actionEvent.attemptId !== action.attemptId)) {
      add(errors, "HOSTED_BLOCKED_ACTION_EVIDENCE_MISMATCH", `${path}.evidence`, "must bind the exact blocked action event identities");
    }
  });
  array(item.reassignments, "interventions.reassignments", errors).forEach((entry, index) => {
    const path = `interventions.reassignments[${index}]`;
    const reassignment = object(entry, path, errors);
    if (!reassignment) return;
    exactKeys(reassignment, ["taskId", "fromAgentId", "toAgentId", "fromAttemptId", "toAttemptId", "reasonCode", "evidence"], path, errors);
    linkedText(reassignment.taskId, `${path}.taskId`, taskIds, errors);
    linkedText(reassignment.fromAgentId, `${path}.fromAgentId`, agentIds, errors); linkedText(reassignment.toAgentId, `${path}.toAgentId`, agentIds, errors);
    safeIdentifier(reassignment.fromAttemptId, `${path}.fromAttemptId`, errors); safeIdentifier(reassignment.toAttemptId, `${path}.toAttemptId`, errors); safeCodeIdentifier(reassignment.reasonCode, `${path}.reasonCode`, errors);
    validateEvidence(reassignment.evidence, `${path}.evidence`, events, errors);
    const reassignmentEvent = singleReferencedEvent(reassignment.evidence, events, `${path}.evidence`, errors);
    if (reassignmentEvent && (reassignmentEvent.type !== "TASK_REASSIGNED"
      || reassignmentEvent.taskId !== reassignment.taskId
      || reassignmentEvent.agentId !== reassignment.fromAgentId
      || reassignmentEvent.toAgentId !== reassignment.toAgentId
      || reassignmentEvent.attemptId !== reassignment.fromAttemptId
      || reassignmentEvent.relatedAttemptId !== reassignment.toAttemptId)) {
      add(errors, "HOSTED_REASSIGNMENT_EVIDENCE_MISMATCH", `${path}.evidence`, "must bind the exact reassignment event identities");
    }
  });
}

function validateIntegration(value: unknown, taskIds: Set<string>, agentIds: Set<string>, childIds: Set<string>, events: Map<string, SwarmHostedEvent>, errors: SwarmValidationError[]): void {
  const item = object(value, "integration", errors);
  if (!item) return;
  exactKeys(item, ["admissions", "rejections", "conflicts", "integratedTreeHash"], "integration", errors);
  for (const lane of ["admissions", "rejections"] as const) array(item[lane], `integration.${lane}`, errors).forEach((entry, index) => {
    const path = `integration.${lane}[${index}]`;
    const decision = object(entry, path, errors);
    if (!decision) return;
    exactKeys(decision, ["candidateId", "taskId", "agentId", "childRunId", "state", "evidence"], path, errors);
    safeIdentifier(decision.candidateId, `${path}.candidateId`, errors); linkedText(decision.taskId, `${path}.taskId`, taskIds, errors);
    linkedText(decision.agentId, `${path}.agentId`, agentIds, errors); linkedText(decision.childRunId, `${path}.childRunId`, childIds, errors);
    equal(decision.state, lane === "admissions" ? "admitted" : "rejected", `${path}.state`, errors);
    validateEvidence(decision.evidence, `${path}.evidence`, events, errors);
    const decisionEvent = singleReferencedEvent(decision.evidence, events, `${path}.evidence`, errors);
    const expectedType = lane === "admissions" ? "CHILD_PATCH_ADMITTED" : "CHILD_PATCH_REJECTED";
    if (decisionEvent && (decisionEvent.type !== expectedType
      || decisionEvent.candidateId !== decision.candidateId
      || decisionEvent.taskId !== decision.taskId
      || decisionEvent.agentId !== decision.agentId
      || decisionEvent.childRunId !== decision.childRunId)) {
      add(errors, "HOSTED_INTEGRATION_EVIDENCE_MISMATCH", `${path}.evidence`, "must bind the exact integration decision event identities");
    }
  });
  array(item.conflicts, "integration.conflicts", errors).forEach((entry, index) => {
    const path = `integration.conflicts[${index}]`;
    const conflict = object(entry, path, errors);
    if (!conflict) return;
    exactKeys(conflict, ["conflictId", "taskIds", "state", "evidence"], path, errors);
    safeIdentifier(conflict.conflictId, `${path}.conflictId`, errors); linkedStringArray(conflict.taskIds, `${path}.taskIds`, taskIds, errors);
    enumValue(conflict.state, ["detected", "resolved", "blocking"], `${path}.state`, errors); validateEvidence(conflict.evidence, `${path}.evidence`, events, errors);
  });
  if (item.integratedTreeHash !== undefined) hex(item.integratedTreeHash, 40, "integration.integratedTreeHash", errors);
}

function validateGlobal(value: unknown, events: Map<string, SwarmHostedEvent>, errors: SwarmValidationError[]): void {
  const item = object(value, "globalVerification", errors);
  if (!item) return;
  exactKeys(item, ["state", "verificationId", "integratedTreeHash", "evidence"], "globalVerification", errors);
  enumValue(item.state, ["passed", "failed", "unknown"], "globalVerification.state", errors);
  optionalIdentifier(item.verificationId, "globalVerification.verificationId", errors);
  if (item.state !== "unknown" && typeof item.verificationId !== "string") add(errors, "MISSING_HOSTED_VERIFICATION_ID", "globalVerification.verificationId", "is required for passed or failed global verification");
  if (item.integratedTreeHash !== undefined) hex(item.integratedTreeHash, 40, "globalVerification.integratedTreeHash", errors);
  validateEvidence(item.evidence, "globalVerification.evidence", events, errors);
  const evidence = Array.isArray(item.evidence) ? item.evidence : [];
  if (item.state === "unknown") {
    if (item.verificationId !== undefined || evidence.length !== 0) add(errors, "INVALID_UNKNOWN_GLOBAL_EVIDENCE", "globalVerification", "unknown verification must not claim an ID or authoritative event evidence");
  } else {
    const verificationEvent = singleReferencedEvent(item.evidence, events, "globalVerification.evidence", errors);
    const expectedType = item.state === "passed" ? "GLOBAL_VERIFIER_PASSED" : "GLOBAL_VERIFIER_FAILED";
    if (verificationEvent && (verificationEvent.type !== expectedType || verificationEvent.verificationId !== item.verificationId)) {
      add(errors, "HOSTED_GLOBAL_EVIDENCE_MISMATCH", "globalVerification.evidence", "must bind the exact matching global verifier event");
    }
  }
}

function validateParent(value: unknown, events: Map<string, SwarmHostedEvent>, errors: SwarmValidationError[]): void {
  const item = object(value, "parentOutcome", errors);
  if (!item) return;
  exactKeys(item, ["state", "source", "evidence"], "parentOutcome", errors);
  enumValue(item.state, ["verified", "stopped", "needs_review"], "parentOutcome.state", errors);
  equal(item.source, "sealed_parent_receipt", "parentOutcome.source", errors);
  validateEvidence(item.evidence, "parentOutcome.evidence", events, errors);
  const outcomeEvent = singleReferencedEvent(item.evidence, events, "parentOutcome.evidence", errors);
  const terminalType = item.state === "verified" ? "SWARM_VERIFIED" : item.state === "stopped" ? "SWARM_STOPPED" : "SWARM_NEEDS_REVIEW";
  if (outcomeEvent && outcomeEvent.type !== terminalType) add(errors, "HOSTED_PARENT_EVIDENCE_MISMATCH", "parentOutcome.evidence", "must bind the exact matching authoritative parent terminal event");
  if (outcomeEvent && outcomeEvent.sequence !== events.size) add(errors, "HOSTED_PARENT_EVENT_NOT_FINAL", "parentOutcome.evidence", "must bind the final persisted event");
}

function validateLatestGlobalAuthority(globalValue: unknown, parentValue: unknown, eventList: unknown[], errors: SwarmValidationError[]): void {
  if (!isRecord(globalValue) || !isRecord(parentValue)) return;
  const globalEvidence = Array.isArray(globalValue.evidence) ? globalValue.evidence[0] : undefined;
  const parentEvidence = Array.isArray(parentValue.evidence) ? parentValue.evidence[0] : undefined;
  if (!isRecord(parentEvidence) || typeof parentEvidence.sequence !== "number") return;
  const terminalEvents = eventList
    .filter(isRecord)
    .filter((event) => (event.type === "GLOBAL_VERIFIER_PASSED" || event.type === "GLOBAL_VERIFIER_FAILED")
      && typeof event.sequence === "number"
      && event.sequence < (parentEvidence.sequence as number))
    .sort((left, right) => Number(left.sequence) - Number(right.sequence));
  if (globalValue.state === "unknown") {
    if (terminalEvents.length > 0) add(errors, "HOSTED_UNKNOWN_GLOBAL_CONTRADICTS_EVENTS", "globalVerification.state", "unknown is allowed only when no persisted terminal global result exists before the parent terminal");
    return;
  }
  if (!isRecord(globalEvidence)) return;
  const latest = terminalEvents.at(-1);
  if (!latest || latest.eventId !== globalEvidence.eventId || latest.sequence !== globalEvidence.sequence) {
    add(errors, "HOSTED_GLOBAL_NOT_LATEST_AUTHORITY", "globalVerification.evidence", "must bind the latest persisted global verifier terminal before the final parent event");
  }
}

function validateSignature(value: unknown, errors: SwarmValidationError[]): void {
  const item = object(value, "transportSignature", errors);
  if (!item) return;
  exactKeys(item, ["algorithm", "keyId", "keyLocatorHash", "signatureHmacSha256"], "transportSignature", errors);
  equal(item.algorithm, "hmac-sha256", "transportSignature.algorithm", errors); safeIdentifier(item.keyId, "transportSignature.keyId", errors);
  hex(item.keyLocatorHash, 64, "transportSignature.keyLocatorHash", errors); hex(item.signatureHmacSha256, 64, "transportSignature.signatureHmacSha256", errors);
}

function validateExtensions(value: unknown, errors: SwarmValidationError[]): void {
  if (value === undefined) return;
  const item = object(value, "extensions", errors);
  if (!item) return;
  if (Object.keys(item).length > 32 || JSON.stringify(item).length > 16_384) add(errors, "HOSTED_EXTENSIONS_TOO_LARGE", "extensions", "must remain within the bounded extension budget");
  for (const [key, extension] of Object.entries(item)) {
    if (!/^[a-z0-9]+(?:[.-][a-z0-9]+)+$/u.test(key)) add(errors, "INVALID_HOSTED_EXTENSION_NAMESPACE", `extensions.${key}`, "must use a namespaced key");
    validateExtensionValue(extension, `extensions.${key}`, 0, { nodes: 0 }, errors);
  }
}

function validateEvidence(value: unknown, path: string, events: Map<string, SwarmHostedEvent>, errors: SwarmValidationError[]): void {
  const refs = array(value, path, errors);
  let previous = 0;
  refs.forEach((entry, index) => {
    const refPath = `${path}[${index}]`;
    const ref = object(entry, refPath, errors);
    if (!ref) return;
    exactKeys(ref, ["eventId", "sequence"], refPath, errors); safeIdentifier(ref.eventId, `${refPath}.eventId`, errors); integer(ref.sequence, `${refPath}.sequence`, errors);
    const event = typeof ref.eventId === "string" ? events.get(ref.eventId) : undefined;
    if (!event || event.sequence !== ref.sequence) add(errors, "DANGLING_HOSTED_EVIDENCE", refPath, "must reference the exact hosted event ID and sequence");
    if (typeof ref.sequence === "number" && ref.sequence <= previous) add(errors, "UNORDERED_HOSTED_EVIDENCE", `${refPath}.sequence`, "must be strictly ordered");
    if (typeof ref.sequence === "number") previous = ref.sequence;
  });
}

function singleReferencedEvent(value: unknown, events: Map<string, SwarmHostedEvent>, path: string, errors: SwarmValidationError[]): SwarmHostedEvent | undefined {
  const refs = Array.isArray(value) ? value : [];
  if (refs.length !== 1) {
    add(errors, "INVALID_HOSTED_AUTHORITY_EVIDENCE_COUNT", path, "must contain exactly one authoritative event reference");
    return undefined;
  }
  return referencedEvents(value, events)[0];
}

function referencedEvents(value: unknown, events: Map<string, SwarmHostedEvent>): SwarmHostedEvent[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!isRecord(entry) || typeof entry.eventId !== "string" || typeof entry.sequence !== "number") return [];
    const event = events.get(entry.eventId);
    return event?.sequence === entry.sequence ? [event] : [];
  });
}

function validateExtensionValue(value: unknown, path: string, depth: number, state: { nodes: number }, errors: SwarmValidationError[]): void {
  state.nodes += 1;
  if (state.nodes > 256 || depth > 4) {
    add(errors, "HOSTED_EXTENSIONS_TOO_COMPLEX", path, "must remain within recursive depth and node limits");
    return;
  }
  if (value === null || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value))) return;
  if (typeof value === "string") {
    if (!SAFE_IDENTIFIER_PATTERN.test(value) || SECRET_VALUE_PATTERN.test(value) || OPAQUE_TOKEN_PATTERN.test(value) || PATH_VALUE_PATTERN.test(value)) {
      add(errors, "UNSAFE_HOSTED_EXTENSION_VALUE", path, "must be a bounded non-secret identifier rather than raw path command prompt or token content");
    }
    return;
  }
  if (Array.isArray(value)) {
    if (value.length > 64) add(errors, "HOSTED_EXTENSIONS_TOO_COMPLEX", path, "arrays must contain at most 64 values");
    value.forEach((entry, index) => validateExtensionValue(entry, `${path}[${index}]`, depth + 1, state, errors));
    return;
  }
  if (!isRecord(value)) {
    add(errors, "INVALID_HOSTED_EXTENSION_VALUE", path, "must be bounded JSON data");
    return;
  }
  if (Object.keys(value).length > 64) add(errors, "HOSTED_EXTENSIONS_TOO_COMPLEX", path, "objects must contain at most 64 keys");
  for (const [key, entry] of Object.entries(value)) {
    if (!/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/u.test(key) || SENSITIVE_EXTENSION_KEY_PATTERN.test(key)) {
      add(errors, "UNSAFE_HOSTED_EXTENSION_KEY", `${path}.${key}`, "must not name raw path command prompt token secret or payload content");
    }
    validateExtensionValue(entry, `${path}.${key}`, depth + 1, state, errors);
  }
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[], path: string, errors: SwarmValidationError[]): void {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(value)) if (!allowedSet.has(key)) add(errors, "UNKNOWN_HOSTED_FIELD", `${path}.${key}`, "is not allowlisted");
}
function object(value: unknown, path: string, errors: SwarmValidationError[]): Record<string, unknown> | undefined {
  if (!isRecord(value)) { add(errors, "INVALID_HOSTED_OBJECT", path, "must be an object"); return undefined; }
  return value;
}
function array(value: unknown, path: string, errors: SwarmValidationError[]): unknown[] {
  if (!Array.isArray(value)) { add(errors, "INVALID_HOSTED_ARRAY", path, "must be an array"); return []; }
  return value;
}
function text(value: unknown, path: string, errors: SwarmValidationError[]): void { if (typeof value !== "string" || value.trim().length === 0) add(errors, "INVALID_HOSTED_TEXT", path, "must be non-empty text"); }
function optionalText(value: unknown, path: string, errors: SwarmValidationError[]): void { if (value !== undefined) text(value, path, errors); }
function safeIdentifier(value: unknown, path: string, errors: SwarmValidationError[]): void { if (typeof value !== "string" || !SAFE_IDENTIFIER_PATTERN.test(value) || SECRET_VALUE_PATTERN.test(value) || PATH_VALUE_PATTERN.test(value)) add(errors, "INVALID_HOSTED_IDENTIFIER", path, "must be a bounded non-secret opaque identifier"); }
function safeCodeIdentifier(value: unknown, path: string, errors: SwarmValidationError[]): void { if (typeof value !== "string" || !SAFE_CODE_PATTERN.test(value) || SECRET_VALUE_PATTERN.test(value) || OPAQUE_TOKEN_PATTERN.test(value)) add(errors, "INVALID_HOSTED_CODE", path, "must use a closed sanitized action or reason identifier"); }
function requireIdentifier(value: unknown, path: string, errors: SwarmValidationError[]): void { safeIdentifier(value, path, errors); }
function optionalIdentifier(value: unknown, path: string, errors: SwarmValidationError[]): void { if (value !== undefined) safeIdentifier(value, path, errors); }
function uniqueIdentifier(value: unknown, path: string, ids: Set<string>, errors: SwarmValidationError[]): void { safeIdentifier(value, path, errors); if (typeof value === "string" && SAFE_IDENTIFIER_PATTERN.test(value)) { if (ids.has(value)) add(errors, "DUPLICATE_HOSTED_ID", path, "must be unique"); else ids.add(value); } }
function uniqueText(value: unknown, path: string, ids: Set<string>, errors: SwarmValidationError[]): void { uniqueIdentifier(value, path, ids, errors); }
function linkedText(value: unknown, path: string, ids: Set<string>, errors: SwarmValidationError[]): void { safeIdentifier(value, path, errors); if (typeof value === "string" && !ids.has(value)) add(errors, "DANGLING_HOSTED_ID", path, "must reference an allowlisted identity"); }
function optionalLinkedText(value: unknown, path: string, ids: Set<string>, errors: SwarmValidationError[]): void { if (value !== undefined) linkedText(value, path, ids, errors); }
function stringArray(value: unknown, path: string, errors: SwarmValidationError[]): string[] { const items = array(value, path, errors); const seen = new Set<string>(); items.forEach((item, index) => uniqueText(item, `${path}[${index}]`, seen, errors)); return items.filter((item): item is string => typeof item === "string"); }
function linkedStringArray(value: unknown, path: string, ids: Set<string>, errors: SwarmValidationError[]): void { stringArray(value, path, errors).forEach((item, index) => { if (!ids.has(item)) add(errors, "DANGLING_HOSTED_ID", `${path}[${index}]`, "must reference an allowlisted identity"); }); }
function integer(value: unknown, path: string, errors: SwarmValidationError[]): void { if (!Number.isInteger(value) || Number(value) < 1) add(errors, "INVALID_HOSTED_INTEGER", path, "must be a positive integer"); }
function nonnegative(value: unknown, path: string, errors: SwarmValidationError[]): void { if (typeof value !== "number" || !Number.isFinite(value) || value < 0) add(errors, "INVALID_HOSTED_NUMBER", path, "must be a finite non-negative number"); }
function timestamp(value: unknown, path: string, errors: SwarmValidationError[]): void { text(value, path, errors); if (typeof value === "string" && !Number.isFinite(Date.parse(value))) add(errors, "INVALID_HOSTED_TIMESTAMP", path, "must be an ISO timestamp"); }
function hex(value: unknown, length: number, path: string, errors: SwarmValidationError[]): void { if (typeof value !== "string" || !new RegExp(`^[a-f0-9]{${length}}$`, "u").test(value)) add(errors, "INVALID_HOSTED_HASH", path, `must be ${length} lowercase hexadecimal characters`); }
function equal(value: unknown, expected: string, path: string, errors: SwarmValidationError[]): void { if (value !== expected) add(errors, "UNSUPPORTED_HOSTED_VALUE", path, `must equal ${expected}`); }
function enumValue<T extends string>(value: unknown, values: readonly T[], path: string, errors: SwarmValidationError[]): void { if (typeof value !== "string" || !values.includes(value as T)) add(errors, "INVALID_HOSTED_ENUM", path, "must use an allowlisted value"); }
function add(errors: SwarmValidationError[], code: string, path: string, message: string): void { errors.push({ code, path, message }); }
function invalid(errors: SwarmValidationError[]): SwarmValidationResult { return { ok: false, errors }; }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype; }
function sortJson(value: unknown): unknown { if (Array.isArray(value)) return value.map(sortJson); if (isRecord(value)) return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => [key, sortJson(item)])); return value; }

const SAFE_IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$/u;
const SAFE_CODE_PATTERN = /^[a-z][a-z0-9_.:-]{0,63}$/u;
const SECRET_VALUE_PATTERN = /^(?:sk-(?:proj-|live_|test_)?[A-Za-z0-9_-]{8,}|rk_live_[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9_]{16,}|github_pat_[A-Za-z0-9_]{16,}|npm_[A-Za-z0-9_]{16,}|xox[baprs]-[A-Za-z0-9-]{16,}|AKIA[A-Z0-9]{16}|ASIA[A-Z0-9]{16}|AIza[A-Za-z0-9_-]{20,}|ya29\.[A-Za-z0-9_-]{16,}|eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,})/u;
const OPAQUE_TOKEN_PATTERN = /^(?=.{32,128}$)(?=.*[A-Za-z])(?=.*\d)[A-Za-z0-9_-]+$/u;
const PATH_VALUE_PATTERN = /^(?:[A-Za-z]:[\\/]|\\\\|\/(?:home|Users|private|tmp|var)\/|file:\/\/)/u;
const SENSITIVE_EXTENSION_KEY_PATTERN = /(?:path|command|prompt|token|secret|credential|password|authorization|auth|bearer|session|cookie|stdout|stderr|payload|diff|apiKey|privateKey|accessKey|keyMaterial)/iu;
