import { describe, expect, it } from "vitest";

import {
  computeSwarmHostedEnvelopeIdentity,
  type SwarmHostedEnvelope,
  type SwarmHostedEvent,
} from "../../contracts/dist/swarm-hosted.js";

import {
  projectSwarmAtlasView,
  projectSwarmDashboardView,
  projectSwarmTraceFacts,
} from "../src/swarm/hosted-projection.js";
import {
  buildProductionSwarmHostedFixtureBundle,
  type SwarmHostedFixtureBundle,
} from "./helpers/swarm-hosted-fixture-builder.js";

describe("hosted swarm projections", () => {
  it("recomputes Atlas, SANSA, and dashboard bytes from each same production-exported frozen envelope", async () => {
    const bundle: SwarmHostedFixtureBundle = await buildProductionSwarmHostedFixtureBundle();

    for (const fixture of bundle.validCases) {
      expect(projectSwarmAtlasView(fixture.envelope), `${fixture.name}:atlas`).toEqual(fixture.atlas);
      expect(projectSwarmTraceFacts(fixture.envelope), `${fixture.name}:sansa`).toEqual(fixture.sansa);
      expect(projectSwarmDashboardView(fixture.envelope), `${fixture.name}:dashboard`).toEqual(fixture.dashboard);
    }

    const facts = bundle.validCases.flatMap((fixture) => fixture.sansa.facts);
    expect(facts).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "blocking_dependency", derivationKind: "deterministic_graph_derivation" }),
      expect.objectContaining({ kind: "reassignment", derivationKind: "observed" }),
      expect.objectContaining({ kind: "recovery", derivationKind: "deterministic_graph_derivation" }),
    ]));
    for (const fact of facts.filter((item) => item.kind === "blocking_dependency" || item.kind === "recovery")) {
      expect(fact.evidence.length).toBeGreaterThan(0);
      expect(fact.evidence.map((item) => item.sequence)).toEqual(
        [...fact.evidence.map((item) => item.sequence)].sort((left, right) => left - right),
      );
    }
  }, 120_000);

  it("projects planned and effective topology, budget, interventions, and parent truth into Atlas", () => {
    const envelope = hostedEnvelopeFixture();

    const atlas = projectSwarmAtlasView(envelope);

    expect(atlas).toMatchObject({
      schemaVersion: "martin.swarm-atlas-view.v1",
      envelopeId: envelope.envelopeId,
      sourceIdentities: envelope.sourceIdentities,
      swarm: envelope.swarm,
      budget: envelope.budget,
      interventions: envelope.interventions,
      integration: envelope.integration,
      globalVerification: envelope.globalVerification,
      parentOutcome: envelope.parentOutcome,
      taskVerificationState: "failed",
      receiptIntegrityState: "verified",
    });
    expect(atlas.tasks.find((task) => task.taskId === "task-recovery")).toMatchObject({
      plannedAgentId: "agent-original",
      effectiveAgentId: "agent-recovery",
      status: "accepted",
    });
    expect(atlas.dependencyEdges).toEqual([
      { fromTaskId: "task-recovery", toTaskId: "task-root" },
      { fromTaskId: "task-waiting", toTaskId: "task-blocked" },
    ]);
    expect(atlas.children).toHaveLength(4);
  });

  it("emits only evidence-bound observed and deterministic graph-derived SANSA facts", () => {
    const envelope = hostedEnvelopeFixture();
    const sansa = projectSwarmTraceFacts(envelope);

    expect(sansa).toMatchObject({
      schemaVersion: "martin.swarm-sansa-view.v1",
      sourceIdentities: envelope.sourceIdentities,
      parentOutcome: { state: "needs_review" },
      globalVerification: { state: "failed" },
    });
    expect(sansa.facts.map((fact) => [fact.kind, fact.derivationKind])).toEqual([
      ["failure", "observed"],
      ["reassignment", "observed"],
      ["recovery", "deterministic_graph_derivation"],
      ["failure", "observed"],
      ["blocking_dependency", "deterministic_graph_derivation"],
      ["verification_boundary", "observed"],
    ]);

    const recovery = sansa.facts.find((fact) => fact.kind === "recovery");
    expect(recovery).toEqual(expect.objectContaining({
      taskIds: ["task-recovery"],
      agentIds: ["agent-original", "agent-recovery"],
      childRunIds: ["child-original", "child-recovery"],
      attemptIds: ["attempt-original", "attempt-recovery"],
      evidence: [
        { eventId: "evt-stop-original", sequence: 5 },
        { eventId: "evt-reassign", sequence: 6 },
        { eventId: "evt-start-recovery", sequence: 7 },
        { eventId: "evt-verified-recovery", sequence: 8 },
        { eventId: "evt-admitted-recovery", sequence: 9 },
      ],
    }));

    const blocking = sansa.facts.find((fact) => fact.kind === "blocking_dependency");
    expect(blocking).toEqual(expect.objectContaining({
      taskIds: ["task-waiting", "task-blocked"],
      agentIds: ["agent-blocked"],
      childRunIds: ["child-blocked"],
      attemptIds: ["attempt-blocked"],
      evidence: [{ eventId: "evt-stop-blocked", sequence: 11 }],
    }));
    expect(JSON.stringify(sansa)).not.toMatch(/cause|caused|raw|payload|path|stdout|stderr/iu);
    for (const fact of sansa.facts) {
      expect([
        ...fact.taskIds,
        ...fact.agentIds,
        ...fact.childRunIds,
        ...fact.attemptIds,
        ...fact.verificationIds,
      ]).not.toHaveLength(0);
    }
  });

  it("does not infer recovery or retry facts when the exact persisted attempt links are absent", () => {
    const envelope = hostedEnvelopeFixture();
    envelope.topology.tasks.find((task) => task.taskId === "task-recovery")!.status = "needs_review";
    envelope.envelopeId = computeSwarmHostedEnvelopeIdentity(envelope);

    const facts = projectSwarmTraceFacts(envelope).facts;

    expect(facts.some((fact) => fact.kind === "recovery")).toBe(false);
    expect(facts.some((fact) => fact.factId.includes("retry"))).toBe(false);
  });

  it("keeps child, parent, global verifier, task verification, and integrity states separate", () => {
    const envelope = hostedEnvelopeFixture();
    const tasks = Array.from({ length: 15 }, (_, index) => ({
      taskId: `task-green-${index + 1}`,
      required: true,
      dependsOn: [] as string[],
      plannedAgentId: `agent-green-${index + 1}`,
      effectiveAgentId: `agent-green-${index + 1}`,
      status: "accepted" as const,
    }));
    envelope.topology = {
      tasks,
      agents: tasks.map((task, index) => ({
        agentId: `agent-green-${index + 1}`,
        role: "worker",
        status: "verified" as const,
        taskIds: [task.taskId],
        childRunId: `child-green-${index + 1}`,
      })),
      children: tasks.map((task, index) => ({
        childRunId: `child-green-${index + 1}`,
        agentId: `agent-green-${index + 1}`,
        attemptId: `attempt-green-${index + 1}`,
        taskIds: [task.taskId],
        status: "verified" as const,
        receiptIntegrityState: "verified" as const,
        evidence: [{ eventId: `evt-green-${index + 1}`, sequence: index + 1 }],
      })),
    };
    envelope.events = tasks.map((task, index) => event(`evt-green-${index + 1}`, index + 1, "CHILD_VERIFIED", {
      taskId: task.taskId,
      agentId: `agent-green-${index + 1}`,
      childRunId: `child-green-${index + 1}`,
      attemptId: `attempt-green-${index + 1}`,
    }));
    envelope.events.push(event("evt-global-failed", 16, "GLOBAL_VERIFIER_FAILED", { verificationId: "verification-global" }));
    envelope.events.push(event("evt-parent-review", 17, "SWARM_NEEDS_REVIEW"));
    envelope.interventions = { blockedActions: [], reassignments: [] };
    envelope.integration = { admissions: [], rejections: [], conflicts: [], integratedTreeHash: "c".repeat(40) };
    envelope.globalVerification = {
      state: "failed",
      verificationId: "verification-global",
      integratedTreeHash: "c".repeat(40),
      evidence: [{ eventId: "evt-global-failed", sequence: 16 }],
    };
    envelope.parentOutcome = { state: "needs_review", source: "sealed_parent_receipt", evidence: [{ eventId: "evt-parent-review", sequence: 17 }] };
    envelope.taskVerificationState = "failed";
    envelope.envelopeId = computeSwarmHostedEnvelopeIdentity(envelope);

    const dashboard = projectSwarmDashboardView(envelope);

    expect(dashboard.children).toHaveLength(15);
    expect(dashboard.sourceIdentities).toEqual(envelope.sourceIdentities);
    expect(dashboard.children.every((child) => child.status === "verified")).toBe(true);
    expect(dashboard.parentOutcome.state).toBe("needs_review");
    expect(dashboard.globalVerification.state).toBe("failed");
    expect(dashboard.taskVerificationState).toBe("failed");
    expect(dashboard.receiptIntegrityState).toBe("verified");
    expect(dashboard).not.toHaveProperty("verified", true);
  });

  it("fails closed at the projection boundary for an invalid hosted envelope", () => {
    const envelope = hostedEnvelopeFixture() as SwarmHostedEnvelope & { payload?: unknown };
    envelope.payload = { localPath: "C:/private/repo" };

    expect(() => projectSwarmAtlasView(envelope)).toThrow(/INVALID_SWARM_HOSTED_ENVELOPE/u);
    expect(() => projectSwarmTraceFacts(envelope)).toThrow(/INVALID_SWARM_HOSTED_ENVELOPE/u);
    expect(() => projectSwarmDashboardView(envelope)).toThrow(/INVALID_SWARM_HOSTED_ENVELOPE/u);
  });

  it("keeps hosted projectors and mutation authority out of the public Core root", async () => {
    const core = await import("../src/index.js");

    expect(core).not.toHaveProperty("projectSwarmAtlasView");
    expect(core).not.toHaveProperty("projectSwarmTraceFacts");
    expect(core).not.toHaveProperty("projectSwarmDashboardView");
    expect(core).not.toHaveProperty("appendSwarmHostedEvent");
    expect(core).not.toHaveProperty("writeSwarmHostedEnvelope");
    expect(core).not.toHaveProperty("markSwarmHostedVerified");
  });
});

