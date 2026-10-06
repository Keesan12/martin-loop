import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { SwarmParentReceipt } from "@martin/contracts";

import {
  buildSwarmShareProjectionWithDependencies,
  readSwarmDossierWithDependencies,
  verifySwarmEvidenceWithDependencies,
  type SwarmEvidenceProjectionDependencies,
} from "../src/swarm/evidence-projection.js";
import { readSwarmReceiptProjection } from "../src/swarm/live-runtime.js";

const scratch: string[] = [];

afterEach(async () => {
  await Promise.all(scratch.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("swarm evidence projection facade", () => {
  it("pins latest once and exposes integrity and task verification as separate states", async () => {
    const dependencies = evidenceDependencies(receiptFixture());

    const dossier = await readSwarmDossierWithDependencies(
      { runsRoot: "C:/runs", latest: true },
      dependencies,
    );

    expect(dependencies.readOperationalState).toHaveBeenCalledOnce();
    expect(dependencies.readReceiptProjection).toHaveBeenCalledWith({
      runsRoot: "C:/runs",
      swarmId: "swarm-evidence",
    });
    expect(dossier).toMatchObject({
      schemaVersion: "martin.swarm-dossier.v1",
      swarmId: "swarm-evidence",
      integrityState: "verified",
      taskVerificationState: "passed",
      parentOutcome: { state: "verified" },
    });
  });

  it("reports intact failed task evidence without promoting it to verified", async () => {
    const receipt = receiptFixture();
    receipt.taskVerificationState = "failed";
    receipt.parentOutcome = { state: "needs_review", reason: "global_verifier_failed" };
    const verification = await verifySwarmEvidenceWithDependencies(
      { runsRoot: "C:/runs", swarmId: receipt.swarmId },
      evidenceDependencies(receipt),
    );

    expect(verification).toMatchObject({
      integrityState: "verified",
      taskVerificationState: "failed",
      parentOutcomeState: "needs_review",
      verified: false,
    });
  });

  it("does not expose raw evidence mutation or signing authority from the Core root", async () => {
    const publicCore = await import("../src/index.js");
    expect(publicCore).toHaveProperty("readSwarmDossier");
    expect(publicCore).toHaveProperty("verifySwarmEvidence");
    expect(publicCore).toHaveProperty("buildSwarmShareProjection");
    expect(publicCore).not.toHaveProperty("readSwarmDossierWithDependencies");
    expect(publicCore).not.toHaveProperty("appendSwarmEvidence");
    expect(publicCore).not.toHaveProperty("signSwarmReceipt");
  });

  it("fails closed for sharing until integrity, task verification, and parent outcome all verify", async () => {
    const receipt = receiptFixture();
    receipt.taskVerificationState = "failed";
    receipt.parentOutcome = { state: "needs_review", reason: "global_verifier_failed" };

    await expect(buildSwarmShareProjectionWithDependencies(
      { runsRoot: "C:/runs", swarmId: receipt.swarmId },
      evidenceDependencies(receipt),
    )).rejects.toMatchObject({ code: "SWARM_SHARE_NOT_VERIFIED" });
  });

  it("returns a deterministic share projection with secret-bearing and path-bearing private fields removed or redacted", async () => {
    const receipt = receiptFixture();
    receipt.objective = "Fix C:\\Users\\Keesan\\private-repo with sk-proj-share-secret-123456789";
    receipt.engine.model = "sk-proj-share-model-secret-123456789";
    receipt.tasks[0]!.objective = "Read C:\\Users\\Keesan\\private.ts";

    const first = await buildSwarmShareProjectionWithDependencies(
      { runsRoot: "C:/runs", swarmId: receipt.swarmId },
      evidenceDependencies(receipt),
    );
    const second = await buildSwarmShareProjectionWithDependencies(
      { runsRoot: "C:/runs", swarmId: receipt.swarmId },
      evidenceDependencies(receipt),
    );
    const serialized = JSON.stringify(first);

    expect(first).toEqual(second);
    expect(first.generatedAt).toBe(receipt.sealedAt);
    expect(serialized).not.toContain("sk-proj-share");
    expect(serialized).not.toContain("C:\\Users\\Keesan");
    expect(serialized).not.toContain("private-repo");
    expect(serialized).toContain("[REDACTED");
  });

  it("types malformed committed receipt JSON through the real production reader", async () => {
    const runsRoot = await mkdtemp(join(tmpdir(), "martin-swarm-evidence-malformed-"));
    scratch.push(runsRoot);
    const evidenceRoot = join(runsRoot, "_swarms", "swarm-evidence", "evidence");
    await mkdir(evidenceRoot, { recursive: true });
    await Promise.all([
      writeFile(join(evidenceRoot, "parent-receipt.json"), "{broken", "utf8"),
      writeFile(join(evidenceRoot, "evidence-index.json"), "{}\n", "utf8"),
      writeFile(join(evidenceRoot, "swarm-receipt-integrity.json"), "{}\n", "utf8"),
      writeFile(join(evidenceRoot, "swarm-receipt-seal.json"), "{}\n", "utf8"),
    ]);
    const dependencies = evidenceDependencies(receiptFixture());
    dependencies.readReceiptProjection = readSwarmReceiptProjection;

    await expect(readSwarmDossierWithDependencies(
      { runsRoot, swarmId: "swarm-evidence" },
      dependencies,
    )).rejects.toMatchObject({ code: "MALFORMED_JSON" });
  });
});

function evidenceDependencies(receipt: SwarmParentReceipt): SwarmEvidenceProjectionDependencies {
  return {
    readOperationalState: vi.fn(async () => ({
      plan: { swarmId: receipt.swarmId },
      snapshot: { swarmId: receipt.swarmId },
      events: [],
    }) as never),
    readReceiptProjection: vi.fn(async () => ({
      receipt,
      integrity: {
        state: "verified" as const,
        taskVerificationState: receipt.taskVerificationState,
      },
      seal: {
        schemaVersion: "martin.swarm-receipt-seal.v1" as const,
        swarmId: receipt.swarmId,
        planHash: receipt.planHash,
        receiptSha256: "1".repeat(64),
        evidenceIndexSha256: receipt.evidenceIndexSha256,
        integrityMaterialSha256: "2".repeat(64),
        committedAt: receipt.sealedAt,
        commitHmacSha256: "3".repeat(64),
      },
    })),
  };
}

function receiptFixture(): SwarmParentReceipt {
  return {
    schemaVersion: "martin.swarm-receipt.v1",
    receiptId: "swarm-receipt-evidence",
    receiptSha256: "a".repeat(64),
    swarmId: "swarm-evidence",
    planHash: "b".repeat(64),
    objective: "Ship governed evidence",
    engine: { engine: "codex", model: "gpt-test" },
    baselineCommit: "c".repeat(40),
    tasks: [{
      taskId: "task-a", title: "Task A", objective: "Implement A", required: true,
      dependsOn: [], assignedAgentId: "agent-a", status: "accepted", mutationMode: "read_only", writeScope: [],
    }],
    agents: [{
      agentId: "agent-a", role: "worker", status: "verified", childRunId: "child-a",
      contract: {
        agentId: "agent-a", taskIds: ["task-a"], scope: { allowedPaths: ["src/**"], deniedPaths: [] },
        budget: { maxUsd: 1, softLimitUsd: 0.5, maxIterations: 1 }, maxWallClockMs: 1_000,
        permissions: { networkDomains: [], commands: ["pnpm test"] }, approvalPolicy: {}, verifierAuthority: "child_only",
      },
    }],
    budget: { maxUsd: 2, softLimitUsd: 1, maxIterations: 2 },
    budgetLedger: { capUsd: 2, settledUsd: 0.25, settledTokens: 100, leases: [] },
    childReceipts: [{
      childRunId: "child-a", agentId: "agent-a", attemptId: "attempt-a",
      taskIds: ["task-a"], receiptIntegritySha256: "d".repeat(64),
    }],
    blockedActions: [],
    reassignments: [],
    events: [],
    evidenceIndexSha256: "e".repeat(64),
    evidenceFiles: [{ kind: "operational", path: "snapshot.json", sha256: "f".repeat(64), bytes: 12 }],
    evidenceBindings: {
      admissions: [], rejections: [], conflicts: [], integration: [], globalVerification: [], cleanup: [],
    },
    integratedTreeHash: "1".repeat(40),
    globalVerificationId: "verify-a",
    parentOutcome: { state: "verified", reason: "global_verifier_passed" },
    taskVerificationState: "passed",
    sealedAt: "2026-10-03T12:00:00.000Z",
  };
}
