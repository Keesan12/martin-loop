import { createHash, createHmac } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  computeSwarmLivePlanHash,
  type SwarmLiveEvent,
  type SwarmLivePlan,
  type SwarmParentReceipt,
} from "@martin/contracts";
import { canonicalSwarmHostedTransportBytes, validateSwarmHostedEnvelope } from "../../contracts/dist/swarm-hosted.js";
import { beforeAll, describe, expect, it, vi } from "vitest";

import {
  buildSwarmHostedEnvelopeWithDependencies,
  deriveHostedTransportKeyMaterial,
  type BuildSwarmHostedEnvelopeDependencies,
} from "../src/swarm/hosted-export.js";
import {
  buildProductionSwarmHostedFixtureEvidenceIndexDiagnostic,
  buildProductionSwarmHostedFixtureBundle,
  canonicalSwarmHostedFixtureBundleBytes,
} from "./helpers/swarm-hosted-fixture-builder.js";

describe.sequential("authenticated swarm hosted exporter", () => {
  let firstProductionBundle: Awaited<ReturnType<typeof buildProductionSwarmHostedFixtureBundle>>;
  let firstProductionBundleBytes: string;
  let frozenProductionBundleBytes: string;
  let frozenProductionBundleChecksum: string;
  let secondProductionBundle: Awaited<ReturnType<typeof buildProductionSwarmHostedFixtureBundle>>;
  let secondProductionBundleBytes: string;

  beforeAll(async () => {
    firstProductionBundle = await buildProductionSwarmHostedFixtureBundle();
    firstProductionBundleBytes = canonicalSwarmHostedFixtureBundleBytes(firstProductionBundle);
    frozenProductionBundleBytes = await readFile(
      new URL("../../contracts/tests/fixtures/swarm-hosted-v1-cases.json", import.meta.url),
      "utf8",
    );
    frozenProductionBundleChecksum = (await readFile(
      new URL("../../contracts/tests/fixtures/swarm-hosted-v1-cases.sha256", import.meta.url),
      "utf8",
    )).trim();
  }, 120_000);

  beforeAll(async () => {
    secondProductionBundle = await buildProductionSwarmHostedFixtureBundle();
    secondProductionBundleBytes = canonicalSwarmHostedFixtureBundleBytes(secondProductionBundle);
  }, 120_000);

  it("rebuilds the reassigned recovery evidence-index artifact hashes exactly", async () => {
    const first = await buildProductionSwarmHostedFixtureEvidenceIndexDiagnostic("reassigned-recovered");
    const second = await buildProductionSwarmHostedFixtureEvidenceIndexDiagnostic("reassigned-recovered");
    const firstDifference = first.files.find((file, index) => (
      JSON.stringify(file) !== JSON.stringify(second.files[index])
    ));

    expect({ firstDifference, firstCount: first.files.length, secondCount: second.files.length }).toEqual({
      firstDifference: undefined,
      firstCount: second.files.length,
      secondCount: second.files.length,
    });
  }, 120_000);

  it("rebuilds the exact frozen production-layout bundle and checksum through the production exporter", () => {
    expect(firstProductionBundleBytes).toBe(frozenProductionBundleBytes);
    expect(createHash("sha256").update(firstProductionBundleBytes).digest("hex"))
      .toBe(frozenProductionBundleChecksum);
    expect(firstProductionBundle.validCases.every((item) => item.provenance === "production-exporter")).toBe(true);
    expect(firstProductionBundle.invalidCases.every((item) => item.provenance === "tampered-copy")).toBe(true);
  }, 120_000);

  it("rebuilds the complete production-layout bundle twice with identical canonical bytes and checksum", () => {
    const firstChecksum = createHash("sha256").update(firstProductionBundleBytes).digest("hex");
    const secondChecksum = createHash("sha256").update(secondProductionBundleBytes).digest("hex");

    expect(secondProductionBundleBytes).toBe(firstProductionBundleBytes);
    expect(secondProductionBundleBytes).toBe(frozenProductionBundleBytes);
    expect(secondChecksum).toBe(firstChecksum);
    expect(secondChecksum).toBe(frozenProductionBundleChecksum);
  }, 120_000);

  it("retains an authorized production admission through the live store, seal, and hosted export", () => {
    const fixture = secondProductionBundle.validCases.find((item) => item.name === "reassigned-recovered");
    const admitted = fixture?.envelope.events.find((event) => event.type === "CHILD_PATCH_ADMITTED");

    expect(admitted).toMatchObject({
      taskId: "task-1",
      agentId: "agent-recovery",
      childRunId: expect.stringMatching(/^child-run-/u),
      attemptId: expect.stringMatching(/^attempt-/u),
      candidateId: expect.stringMatching(/^candidate-/u),
    });
    expect(fixture?.envelope.integration.admissions).toEqual([
      expect.objectContaining({
        candidateId: admitted?.candidateId,
        taskId: admitted?.taskId,
        agentId: admitted?.agentId,
        childRunId: admitted?.childRunId,
        state: "admitted",
        evidence: [{ eventId: admitted?.eventId, sequence: admitted?.sequence }],
      }),
    ]);
    expect(fixture?.sansa.facts).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "recovery", derivationKind: "deterministic_graph_derivation" }),
    ]));
  }, 120_000);

  it("projects one committed seal into deterministic privacy-safe signed bytes", async () => {
    const fixture = acceptedFixture();
    const first = await buildSwarmHostedEnvelopeWithDependencies(fixture.input, fixture.dependencies);
    const second = await buildSwarmHostedEnvelopeWithDependencies(fixture.input, fixture.dependencies);

    expect(first).toEqual(second);
    expect(first.envelope.sourceIdentities).toEqual({
      receiptId: "receipt-hosted-1",
      receiptSha256: "1".repeat(64),
      evidenceIndexSha256: "2".repeat(64),
      eventChainSha256: "3".repeat(64),
    });
    expect(first.envelope.swarm).toEqual({
      swarmId: "swarm-hosted-1",
      workspaceId: "workspace-hosted-1",
      projectId: "project-hosted-1",
      planHash: fixture.plan.planHash,
      baselineCommit: "b".repeat(40),
    });
    expect(first.envelope.events.map((event) => [event.eventId, event.sourceIdempotencyKey])).toEqual([
      ["child-verified-1", "child-verified-1"],
      ["global-passed-1", "global-passed-1"],
      ["parent-verified-1", "parent-verified-1"],
    ]);
    expect(first.envelope.events[0]).not.toHaveProperty("payload");
    expect(first.transportKey).toEqual({
      keyId: "hosted-key-id",
      keyLocatorHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
      domain: "martin.swarm-hosted.v1",
    });
    expect(first.canonicalBody).toBe(`${JSON.stringify(first.envelope)}\n`);
    expect(first.payloadSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(first.envelopeIdentity).toBe(first.envelope.envelopeId);
    expect(validateSwarmHostedEnvelope(first.envelope)).toEqual({ ok: true, errors: [] });
    expect(first.envelope.transportSignature.signatureHmacSha256).toBe(
      createHmac("sha256", "hosted-secret")
        .update(`martin.swarm-hosted.v1\n${canonicalSwarmHostedTransportBytes(first.envelope)}`)
        .digest("hex"),
    );
    expect(first.canonicalBody).not.toContain("hosted-secret");
    expect(first.canonicalBody).not.toContain("C:\\private");
  });

  it("binds production-shaped child lifecycle events to the receipt attempt identity", async () => {
    const fixture = acceptedFixture({ omitChildEventAttemptId: true });

    const exported = await buildSwarmHostedEnvelopeWithDependencies(fixture.input, fixture.dependencies);

    const childEvents = exported.envelope.events.filter((event) => event.childRunId === "child-1");
    expect(childEvents).toHaveLength(1);
    expect(childEvents[0]).toMatchObject({
      type: "CHILD_VERIFIED",
      childRunId: "child-1",
      agentId: "agent-1",
      taskId: "task-1",
      attemptId: "attempt-1",
    });
    expect(exported.envelope.topology.children[0]?.evidence).toEqual([
      { eventId: "child-verified-1", sequence: 1 },
    ]);
  });

  it("rejects a child lifecycle identity that contradicts its authenticated receipt linkage", async () => {
    const fixture = acceptedFixture({ childEventAttemptId: "attempt-other" });

    await expect(buildSwarmHostedEnvelopeWithDependencies(fixture.input, fixture.dependencies))
      .rejects.toThrow(/SWARM_HOSTED_SOURCE_MISMATCH|HOSTED_CHILD_EVIDENCE_MISMATCH/u);
  });

  it.each(["", 42, "sk-proj-sensitiveattempt"])(
    "rejects a present malformed child attempt identity before receipt derivation: %j",
    async (childEventAttemptId) => {
      const fixture = acceptedFixture({ childEventAttemptId });

      await expect(buildSwarmHostedEnvelopeWithDependencies(fixture.input, fixture.dependencies))
        .rejects.toThrow(/SWARM_HOSTED_SOURCE_MISMATCH|INVALID_HOSTED_IDENTIFIER/u);
    },
  );

  it("fails before hosted key access when the committed receipt projection is not authentic or identities disagree", async () => {
    const fixture = acceptedFixture();
    const ensureHostedTransportKey = vi.fn(fixture.dependencies.ensureHostedTransportKey);
    const dependencies = { ...fixture.dependencies, ensureHostedTransportKey };

    await expect(buildSwarmHostedEnvelopeWithDependencies(fixture.input, {
      ...dependencies,
      readReceiptProjection: async () => ({
        ...(await fixture.dependencies.readReceiptProjection(fixture.input)),
        integrity: { state: "tamper_detected", reason: "changed bytes" },
      }),
    })).rejects.toThrow(/SWARM_HOSTED_INTEGRITY_NOT_VERIFIED/u);

    await expect(buildSwarmHostedEnvelopeWithDependencies(fixture.input, {
      ...dependencies,
      readReceiptProjection: async () => {
        const accepted = await fixture.dependencies.readReceiptProjection(fixture.input);
        return { ...accepted, integrity: { ...accepted.integrity, receiptSha256: "9".repeat(64) } };
      },
    })).rejects.toThrow(/SWARM_HOSTED_SOURCE_MISMATCH/u);

    await expect(buildSwarmHostedEnvelopeWithDependencies(fixture.input, {
      ...dependencies,
      readOperationalState: async () => ({
        ...(await fixture.dependencies.readOperationalState({ runsRoot: fixture.input.runsRoot, swarmId: fixture.input.swarmId })),
        plan: { ...fixture.plan, workspaceId: "workspace-other" },
      }),
    })).rejects.toThrow(/SWARM_HOSTED_SOURCE_MISMATCH/u);

    expect(ensureHostedTransportKey).not.toHaveBeenCalled();
  });

  it("derives hosted signing material from the existing receipt key without creating a second secret file", async () => {
    const root = await mkdtemp(join(tmpdir(), "martin-hosted-key-"));
    const runsRoot = join(root, "runs");
    const integrityRoot = join(root, "integrity");
    const swarmId = "swarm-hosted-key";
    await mkdir(runsRoot, { recursive: true });
    const rootHash = createHash("sha256").update(runsRoot).digest("hex").slice(0, 16);
    const keyDir = join(integrityRoot, rootHash);
    await mkdir(keyDir, { recursive: true });
    await writeFile(join(keyDir, `swarm-${swarmId}.key`), "receipt-secret\n", "utf8");
    process.env["MARTIN_INTEGRITY_KEY_DIR"] = integrityRoot;
    try {
      const before = await readdir(keyDir);
      const first = await deriveHostedTransportKeyMaterial({ runsRoot, swarmId });
      const second = await deriveHostedTransportKeyMaterial({ runsRoot, swarmId });
      const after = await readdir(keyDir);

      expect(first).toEqual(second);
      expect(first.keyId).toMatch(/^hosted-[a-f0-9]{16}$/u);
      expect(first.secret).not.toBe("receipt-secret");
      expect(after).toEqual(before);
      expect(after).toEqual([`swarm-${swarmId}.key`]);
    } finally {
      delete process.env["MARTIN_INTEGRITY_KEY_DIR"];
      await rm(root, { recursive: true, force: true });
    }
  });

  it("root-exports only the high-level exporter and no signing-key authority", async () => {
    const core = await import("../src/index.js");

    expect(core).toHaveProperty("buildSwarmHostedEnvelope");
    expect(core).not.toHaveProperty("buildSwarmHostedEnvelopeWithDependencies");
    expect(core).not.toHaveProperty("ensureHostedTransportKey");
    expect(core).not.toHaveProperty("readHostedTransportKey");
  });
});