function hostedEnvelopeFixture(): SwarmHostedEnvelope {
  const events: SwarmHostedEvent[] = [
    event("evt-start-root", 1, "CHILD_STARTED", { taskId: "task-root", agentId: "agent-root", childRunId: "child-root", attemptId: "attempt-root" }),
    event("evt-verified-root", 2, "CHILD_VERIFIED", { taskId: "task-root", agentId: "agent-root", childRunId: "child-root", attemptId: "attempt-root" }),
    event("evt-admitted-root", 3, "CHILD_PATCH_ADMITTED", { taskId: "task-root", agentId: "agent-root", childRunId: "child-root", attemptId: "attempt-root", candidateId: "candidate-root" }),
    event("evt-start-original", 4, "CHILD_STARTED", { taskId: "task-recovery", agentId: "agent-original", childRunId: "child-original", attemptId: "attempt-original" }),
    event("evt-stop-original", 5, "CHILD_STOPPED", { taskId: "task-recovery", agentId: "agent-original", childRunId: "child-original", attemptId: "attempt-original", failureClass: "type_error" }),
    event("evt-reassign", 6, "TASK_REASSIGNED", { taskId: "task-recovery", agentId: "agent-original", attemptId: "attempt-original", relatedAttemptId: "attempt-recovery", toAgentId: "agent-recovery" }),
    event("evt-start-recovery", 7, "CHILD_STARTED", { taskId: "task-recovery", agentId: "agent-recovery", childRunId: "child-recovery", attemptId: "attempt-recovery" }),
    event("evt-verified-recovery", 8, "CHILD_VERIFIED", { taskId: "task-recovery", agentId: "agent-recovery", childRunId: "child-recovery", attemptId: "attempt-recovery" }),
    event("evt-admitted-recovery", 9, "CHILD_PATCH_ADMITTED", { taskId: "task-recovery", agentId: "agent-recovery", childRunId: "child-recovery", attemptId: "attempt-recovery", candidateId: "candidate-recovery" }),
    event("evt-action-blocked", 10, "ACTION_BLOCKED", { taskId: "task-blocked", agentId: "agent-blocked", attemptId: "attempt-blocked" }),
    event("evt-stop-blocked", 11, "CHILD_STOPPED", { taskId: "task-blocked", agentId: "agent-blocked", childRunId: "child-blocked", attemptId: "attempt-blocked", failureClass: "safety_leash_blocked" }),
    event("evt-global-failed", 12, "GLOBAL_VERIFIER_FAILED", { verificationId: "verification-global" }),
    event("evt-parent-review", 13, "SWARM_NEEDS_REVIEW"),
  ];

  const envelope: SwarmHostedEnvelope = {
    schemaVersion: "martin.swarm-hosted.v1",
    envelopeId: "0".repeat(64),
    sourceSchemas: {
      swarm: "martin.swarm.v1",
      receipt: "martin.swarm-receipt.v1",
      evidenceIndex: "martin.swarm-evidence-index.v1",
    },
    sourceIdentities: {
      receiptId: "receipt-hosted",
      receiptSha256: "1".repeat(64),
      evidenceIndexSha256: "2".repeat(64),
      eventChainSha256: "3".repeat(64),
    },
    runtimeVersion: "0.8.0",
    createdAt: "2026-10-03T12:00:00.000Z",
    swarm: {
      swarmId: "swarm-hosted",
      workspaceId: "workspace-hosted",
      projectId: "project-hosted",
      planHash: "a".repeat(64),
      baselineCommit: "b".repeat(40),
    },
    topology: {
      tasks: [
        { taskId: "task-root", required: true, dependsOn: [], plannedAgentId: "agent-root", effectiveAgentId: "agent-root", status: "accepted" },
        { taskId: "task-recovery", required: true, dependsOn: ["task-root"], plannedAgentId: "agent-original", effectiveAgentId: "agent-recovery", status: "accepted" },
        { taskId: "task-blocked", required: true, dependsOn: [], plannedAgentId: "agent-blocked", effectiveAgentId: "agent-blocked", status: "stopped" },
        { taskId: "task-waiting", required: true, dependsOn: ["task-blocked"], plannedAgentId: "agent-waiting", effectiveAgentId: "agent-waiting", status: "queued" },
      ],
      agents: [
        { agentId: "agent-root", role: "worker", status: "verified", taskIds: ["task-root"], childRunId: "child-root" },
        { agentId: "agent-original", role: "worker", status: "stopped", taskIds: ["task-recovery"], childRunId: "child-original" },
        { agentId: "agent-recovery", role: "worker", status: "verified", taskIds: ["task-recovery"], childRunId: "child-recovery" },
        { agentId: "agent-blocked", role: "worker", status: "stopped", taskIds: ["task-blocked"], childRunId: "child-blocked" },
        { agentId: "agent-waiting", role: "worker", status: "queued", taskIds: ["task-waiting"] },
      ],
      children: [
        child("child-root", "agent-root", "attempt-root", "task-root", "verified", ref(events[1]!)),
        child("child-original", "agent-original", "attempt-original", "task-recovery", "stopped", ref(events[4]!)),
        child("child-recovery", "agent-recovery", "attempt-recovery", "task-recovery", "verified", ref(events[7]!)),
        child("child-blocked", "agent-blocked", "attempt-blocked", "task-blocked", "stopped", ref(events[10]!)),
      ],
    },
    budget: { capUsd: 20, capTokens: 200_000, settledUsd: 4.25, settledTokens: 42_000 },
    interventions: {
      blockedActions: [{
        action: "write_outside_scope",
        reasonCode: "scope_denied",
        taskId: "task-blocked",
        agentId: "agent-blocked",
        attemptId: "attempt-blocked",
        evidence: ref(events[9]!),
      }],
      reassignments: [{
        taskId: "task-recovery",
        fromAgentId: "agent-original",
        toAgentId: "agent-recovery",
        fromAttemptId: "attempt-original",
        toAttemptId: "attempt-recovery",
        reasonCode: "failed_attempt",
        evidence: ref(events[5]!),
      }],
    },
    integration: {
      admissions: [
        { candidateId: "candidate-root", taskId: "task-root", agentId: "agent-root", childRunId: "child-root", state: "admitted", evidence: ref(events[2]!) },
        { candidateId: "candidate-recovery", taskId: "task-recovery", agentId: "agent-recovery", childRunId: "child-recovery", state: "admitted", evidence: ref(events[8]!) },
      ],
      rejections: [],
      conflicts: [],
      integratedTreeHash: "c".repeat(40),
    },
    events,
    globalVerification: {
      state: "failed",
      verificationId: "verification-global",
      integratedTreeHash: "c".repeat(40),
      evidence: ref(events[11]!),
    },
    parentOutcome: { state: "needs_review", source: "sealed_parent_receipt", evidence: ref(events[12]!) },
    taskVerificationState: "failed",
    receiptIntegrityState: "verified",
    transportSignature: {
      algorithm: "hmac-sha256",
      keyId: "hosted-key",
      keyLocatorHash: "d".repeat(64),
      signatureHmacSha256: "e".repeat(64),
    },
  };
  envelope.envelopeId = computeSwarmHostedEnvelopeIdentity(envelope);
  return envelope;
}

function event(
  eventId: string,
  sequence: number,
  type: SwarmHostedEvent["type"],
  fields: Partial<Omit<SwarmHostedEvent, "eventId" | "sequence" | "type" | "timestamp">> = {},
): SwarmHostedEvent {
  return {
    eventId,
    sourceIdempotencyKey: eventId,
    sequence,
    type,
    timestamp: `2026-10-03T12:00:${String(sequence).padStart(2, "0")}.000Z`,
    ...fields,
  };
}

function ref(source: SwarmHostedEvent): Array<{ eventId: string; sequence: number }> {
  return [{ eventId: source.eventId, sequence: source.sequence }];
}

function child(
  childRunId: string,
  agentId: string,
  attemptId: string,
  taskId: string,
  status: "verified" | "stopped",
  evidence: Array<{ eventId: string; sequence: number }>,
): SwarmHostedEnvelope["topology"]["children"][number] {
  return { childRunId, agentId, attemptId, taskIds: [taskId], status, receiptIntegrityState: "verified", evidence };
}
