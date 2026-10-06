import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import {
  SWARM_HOSTED_SCHEMA_VERSION,
  canonicalSwarmHostedTransportBytes,
  computeSwarmHostedEnvelopeIdentity,
  validateSwarmHostedEnvelope,
  type SwarmHostedEnvelope,
} from "../src/swarm-hosted.js";

describe("martin.swarm-hosted.v1 contracts", () => {
  it("pins the bounded native hosted handoff and every deferred live surface", async () => {
    const [handoff, checksum] = await Promise.all([
      readFile(new URL("../../../docs/reference/SWARM-HOSTED-V1-HANDOFF.md", import.meta.url), "utf8"),
      readFile(new URL("./fixtures/swarm-hosted-v1-cases.sha256", import.meta.url), "utf8")
        .then((value) => value.trim()),
    ]);
    expect(checksum).toMatch(/^[a-f0-9]{64}$/u);
    const requiredContract = [
      "SCHEMA=martin.swarm-hosted.v1",
      "FIXTURE=packages/contracts/tests/fixtures/swarm-hosted-v1-cases.json",
      "CHECKSUM_FILE=packages/contracts/tests/fixtures/swarm-hosted-v1-cases.sha256",
      `CHECKSUM_SHA256=${checksum}`,
      "SYNC_ROUTE=/api/swarms/sync",
      "SYNC_ROUTE_OWNERSHIP=CLOSED_NATIVE_OWNER_ONLY",
      "TENANT_BINDING=workspaceId+projectId",
      "TRANSPORT_AUTH=distinct_hosted_transport_key+hmac-sha256",
      "IDEMPOTENT_REPLAY=exact_canonical_body_same_envelopeId",
      "COMPETING_EVIDENCE=409_CONFLICT",
      "SANSA_DERIVATIONS=observed,deterministic_graph_derivation",
      "PARENT_AUTHORITY=sealed_parent_receipt_only",
      "CHILD_SUCCESS_CANNOT_VERIFY_PARENT=TRUE",
      "HOSTED_CONSUMER_APPEND_LOCAL_EVENTS=PROHIBITED",
      "HOSTED_CONSUMER_REWRITE_RECEIPTS=PROHIBITED",
      "HOSTED_CONSUMER_AUTHORIZE_PARENT_OUTCOMES=PROHIBITED",
      "NATIVE_ENDPOINT=UNKNOWN_DEFERRED",
      "ATLAS_SANSA_INGESTION=UNKNOWN_DEFERRED",
      "DASHBOARD_UI=UNKNOWN_DEFERRED",
      "SUPABASE=UNKNOWN_DEFERRED",
      "LOVABLE=UNKNOWN_DEFERRED",
      "WEBSITE=UNKNOWN_DEFERRED",
      "DEPLOYMENT=UNKNOWN_DEFERRED",
      "PUBLIC_WRITES=UNKNOWN_DEFERRED",
      "PROVIDER_RUNS=UNKNOWN_DEFERRED",
      "PACKAGE_VERSION=UNKNOWN_DEFERRED",
      "RELEASE=UNKNOWN_DEFERRED",
    ];

    for (const line of requiredContract) expect(handoff).toContain(line);
    expect(handoff).toContain("Control Plane owner");
    expect(handoff).toContain("customer SaaS/dashboard owner");
  });

  it("validates the exact checksummed production-exporter fixture bundle and rejects its marked tampered cases", async () => {
    const fixtureUrl = new URL("./fixtures/swarm-hosted-v1-cases.json", import.meta.url);
    const checksumUrl = new URL("./fixtures/swarm-hosted-v1-cases.sha256", import.meta.url);
    const bytes = await readFile(fixtureUrl, "utf8");
    const expectedChecksum = (await readFile(checksumUrl, "utf8")).trim();
    const bundle = JSON.parse(bytes) as {
      schemaVersion: string;
      provenance: { producer: string; source: string };
      validCases: Array<{ name: string; envelope: SwarmHostedEnvelope }>;
      invalidCases: Array<{ name: string; tamper: string; envelope: unknown }>;
    };

    expect(createHash("sha256").update(bytes).digest("hex")).toBe(expectedChecksum);
    expect(bundle.schemaVersion).toBe("martin.swarm-hosted-fixtures.v1");
    expect(bundle.provenance).toEqual({
      producer: "buildSwarmHostedEnvelope",
      source: "phase5-production-layout",
    });
    expect(bundle.validCases.map((item) => item.name)).toEqual([
      "verified-15-agent",
      "stopped-blocking-dependency",
      "needs-review-child-failure",
      "failed-global-verifier",
      "reassigned-recovered",
    ]);
    for (const fixture of bundle.validCases) {
      expect(validateSwarmHostedEnvelope(fixture.envelope), fixture.name).toEqual({ ok: true, errors: [] });
    }
    expect(bundle.validCases[0]!.envelope.topology.children).toHaveLength(15);
    expect(bundle.invalidCases.map((item) => item.name)).toEqual([
      "tampered-envelope-identity",
      "tampered-parent-authority",
    ]);
    const identityTamper = bundle.invalidCases.find((item) => item.name === "tampered-envelope-identity")!;
    expect(validateSwarmHostedEnvelope(identityTamper.envelope), identityTamper.tamper).toMatchObject({ ok: false });
    const authorityTamper = bundle.invalidCases.find((item) => item.name === "tampered-parent-authority")!;
    const authorityEnvelope = authorityTamper.envelope as SwarmHostedEnvelope;
    expect(authorityEnvelope.envelopeId).toBe(computeSwarmHostedEnvelopeIdentity(authorityEnvelope));
    expect(validateSwarmHostedEnvelope(authorityEnvelope), authorityTamper.tamper).toEqual({
      ok: false,
      errors: [{
        code: "INVALID_HOSTED_AUTHORITY_BINDING",
        path: "parentOutcome.state",
        message: "verified parent requires persisted passed task/global states and verified receipt integrity",
      }],
    });

    expect(bytes).not.toMatch(/[A-Z]:\\|\/Users\/|\/home\/|sk-proj-|ghp_|npm_|xox[baprs]-|BEGIN (?:RSA |OPENSSH )?PRIVATE KEY/iu);
    for (const marker of [
      ["ML", "Core", "OSS", "Internal"].join("_"),
      ["ML", "Control", "Plane", "Internal"].join("_"),
      ["martin", "loop", "magic"].join("-"),
    ]) expect(bytes).not.toContain(marker);
    expect(bytes).not.toMatch(/localhost|\.git(?:hub)?\/|"(?:command|prompt|diff|stdout|stderr|payload|secret|token|privateKey)"\s*:/iu);
  });

  it("validates one portable authority-separated envelope for 1-N children", () => {
    const envelope = hostedFixture(2);
    expect(validateSwarmHostedEnvelope(envelope)).toEqual({ ok: true, errors: [] });
    expect(envelope.schemaVersion).toBe(SWARM_HOSTED_SCHEMA_VERSION);

    const fifteenGreen = hostedFixture(15, {
      parentState: "needs_review",
      globalState: "failed",
      taskState: "failed",
    });
    expect(validateSwarmHostedEnvelope(fifteenGreen)).toEqual({ ok: true, errors: [] });
    expect(fifteenGreen.topology.children).toHaveLength(15);
    expect(fifteenGreen.topology.children.every((child) => child.status === "verified")).toBe(true);
    expect(fifteenGreen.parentOutcome.state).toBe("needs_review");
    expect(fifteenGreen.globalVerification.state).toBe("failed");
    expect(JSON.stringify(fifteenGreen)).not.toContain('"verified":true');
  });

  it.each([
    ["unknown top-level", (value: Record<string, unknown>) => { value.rawEvents = []; }],
    ["raw event payload", (value: Record<string, unknown>) => {
      (value.events as Array<Record<string, unknown>>)[0]!.payload = { command: "cat .env" };
    }],
    ["local path", (value: Record<string, unknown>) => {
      (value.topology as { tasks: Array<Record<string, unknown>> }).tasks[0]!.path = "C:\\Users\\private";
    }],
    ["unsupported source", (value: Record<string, unknown>) => {
      (value.sourceSchemas as Record<string, unknown>).receipt = "martin.swarm-receipt.v2";
    }],
    ["duplicate sequence", (value: Record<string, unknown>) => {
      const events = value.events as Array<Record<string, unknown>>;
      events[1]!.sequence = events[0]!.sequence;
    }],
    ["non-contiguous sequence", (value: Record<string, unknown>) => {
      (value.events as Array<Record<string, unknown>>)[1]!.sequence = 99;
    }],
    ["dangling evidence", (value: Record<string, unknown>) => {
      const outcome = value.parentOutcome as { evidence: Array<Record<string, unknown>> };
      outcome.evidence[0]!.eventId = "missing-event";
    }],
    ["agent identity mismatch", (value: Record<string, unknown>) => {
      const topology = value.topology as { children: Array<Record<string, unknown>> };
      topology.children[0]!.agentId = "missing-agent";
    }],
    ["malformed signature", (value: Record<string, unknown>) => {
      (value.transportSignature as Record<string, unknown>).signatureHmacSha256 = "not-a-signature";
    }],
  ])("fails closed for %s", (_label, mutate) => {
    const envelope = structuredClone(hostedFixture(2)) as unknown as Record<string, unknown>;
    mutate(envelope);
    expect(validateSwarmHostedEnvelope(envelope)).toMatchObject({ ok: false });
  });

  it("accepts future optional data only under namespaced extensions", () => {
    const envelope = hostedFixture(1);
    envelope.extensions = { "com.martinloop.atlas": { presentationHint: "compact" } };
    envelope.envelopeId = computeSwarmHostedEnvelopeIdentity(envelope);
    expect(validateSwarmHostedEnvelope(envelope)).toEqual({ ok: true, errors: [] });

    const invalid = structuredClone(envelope) as unknown as Record<string, unknown>;
    (invalid.extensions as Record<string, unknown>).atlas = {};
    expect(validateSwarmHostedEnvelope(invalid)).toMatchObject({ ok: false });
  });

  it("canonicalizes transport bytes deterministically while excluding only the signature", () => {
    const first = hostedFixture(2);
    const second = structuredClone(first);
    second.transportSignature.signatureHmacSha256 = "f".repeat(64);
    expect(canonicalSwarmHostedTransportBytes(first)).toBe(canonicalSwarmHostedTransportBytes(second));
    expect(computeSwarmHostedEnvelopeIdentity(first)).toBe(first.envelopeId);

    second.budget.settledUsd += 0.01;
    expect(computeSwarmHostedEnvelopeIdentity(second)).not.toBe(first.envelopeId);
    expect(validateSwarmHostedEnvelope(second)).toMatchObject({ ok: false });
  });

  it("binds parent and global states to matching authoritative event evidence", () => {
    const missingParent = hostedFixture(1);
    missingParent.parentOutcome.evidence = [];
    missingParent.envelopeId = computeSwarmHostedEnvelopeIdentity(missingParent);
    expect(validateSwarmHostedEnvelope(missingParent)).toMatchObject({ ok: false });

    const contradictoryGlobal = hostedFixture(1);
    contradictoryGlobal.globalVerification.evidence = [contradictoryGlobal.parentOutcome.evidence[0]!];
    contradictoryGlobal.envelopeId = computeSwarmHostedEnvelopeIdentity(contradictoryGlobal);
    expect(validateSwarmHostedEnvelope(contradictoryGlobal)).toMatchObject({ ok: false });
  });

  it("requires authenticated receipt index and event-chain identities plus exact event idempotency keys", () => {
    const missingSourceIdentity = hostedFixture(1) as unknown as Record<string, unknown>;
    delete missingSourceIdentity.sourceIdentities;
    expect(validateSwarmHostedEnvelope(missingSourceIdentity)).toMatchObject({ ok: false });

    const mismatchedEventIdentity = hostedFixture(1);
    mismatchedEventIdentity.events[0]!.sourceIdempotencyKey = "different-idempotency-key";
    mismatchedEventIdentity.envelopeId = computeSwarmHostedEnvelopeIdentity(mismatchedEventIdentity);
    expect(validateSwarmHostedEnvelope(mismatchedEventIdentity)).toMatchObject({ ok: false });
  });

  it("rejects inconsistent task agent child attempt and event identity links", () => {
    const taskAgentMismatch = hostedFixture(2);
    taskAgentMismatch.topology.agents[1]!.taskIds = ["task-1"];
    taskAgentMismatch.envelopeId = computeSwarmHostedEnvelopeIdentity(taskAgentMismatch);
    expect(validateSwarmHostedEnvelope(taskAgentMismatch)).toMatchObject({ ok: false });

    const childAttemptMismatch = hostedFixture(1);
    childAttemptMismatch.events[0]!.attemptId = "attempt-other";
    childAttemptMismatch.envelopeId = computeSwarmHostedEnvelopeIdentity(childAttemptMismatch);
    expect(validateSwarmHostedEnvelope(childAttemptMismatch)).toMatchObject({ ok: false });
  });

  it("requires type-specific observed event identities", () => {
    const childStop = hostedFixture(1);
    childStop.events[0]!.type = "CHILD_STOPPED";
    delete childStop.events[0]!.attemptId;
    childStop.envelopeId = computeSwarmHostedEnvelopeIdentity(childStop);
    expect(validateSwarmHostedEnvelope(childStop)).toMatchObject({ ok: false });

    const global = hostedFixture(1);
    delete global.events.at(-2)!.verificationId;
    global.envelopeId = computeSwarmHostedEnvelopeIdentity(global);
    expect(validateSwarmHostedEnvelope(global)).toMatchObject({ ok: false });
  });

  it("rejects unsafe blocked-action strings, topology text, and recursive extension content", () => {
    const blocked = hostedFixture(1);
    blocked.events[0]!.type = "ACTION_BLOCKED";
    blocked.interventions.blockedActions = [{
      action: "npm test -- --token sk-proj-secret",
      reasonCode: "C:/private/repo",
      taskId: "task-1",
      agentId: "agent-1",
      attemptId: "attempt-1",
      evidence: [{ eventId: blocked.events[0]!.eventId, sequence: blocked.events[0]!.sequence }],
    }];
    blocked.envelopeId = computeSwarmHostedEnvelopeIdentity(blocked);
    expect(validateSwarmHostedEnvelope(blocked)).toMatchObject({ ok: false });

    const unsafeRole = hostedFixture(1);
    unsafeRole.topology.agents[0]!.role = "worker C:\\private\\repo";
    unsafeRole.envelopeId = computeSwarmHostedEnvelopeIdentity(unsafeRole);
    expect(validateSwarmHostedEnvelope(unsafeRole)).toMatchObject({ ok: false });

    const unsafeExtension = hostedFixture(1);
    unsafeExtension.extensions = { "com.martinloop.atlas": { token: "sk-proj-secret" } };
    unsafeExtension.envelopeId = computeSwarmHostedEnvelopeIdentity(unsafeExtension);
    expect(validateSwarmHostedEnvelope(unsafeExtension)).toMatchObject({ ok: false });
  });

  it("requires global verification to bind the latest global terminal before the parent terminal", () => {
    const envelope = hostedFixture(1);
    const parentEvent = envelope.events.pop()!;
    parentEvent.sequence += 1;
    envelope.events.push({
      eventId: "event-contradictory-global",
      sourceIdempotencyKey: "event-contradictory-global",
      sequence: parentEvent.sequence - 1,
      type: "GLOBAL_VERIFIER_FAILED",
      timestamp: "2026-10-03T13:00:30.000Z",
      verificationId: "verification-contradictory",
    });
    envelope.events.push(parentEvent);
    envelope.parentOutcome.evidence = [{ eventId: parentEvent.eventId, sequence: parentEvent.sequence }];
    envelope.envelopeId = computeSwarmHostedEnvelopeIdentity(envelope);

    expect(validateSwarmHostedEnvelope(envelope)).toMatchObject({ ok: false });
  });

  it("rejects mirrored reassignment evidence whose attempts do not resolve to real child identities", () => {
    const envelope = hostedFixture(2);
    envelope.topology.tasks[0]!.effectiveAgentId = "agent-2";
    envelope.topology.agents[1]!.taskIds.push("task-1");
    envelope.topology.children[1]!.taskIds.push("task-1");
    const parentEvent = envelope.events.pop()!;
    const globalEvent = envelope.events.pop()!;
    envelope.events.push({
      eventId: "event-ghost-reassignment",
      sourceIdempotencyKey: "event-ghost-reassignment",
      sequence: globalEvent.sequence,
      type: "TASK_REASSIGNED",
      timestamp: "2026-10-03T12:59:00.000Z",
      taskId: "task-1",
      agentId: "agent-1",
      attemptId: "ghost-attempt-from",
      relatedAttemptId: "ghost-attempt-to",
      toAgentId: "agent-2",
    });
    globalEvent.sequence += 1;
    parentEvent.sequence += 1;
    envelope.events.push(globalEvent, parentEvent);
    envelope.interventions.reassignments = [{
      taskId: "task-1",
      fromAgentId: "agent-1",
      toAgentId: "agent-2",
      fromAttemptId: "ghost-attempt-from",
      toAttemptId: "ghost-attempt-to",
      reasonCode: "failed_attempt",
      evidence: [{ eventId: "event-ghost-reassignment", sequence: globalEvent.sequence - 1 }],
    }];
    envelope.globalVerification.evidence = [{ eventId: globalEvent.eventId, sequence: globalEvent.sequence }];
    envelope.parentOutcome.evidence = [{ eventId: parentEvent.eventId, sequence: parentEvent.sequence }];
    envelope.envelopeId = computeSwarmHostedEnvelopeIdentity(envelope);

    expect(validateSwarmHostedEnvelope(envelope)).toMatchObject({ ok: false });
  });

  it("rejects common and opaque credential shapes in extensions and blocked-action codes", () => {
    for (const [key, value] of ([
      ["credential", `ghp_${"a1".repeat(20)}`],
      ["registryAuth", `npm_${"b2".repeat(20)}`],
      ["slackAuth", `xoxb-${"3c".repeat(20)}`],
      ["opaqueValue", "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6"],
    ] satisfies Array<[string, string]>)) {
      const envelope = hostedFixture(1);
      envelope.extensions = { "com.martinloop.atlas": { [key]: value } };
      envelope.envelopeId = computeSwarmHostedEnvelopeIdentity(envelope);
      expect(validateSwarmHostedEnvelope(envelope), `${key} must fail closed`).toMatchObject({ ok: false });
    }

    const blocked = hostedFixture(1);
    blocked.events[0]!.type = "ACTION_BLOCKED";
    blocked.interventions.blockedActions = [{
      action: `ghp_${"d4".repeat(20)}`,
      reasonCode: "credential_exposed",
      taskId: "task-1",
      agentId: "agent-1",
      attemptId: "attempt-1",
      evidence: [{ eventId: blocked.events[0]!.eventId, sequence: blocked.events[0]!.sequence }],
    }];
    blocked.envelopeId = computeSwarmHostedEnvelopeIdentity(blocked);
    expect(validateSwarmHostedEnvelope(blocked)).toMatchObject({ ok: false });
  });

  it("rejects unknown global state when a persisted terminal global result exists", () => {
    const envelope = hostedFixture(1);
    envelope.globalVerification.state = "unknown";
    delete envelope.globalVerification.verificationId;
    envelope.globalVerification.evidence = [];
    envelope.events.at(-1)!.type = "SWARM_NEEDS_REVIEW";
    envelope.parentOutcome.state = "needs_review";
    envelope.envelopeId = computeSwarmHostedEnvelopeIdentity(envelope);

    expect(validateSwarmHostedEnvelope(envelope)).toMatchObject({ ok: false });
  });

  it("rejects no-op reassignment to the same agent attempt and child", () => {
    const envelope = hostedFixture(1);
    const parentEvent = envelope.events.pop()!;
    const globalEvent = envelope.events.pop()!;
    envelope.events.push({
      eventId: "event-noop-reassignment",
      sourceIdempotencyKey: "event-noop-reassignment",
      sequence: globalEvent.sequence,
      type: "TASK_REASSIGNED",
      timestamp: "2026-10-03T12:59:00.000Z",
      taskId: "task-1",
      agentId: "agent-1",
      attemptId: "attempt-1",
      relatedAttemptId: "attempt-1",
      toAgentId: "agent-1",
    });
    globalEvent.sequence += 1;
    parentEvent.sequence += 1;
    envelope.events.push(globalEvent, parentEvent);
    envelope.interventions.reassignments = [{
      taskId: "task-1",
      fromAgentId: "agent-1",
      toAgentId: "agent-1",
      fromAttemptId: "attempt-1",
      toAttemptId: "attempt-1",
      reasonCode: "failed_attempt",
      evidence: [{ eventId: "event-noop-reassignment", sequence: globalEvent.sequence - 1 }],
    }];
    envelope.globalVerification.evidence = [{ eventId: globalEvent.eventId, sequence: globalEvent.sequence }];
    envelope.parentOutcome.evidence = [{ eventId: parentEvent.eventId, sequence: parentEvent.sequence }];
    envelope.envelopeId = computeSwarmHostedEnvelopeIdentity(envelope);

    expect(validateSwarmHostedEnvelope(envelope)).toMatchObject({ ok: false });
  });
});

