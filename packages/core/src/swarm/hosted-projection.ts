import {
  validateSwarmHostedEnvelope,
  type SwarmAtlasView,
  type SwarmDashboardView,
  type SwarmHostedEnvelope,
  type SwarmHostedEvent,
  type SwarmHostedEvidenceReference,
  type SwarmHostedTask,
  type SwarmSansaView,
  type SwarmTraceFact,
} from "../../../contracts/dist/swarm-hosted.js";

export type { SwarmAtlasView, SwarmDashboardView, SwarmSansaView, SwarmTraceFact } from "../../../contracts/dist/swarm-hosted.js";

const FAILURE_EVENT_TYPES = new Set<SwarmHostedEvent["type"]>([
  "CHILD_STOPPED",
  "CHILD_NEEDS_REVIEW",
  "CHILD_PATCH_REJECTED",
]);

const TERMINAL_EVENT_TYPES: Partial<Record<SwarmHostedTask["status"], SwarmHostedEvent["type"]>> = {
  stopped: "CHILD_STOPPED",
  needs_review: "CHILD_NEEDS_REVIEW",
  rejected: "CHILD_PATCH_REJECTED",
};

export function projectSwarmAtlasView(value: unknown): SwarmAtlasView {
  const envelope = validatedEnvelope(value);
  return {
    schemaVersion: "martin.swarm-atlas-view.v1",
    envelopeId: envelope.envelopeId,
    sourceIdentities: { ...envelope.sourceIdentities },
    swarm: { ...envelope.swarm },
    tasks: envelope.topology.tasks.map(cloneTask),
    dependencyEdges: envelope.topology.tasks
      .flatMap((task) => task.dependsOn.map((dependencyTaskId) => ({
        fromTaskId: task.taskId,
        toTaskId: dependencyTaskId,
      })))
      .sort(compareDependencyEdges),
    agents: envelope.topology.agents.map((agent) => ({ ...agent, taskIds: [...agent.taskIds] })),
    children: envelope.topology.children.map((child) => ({
      ...child,
      taskIds: [...child.taskIds],
      evidence: cloneEvidence(child.evidence),
    })),
    budget: { ...envelope.budget },
    interventions: {
      blockedActions: envelope.interventions.blockedActions.map((action) => ({ ...action, evidence: cloneEvidence(action.evidence) })),
      reassignments: envelope.interventions.reassignments.map((reassignment) => ({ ...reassignment, evidence: cloneEvidence(reassignment.evidence) })),
    },
    integration: {
      ...envelope.integration,
      admissions: envelope.integration.admissions.map((decision) => ({ ...decision, evidence: cloneEvidence(decision.evidence) })),
      rejections: envelope.integration.rejections.map((decision) => ({ ...decision, evidence: cloneEvidence(decision.evidence) })),
      conflicts: envelope.integration.conflicts.map((conflict) => ({ ...conflict, taskIds: [...conflict.taskIds], evidence: cloneEvidence(conflict.evidence) })),
    },
    globalVerification: { ...envelope.globalVerification, evidence: cloneEvidence(envelope.globalVerification.evidence) },
    parentOutcome: { ...envelope.parentOutcome, evidence: cloneEvidence(envelope.parentOutcome.evidence) },
    taskVerificationState: envelope.taskVerificationState,
    receiptIntegrityState: envelope.receiptIntegrityState,
  };
}

export function projectSwarmTraceFacts(value: unknown): SwarmSansaView {
  const envelope = validatedEnvelope(value);
  const facts = [
    ...observedFacts(envelope),
    ...recoveryFacts(envelope),
    ...blockingDependencyFacts(envelope),
  ].sort(compareFacts);
  return {
    schemaVersion: "martin.swarm-sansa-view.v1",
    envelopeId: envelope.envelopeId,
    sourceIdentities: { ...envelope.sourceIdentities },
    facts,
    parentOutcome: { ...envelope.parentOutcome, evidence: cloneEvidence(envelope.parentOutcome.evidence) },
    globalVerification: { ...envelope.globalVerification, evidence: cloneEvidence(envelope.globalVerification.evidence) },
  };
}

export function projectSwarmDashboardView(value: unknown): SwarmDashboardView {
  const envelope = validatedEnvelope(value);
  return {
    schemaVersion: "martin.swarm-dashboard-view.v1",
    envelopeId: envelope.envelopeId,
    sourceIdentities: { ...envelope.sourceIdentities },
    swarmId: envelope.swarm.swarmId,
    children: envelope.topology.children.map((child) => ({
      ...child,
      taskIds: [...child.taskIds],
      evidence: cloneEvidence(child.evidence),
    })),
    parentOutcome: { ...envelope.parentOutcome, evidence: cloneEvidence(envelope.parentOutcome.evidence) },
    globalVerification: { ...envelope.globalVerification, evidence: cloneEvidence(envelope.globalVerification.evidence) },
    taskVerificationState: envelope.taskVerificationState,
    receiptIntegrityState: envelope.receiptIntegrityState,
    budget: { ...envelope.budget },
  };
}