function acceptedFixture(options: {
  omitChildEventAttemptId?: boolean;
  childEventAttemptId?: unknown;
} = {}): {
  input: { runsRoot: string; swarmId: string; runtimeVersion: string };
  plan: SwarmLivePlan;
  dependencies: BuildSwarmHostedEnvelopeDependencies;
} {
  const plan = {
    schemaVersion: "martin.swarm.v1",
    planId: "plan-hosted-1",
    swarmId: "swarm-hosted-1",
    workspaceId: "workspace-hosted-1",
    projectId: "project-hosted-1",
    baselineCommit: "b".repeat(40),
    parentContract: {
      objective: "Ship one governed result",
      budget: { maxDollars: 10, maxTokens: 50_000 },
    },
    tasks: [{
      taskId: "task-1",
      title: "Task one",
      objective: "Complete task one",
      required: true,
      dependsOn: [],
      assignedAgentId: "agent-1",
      status: "queued",
      mutationMode: "write",
      writeScope: ["src/**"],
    }],
    agents: [{
      agentId: "agent-1",
      role: "worker",
      status: "queued",
      contract: { agentId: "agent-1", taskIds: ["task-1"] },
    }],
    engine: { engine: "codex", model: "gpt-explicit" },
    childMaxIterations: 1,
    createdAt: "2026-10-03T12:00:00.000Z",
    planHash: "0".repeat(64),
  } as unknown as SwarmLivePlan;
  plan.planHash = computeSwarmLivePlanHash(plan);
  const events: SwarmLiveEvent[] = [
    event(1, "child-verified-1", "CHILD_VERIFIED", plan.planHash, {
      taskId: "task-1",
      agentId: "agent-1",
      childRunId: "child-1",
      payload: {
        ...(!options.omitChildEventAttemptId
          ? { attemptId: Object.prototype.hasOwnProperty.call(options, "childEventAttemptId")
            ? options.childEventAttemptId
            : "attempt-1" }
          : {}),
        privatePath: "C:\\private\\repo",
        secret: "sk-proj-redacted",
      },
    }),
    event(2, "global-passed-1", "GLOBAL_VERIFIER_PASSED", plan.planHash, {
      payload: { verificationId: "verification-1", integratedTreeHash: "c".repeat(40) },
    }),
    event(3, "parent-verified-1", "SWARM_VERIFIED", plan.planHash, { payload: { reason: "verified" } }),
  ];
  const receipt = {
    schemaVersion: "martin.swarm-receipt.v1",
    receiptId: "receipt-hosted-1",
    receiptSha256: "1".repeat(64),
    swarmId: plan.swarmId,
    planHash: plan.planHash,
    objective: plan.parentContract.objective,
    engine: plan.engine,
    baselineCommit: plan.baselineCommit,
    tasks: [{ ...plan.tasks[0], status: "accepted" }],
    agents: [{ ...plan.agents[0], status: "verified", childRunId: "child-1" }],
    budget: { maxDollars: 10, maxTokens: 50_000 },
    budgetLedger: { capUsd: 10, capTokens: 50_000, settledUsd: 1.25, settledTokens: 2_500, leases: [] },
    childReceipts: [{
      childRunId: "child-1",
      agentId: "agent-1",
      attemptId: "attempt-1",
      taskIds: ["task-1"],
      receiptIntegritySha256: "4".repeat(64),
    }],
    blockedActions: [],
    reassignments: [],
    events,
    evidenceIndexSha256: "2".repeat(64),
    evidenceFiles: [],
    evidenceBindings: { admissions: [], rejections: [], conflicts: [], integration: [], globalVerification: [], cleanup: [] },
    integratedTreeHash: "c".repeat(40),
    globalVerificationId: "verification-1",
    parentOutcome: { state: "verified", reason: "verified", verifiedAt: "2026-10-03T12:00:03.000Z" },
    taskVerificationState: "passed",
    sealedAt: "2026-10-03T12:00:04.000Z",
  } as unknown as SwarmParentReceipt;
  return {
    input: { runsRoot: "C:\\runs", swarmId: plan.swarmId, runtimeVersion: "0.8.0" },
    plan,
    dependencies: {
      readOperationalState: async () => ({
        plan,
        snapshot: { outcome: receipt.parentOutcome },
        events,
      } as never),
      readReceiptProjection: async () => ({
        receipt,
        integrity: {
          state: "verified",
          taskVerificationState: "passed",
          keyId: "local-receipt-key",
          signedAt: receipt.sealedAt,
          receiptSha256: receipt.receiptSha256,
          evidenceIndexSha256: receipt.evidenceIndexSha256,
          eventChainHead: "3".repeat(64),
        },
        seal: {
          schemaVersion: "martin.swarm-receipt-seal.v1",
          swarmId: plan.swarmId,
          planHash: plan.planHash,
          receiptSha256: "5".repeat(64),
          evidenceIndexSha256: receipt.evidenceIndexSha256,
          integrityMaterialSha256: "6".repeat(64),
          committedAt: receipt.sealedAt,
          commitHmacSha256: "7".repeat(64),
        },
      } as never),
      ensureHostedTransportKey: async () => ({ secret: "hosted-secret", keyId: "hosted-key-id" }),
    },
  };
}

function event(
  sequence: number,
  idempotencyKey: string,
  type: SwarmLiveEvent["type"],
  planHash: string,
  fields: Partial<SwarmLiveEvent>,
): SwarmLiveEvent {
  return {
    schemaVersion: "martin.swarm.v1",
    sequence,
    idempotencyKey,
    type,
    swarmId: "swarm-hosted-1",
    timestamp: `2026-10-03T12:00:0${sequence}.000Z`,
    parentPolicyVersion: "v1",
    planHash,
    payload: {},
    ...fields,
  };
}