function hostedFixture(
  childCount: number,
  states: {
    parentState?: "verified" | "stopped" | "needs_review";
    globalState?: "passed" | "failed" | "unknown";
    taskState?: "passed" | "failed" | "unknown";
  } = {},
): SwarmHostedEnvelope {
  const tasks = Array.from({ length: childCount }, (_, index) => ({
    taskId: `task-${index + 1}`,
    required: true,
    dependsOn: index === 0 ? [] : [`task-${index}`],
    plannedAgentId: `agent-${index + 1}`,
    effectiveAgentId: `agent-${index + 1}`,
    status: "accepted" as const,
  }));
  const agents = tasks.map((task, index) => ({
    agentId: `agent-${index + 1}`,
    role: "worker",
    status: "verified" as const,
    taskIds: [task.taskId],
    childRunId: `child-${index + 1}`,
  }));
  const events = tasks.flatMap((task, index) => ([
    {
      eventId: `event-${index * 2 + 1}`,
      sourceIdempotencyKey: `event-${index * 2 + 1}`,
      sequence: index * 2 + 1,
      type: "CHILD_STARTED" as const,
      timestamp: `2026-10-03T12:${String(index).padStart(2, "0")}:00.000Z`,
      taskId: task.taskId,
      agentId: agents[index]!.agentId,
      childRunId: agents[index]!.childRunId,
      attemptId: `attempt-${index + 1}`,
    },
    {
      eventId: `event-${index * 2 + 2}`,
      sourceIdempotencyKey: `event-${index * 2 + 2}`,
      sequence: index * 2 + 2,
      type: "CHILD_VERIFIED" as const,
      timestamp: `2026-10-03T12:${String(index).padStart(2, "0")}:30.000Z`,
      taskId: task.taskId,
      agentId: agents[index]!.agentId,
      childRunId: agents[index]!.childRunId,
      attemptId: `attempt-${index + 1}`,
    },
  ]));
  const globalState = states.globalState ?? "passed";
  const globalType = globalState === "passed" ? "GLOBAL_VERIFIER_PASSED" : "GLOBAL_VERIFIER_FAILED";
  events.push({
    eventId: `event-${events.length + 1}`,
    sourceIdempotencyKey: `event-${events.length + 1}`,
    sequence: events.length + 1,
    type: globalType,
    timestamp: "2026-10-03T13:00:00.000Z",
    verificationId: "verification-1",
  } as never);
  const parentState = states.parentState ?? "verified";
  events.push({
    eventId: `event-${events.length + 1}`,
    sourceIdempotencyKey: `event-${events.length + 1}`,
    sequence: events.length + 1,
    type: parentState === "verified" ? "SWARM_VERIFIED" : "SWARM_NEEDS_REVIEW",
    timestamp: "2026-10-03T13:01:00.000Z",
  } as never);

  const envelope = {
    schemaVersion: SWARM_HOSTED_SCHEMA_VERSION,
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
    runtimeVersion: "0.7.1",
    createdAt: "2026-10-03T13:02:00.000Z",
    swarm: {
      swarmId: "swarm-hosted",
      workspaceId: "workspace-hosted",
      projectId: "project-hosted",
      planHash: "a".repeat(64),
      baselineCommit: "b".repeat(40),
    },
    topology: {
      tasks,
      agents,
      children: tasks.map((task, index) => ({
        childRunId: agents[index]!.childRunId!,
        agentId: agents[index]!.agentId,
        attemptId: `attempt-${index + 1}`,
        taskIds: [task.taskId],
        status: "verified" as const,
        receiptIntegrityState: "verified" as const,
        evidence: [
          { eventId: `event-${index * 2 + 1}`, sequence: index * 2 + 1 },
          { eventId: `event-${index * 2 + 2}`, sequence: index * 2 + 2 },
        ],
      })),
    },
    budget: { capUsd: childCount, settledUsd: childCount * 0.1, settledTokens: childCount * 100 },
    interventions: { blockedActions: [], reassignments: [] },
    integration: { admissions: [], rejections: [], conflicts: [], integratedTreeHash: "c".repeat(40) },
    events,
    globalVerification: {
      state: globalState,
      verificationId: "verification-1",
      integratedTreeHash: "c".repeat(40),
      evidence: [{ eventId: `event-${events.length - 1}`, sequence: events.length - 1 }],
    },
    parentOutcome: {
      state: parentState,
      source: "sealed_parent_receipt" as const,
      evidence: [{ eventId: `event-${events.length}`, sequence: events.length }],
    },
    taskVerificationState: states.taskState ?? "passed",
    receiptIntegrityState: "verified" as const,
    transportSignature: {
      algorithm: "hmac-sha256" as const,
      keyId: "hosted-key-1",
      keyLocatorHash: "d".repeat(64),
      signatureHmacSha256: "e".repeat(64),
    },
  } satisfies SwarmHostedEnvelope;
  envelope.envelopeId = computeSwarmHostedEnvelopeIdentity(envelope);
  return envelope;
}