function validatedEnvelope(value: unknown): SwarmHostedEnvelope {
  const validation = validateSwarmHostedEnvelope(value);
  if (!validation.ok) {
    const error = new Error(`INVALID_SWARM_HOSTED_ENVELOPE: ${validation.errors.map((item) => `${item.code}:${item.path}`).join(",")}`);
    Object.assign(error, { code: "INVALID_SWARM_HOSTED_ENVELOPE" });
    throw error;
  }
  return value as SwarmHostedEnvelope;
}

function observedFacts(envelope: SwarmHostedEnvelope): SwarmTraceFact[] {
  return envelope.events.flatMap((event) => {
    if (FAILURE_EVENT_TYPES.has(event.type)) return [factFromEvent("failure", event)];
    if (event.type === "TASK_REASSIGNED") return [factFromEvent("reassignment", event)];
    if (event.type === "GLOBAL_VERIFIER_PASSED" || event.type === "GLOBAL_VERIFIER_FAILED") {
      return [factFromEvent("verification_boundary", event)];
    }
    return [];
  });
}

function recoveryFacts(envelope: SwarmHostedEnvelope): SwarmTraceFact[] {
  const facts: SwarmTraceFact[] = [];
  for (const reassignment of envelope.interventions.reassignments) {
    const task = envelope.topology.tasks.find((item) => item.taskId === reassignment.taskId);
    if (task?.status !== "accepted" || task.effectiveAgentId !== reassignment.toAgentId) continue;
    const reassigned = referencedEvent(envelope.events, reassignment.evidence, "TASK_REASSIGNED");
    if (!reassigned
      || reassigned.taskId !== reassignment.taskId
      || reassigned.agentId !== reassignment.fromAgentId
      || reassigned.toAgentId !== reassignment.toAgentId
      || reassigned.attemptId !== reassignment.fromAttemptId
      || reassigned.relatedAttemptId !== reassignment.toAttemptId) continue;
    const failure = latestBefore(envelope.events, reassigned.sequence, (event) => FAILURE_EVENT_TYPES.has(event.type)
      && event.taskId === reassignment.taskId
      && event.agentId === reassignment.fromAgentId
      && event.attemptId === reassignment.fromAttemptId);
    const start = firstAfter(envelope.events, reassigned.sequence, (event) => event.type === "CHILD_STARTED"
      && event.taskId === reassignment.taskId
      && event.agentId === reassignment.toAgentId
      && event.attemptId === reassignment.toAttemptId);
    const completed = start && firstAfter(envelope.events, start.sequence, (event) => event.type === "CHILD_VERIFIED"
      && event.taskId === reassignment.taskId
      && event.agentId === reassignment.toAgentId
      && event.attemptId === reassignment.toAttemptId
      && event.childRunId === start.childRunId);
    const admitted = completed && firstAfter(envelope.events, completed.sequence, (event) => event.type === "CHILD_PATCH_ADMITTED"
      && event.taskId === reassignment.taskId
      && event.agentId === reassignment.toAgentId
      && event.attemptId === reassignment.toAttemptId
      && event.childRunId === completed.childRunId);
    const admission = admitted && envelope.integration.admissions.find((decision) => decision.taskId === reassignment.taskId
      && decision.agentId === reassignment.toAgentId
      && decision.childRunId === admitted.childRunId
      && decision.candidateId === admitted.candidateId
      && evidenceIncludes(decision.evidence, admitted));
    if (!failure || !start || !completed || !admitted || !admission) continue;
    facts.push({
      factId: `derived:recovery:${reassignment.taskId}:${reassignment.fromAttemptId}:${reassignment.toAttemptId}`,
      kind: "recovery",
      derivationKind: "deterministic_graph_derivation",
      taskIds: [reassignment.taskId],
      agentIds: [reassignment.fromAgentId, reassignment.toAgentId],
      childRunIds: compactUnique([failure.childRunId, completed.childRunId]),
      attemptIds: [reassignment.fromAttemptId, reassignment.toAttemptId],
      verificationIds: [],
      evidence: [failure, reassigned, start, completed, admitted].map(eventReference),
    });
  }
  return facts;
}

function blockingDependencyFacts(envelope: SwarmHostedEnvelope): SwarmTraceFact[] {
  const tasks = new Map(envelope.topology.tasks.map((task) => [task.taskId, task]));
  const facts: SwarmTraceFact[] = [];
  for (const task of [...envelope.topology.tasks].sort((left, right) => left.taskId.localeCompare(right.taskId))) {
    if (!new Set(["queued", "ready", "running"]).has(task.status)) continue;
    for (const path of terminalDependencyPaths(task.taskId, tasks)) {
      const blocking = tasks.get(path.at(-1)!);
      const terminalType = blocking && TERMINAL_EVENT_TYPES[blocking.status];
      if (!blocking || !terminalType) continue;
      const terminal = [...envelope.events].reverse().find((event) => event.type === terminalType && event.taskId === blocking.taskId);
      if (!terminal) continue;
      facts.push({
        factId: `derived:blocking:${path.join("->")}`,
        kind: "blocking_dependency",
        derivationKind: "deterministic_graph_derivation",
        taskIds: path,
        agentIds: compactUnique([terminal.agentId]),
        childRunIds: compactUnique([terminal.childRunId]),
        attemptIds: compactUnique([terminal.attemptId]),
        verificationIds: [],
        evidence: [eventReference(terminal)],
      });
    }
  }
  return facts;
}

function terminalDependencyPaths(startTaskId: string, tasks: Map<string, SwarmHostedTask>): string[][] {
  const paths: string[][] = [];
  const visit = (currentId: string, path: string[], seen: Set<string>): void => {
    const current = tasks.get(currentId);
    if (!current) return;
    for (const dependencyId of [...current.dependsOn].sort()) {
      if (seen.has(dependencyId)) continue;
      const dependency = tasks.get(dependencyId);
      if (!dependency) continue;
      const next = [...path, dependencyId];
      if (TERMINAL_EVENT_TYPES[dependency.status]) paths.push(next);
      else visit(dependencyId, next, new Set([...seen, dependencyId]));
    }
  };
  visit(startTaskId, [startTaskId], new Set([startTaskId]));
  return paths;
}

function factFromEvent(kind: SwarmTraceFact["kind"], event: SwarmHostedEvent): SwarmTraceFact {
  return {
    factId: `observed:${event.sequence}:${event.eventId}`,
    kind,
    derivationKind: "observed",
    taskIds: compactUnique([event.taskId]),
    agentIds: compactUnique([event.agentId, event.toAgentId]),
    childRunIds: compactUnique([event.childRunId]),
    attemptIds: compactUnique([event.attemptId, event.relatedAttemptId]),
    verificationIds: compactUnique([event.verificationId]),
    evidence: [eventReference(event)],
  };
}

function referencedEvent(events: SwarmHostedEvent[], evidence: SwarmHostedEvidenceReference[], type: SwarmHostedEvent["type"]): SwarmHostedEvent | undefined {
  return evidence
    .map((reference) => events.find((event) => event.eventId === reference.eventId && event.sequence === reference.sequence))
    .find((event) => event?.type === type);
}

function latestBefore(events: SwarmHostedEvent[], sequence: number, predicate: (event: SwarmHostedEvent) => boolean): SwarmHostedEvent | undefined {
  return [...events].reverse().find((event) => event.sequence < sequence && predicate(event));
}

function firstAfter(events: SwarmHostedEvent[], sequence: number, predicate: (event: SwarmHostedEvent) => boolean): SwarmHostedEvent | undefined {
  return events.find((event) => event.sequence > sequence && predicate(event));
}

function evidenceIncludes(evidence: SwarmHostedEvidenceReference[], event: SwarmHostedEvent): boolean {
  return evidence.some((reference) => reference.eventId === event.eventId && reference.sequence === event.sequence);
}

function eventReference(event: SwarmHostedEvent): SwarmHostedEvidenceReference {
  return { eventId: event.eventId, sequence: event.sequence };
}

function cloneEvidence(evidence: SwarmHostedEvidenceReference[]): SwarmHostedEvidenceReference[] {
  return evidence.map((reference) => ({ ...reference }));
}

function cloneTask(task: SwarmHostedTask): SwarmHostedTask {
  return { ...task, dependsOn: [...task.dependsOn] };
}

function compactUnique(values: Array<string | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => typeof value === "string"))];
}

function compareDependencyEdges(left: { fromTaskId: string; toTaskId: string }, right: { fromTaskId: string; toTaskId: string }): number {
  return left.fromTaskId.localeCompare(right.fromTaskId) || left.toTaskId.localeCompare(right.toTaskId);
}

function compareFacts(left: SwarmTraceFact, right: SwarmTraceFact): number {
  const leftSequence = left.evidence.at(-1)?.sequence ?? Number.MAX_SAFE_INTEGER;
  const rightSequence = right.evidence.at(-1)?.sequence ?? Number.MAX_SAFE_INTEGER;
  const derivationOrder = (fact: SwarmTraceFact): number => fact.derivationKind === "observed" ? 0 : 1;
  return leftSequence - rightSequence
    || derivationOrder(left) - derivationOrder(right)
    || left.factId.localeCompare(right.factId);
}
