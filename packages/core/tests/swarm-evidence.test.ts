import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createSwarmLivePlan, type LoopRecord, type SwarmLivePlan } from "@martin/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { writeReceiptIntegrityMaterial } from "../src/persistence/integrity.js";
import { readAndSealSwarmEvidence } from "../src/swarm/evidence.js";
import { createSwarmLiveStore } from "../src/swarm/live-store.js";

const scratch: string[] = [];
let previousIntegrityKeyDir: string | undefined;

beforeEach(() => {
  previousIntegrityKeyDir = process.env.MARTIN_INTEGRITY_KEY_DIR;
});

afterEach(async () => {
  if (previousIntegrityKeyDir === undefined) delete process.env.MARTIN_INTEGRITY_KEY_DIR;
  else process.env.MARTIN_INTEGRITY_KEY_DIR = previousIntegrityKeyDir;
  await Promise.all(scratch.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("readAndSealSwarmEvidence", () => {
  it("rejects an aliased evidence root before publishing the Phase 5 index", async () => {
    const fixture = await createEvidenceFixture();
    const actualEvidenceRoot = join(fixture.swarmRoot, "evidence-actual");
    await rename(fixture.evidenceRoot, actualEvidenceRoot);
    await symlink(actualEvidenceRoot, fixture.evidenceRoot, process.platform === "win32" ? "junction" : "dir");

    await expect(readAndSealSwarmEvidence({
      rootDir: fixture.rootDir,
      swarmId: fixture.plan.swarmId
    })).rejects.toMatchObject({ code: "EVIDENCE_PATH_ALIAS" });
    expect(await readdir(actualEvidenceRoot)).not.toContain("evidence-index.json");
  });

  it("seals exact Phase 4 bytes and referenced artifacts without rewriting operational files", async () => {
    const fixture = await createEvidenceFixture();
    const before = await captureOperationalFiles(fixture);

    const result = await readAndSealSwarmEvidence({
      rootDir: fixture.rootDir,
      swarmId: fixture.plan.swarmId
    });

    expect(result.index).toMatchObject({
      schemaVersion: "martin.swarm-evidence-index.v1",
      swarmId: fixture.plan.swarmId,
      planHash: fixture.plan.planHash,
      outcome: { state: "stopped" }
    });
    const eventsEntry = result.index.files.find((file) => file.path === "events.jsonl");
    expect(eventsEntry?.sha256).toBe(sha256(await readFile(fixture.store.paths().events)));
    expect(result.index.files.map((file) => file.path)).toEqual(expect.arrayContaining([
      "plan.json",
      "start-claim.json",
      "event-claims/000000000001.json",
      "events.jsonl",
      "snapshot.json",
      "evidence/child-completions/child.json",
      "evidence/cleanup/cleanup.json",
      "evidence/integration-outcomes/outcome.json",
      "evidence/integration-reconstructions/integration.json",
      "evidence/global-verification/verifier.json",
      "evidence/process-closures/closure.json",
      "child-a/loop-record.json",
      "child-a/ledger.jsonl",
      "child-a/receipt-integrity.json"
    ]));
    expect(JSON.parse(await readFile(result.indexPath, "utf8"))).toEqual(result.index);
    await assertOperationalFilesUnchanged(before);
  });

  it("ignores Phase 5 seal outputs so orphan recovery and resealing are idempotent", async () => {
    const fixture = await createEvidenceFixture();
    const first = await readAndSealSwarmEvidence({
      rootDir: fixture.rootDir,
      swarmId: fixture.plan.swarmId
    });
    const firstBytes = await readFile(first.indexPath, "utf8");
    for (const name of [
      "parent-receipt.json",
      "swarm-receipt-integrity.json",
      "swarm-receipt-seal.json",
      "swarm-receipt-seal-status.json"
    ]) {
      await writeFile(join(fixture.evidenceRoot, name), `${JSON.stringify({ orphan: name })}\n`, "utf8");
    }

    const retried = await readAndSealSwarmEvidence({
      rootDir: fixture.rootDir,
      swarmId: fixture.plan.swarmId
    });

    expect(retried.index).toEqual(first.index);
    expect(retried.indexBytes).toBe(firstBytes);
    expect(await readFile(first.indexPath, "utf8")).toBe(firstBytes);
    expect(retried.index.files.some((file) => /parent-receipt|swarm-receipt/u.test(file.path))).toBe(false);
  });

  it("fails closed on missing referenced child evidence without creating replacement files", async () => {
    const fixture = await createEvidenceFixture();
    await rm(join(fixture.evidenceRoot, "child-completions", "child.json"));
    const beforeEntries = await recursiveEntries(fixture.swarmRoot);

    await expect(readAndSealSwarmEvidence({
      rootDir: fixture.rootDir,
      swarmId: fixture.plan.swarmId
    })).rejects.toMatchObject({ code: "MISSING_CHILD_EVIDENCE" });

    expect(await recursiveEntries(fixture.swarmRoot)).toEqual(beforeEntries);
  });

  it("rejects malformed artifact JSON and leaves the operational store byte-identical", async () => {
    const fixture = await createEvidenceFixture();
    const before = await captureOperationalFiles(fixture);
    await writeFile(join(fixture.evidenceRoot, "global-verification", "verifier.json"), "{broken", "utf8");

    await expect(readAndSealSwarmEvidence({
      rootDir: fixture.rootDir,
      swarmId: fixture.plan.swarmId
    })).rejects.toMatchObject({ code: "MALFORMED_SWARM_EVIDENCE" });

    await assertOperationalFilesUnchanged(before);
  });

  it.each([
    ["loop-record.json", "MALFORMED_CHILD_RUN_PROOF"],
    ["ledger.jsonl", "CHILD_RECEIPT_INTEGRITY_INVALID"]
  ] as const)("rejects tampered child %s proof", async (file, code) => {
    const fixture = await createEvidenceFixture();
    await writeFile(join(fixture.rootDir, "child-a", file), "tampered\n", "utf8");

    await expect(readAndSealSwarmEvidence({
      rootDir: fixture.rootDir,
      swarmId: fixture.plan.swarmId
    })).rejects.toMatchObject({ code });
  });

  it("rejects a child LoopRecord whose exact launch lineage does not match completion evidence", async () => {
    const fixture = await createEvidenceFixture();
    const loopPath = join(fixture.rootDir, "child-a", "loop-record.json");
    const loop = JSON.parse(await readFile(loopPath, "utf8")) as LoopRecord;
    loop.receiptScope!.swarmChild!.attemptId = "attempt-other";
    await writeFile(loopPath, `${JSON.stringify(loop, null, 2)}\n`, "utf8");
    const ledgerEntries = (await readFile(join(fixture.rootDir, "child-a", "ledger.jsonl"), "utf8"))
      .trim().split(/\r?\n/u).map((line) => JSON.parse(line));
    await writeReceiptIntegrityMaterial({
      runId: "child-a",
      runsRoot: fixture.rootDir,
      loopRecord: loop,
      ledgerEntries,
      scope: loop.receiptScope,
      signedAt: "2026-10-03T12:00:32.000Z"
    });

    await expect(readAndSealSwarmEvidence({
      rootDir: fixture.rootDir,
      swarmId: fixture.plan.swarmId
    })).rejects.toMatchObject({ code: "CHILD_RECEIPT_LINK_MISMATCH" });
  });

  it("rejects artifact symlink aliases instead of recursively following them", async () => {
    const fixture = await createEvidenceFixture();
    await symlink(fixture.evidenceRoot, join(fixture.evidenceRoot, "alias"), "junction");

    await expect(readAndSealSwarmEvidence({
      rootDir: fixture.rootDir,
      swarmId: fixture.plan.swarmId
    })).rejects.toMatchObject({ code: "EVIDENCE_PATH_ALIAS" });
  });

  it("revalidates every source byte before publication and leaves no index after mutation", async () => {
    const fixture = await createEvidenceFixture();
    const source = fixture.store.paths().events;

    await expect(readAndSealSwarmEvidence({
      rootDir: fixture.rootDir,
      swarmId: fixture.plan.swarmId,
      beforePublish: async () => {
        await writeFile(source, Buffer.concat([await readFile(source), Buffer.from(" ")]));
      }
    })).rejects.toMatchObject({ code: "EVIDENCE_SOURCE_CHANGED" });
    await expect(stat(join(fixture.evidenceRoot, "evidence-index.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects child completion that omits required closure and cleanup state", async () => {
    const fixture = await createEvidenceFixture();
    const path = join(fixture.evidenceRoot, "child-completions", "child.json");
    const completion = JSON.parse(await readFile(path, "utf8"));
    delete completion.workspaceCleanupState;
    await writeFile(path, `${JSON.stringify(completion, null, 2)}\n`, "utf8");

    await expect(readAndSealSwarmEvidence({ rootDir: fixture.rootDir, swarmId: fixture.plan.swarmId }))
      .rejects.toMatchObject({ code: "INVALID_CHILD_COMPLETION_EVIDENCE" });
  });

  it("binds verifier evidence to the passed event verification ID and integrated tree", async () => {
    const fixture = await createEvidenceFixture();
    const path = join(fixture.evidenceRoot, "global-verification", "verifier.json");
    const verifier = JSON.parse(await readFile(path, "utf8"));
    verifier.integratedTreeHash = "d".repeat(64);
    await writeFile(path, `${JSON.stringify(verifier, null, 2)}\n`, "utf8");

    await expect(readAndSealSwarmEvidence({ rootDir: fixture.rootDir, swarmId: fixture.plan.swarmId }))
      .rejects.toMatchObject({ code: "INVALID_GLOBAL_VERIFICATION_EVIDENCE" });
  });
});

async function createEvidenceFixture(): Promise<{
  rootDir: string;
  swarmRoot: string;
  evidenceRoot: string;
  plan: SwarmLivePlan;
  store: Awaited<ReturnType<typeof createSwarmLiveStore>>;
}> {
  const rootDir = await mkdtemp(join(tmpdir(), "martin-swarm-evidence-"));
  scratch.push(rootDir);
  process.env.MARTIN_INTEGRITY_KEY_DIR = join(rootDir, "keys");
  const plan = createSwarmLivePlan({
    planId: "plan-evidence",
    swarmId: "swarm-evidence",
    workspaceId: "workspace-evidence",
    projectId: "project-evidence",
    baselineCommit: "a".repeat(40),
    parentContract: {
      policyVersion: "swarm-policy-v1",
      objective: "Seal canonical evidence",
      definitionOfDone: ["Evidence is complete"],
      budget: { maxUsd: 1, softLimitUsd: 1, maxIterations: 2, maxTokens: 100 },
      maxWallClockMs: 60_000,
      maxConcurrency: 1,
      scope: { allowedPaths: ["src/**"], deniedPaths: [".git/**"] },
      permissions: { networkDomains: [], commands: ["echo verify"] },
      integrationStrategy: "parent_fan_in",
      globalVerifierStack: [{ command: "echo verify", type: "custom" }],
      stopPolicy: { budgetExhausted: "stop", blockingFailure: "needs_review", verifierFailure: "stop" },
      recoveryPolicy: { maxReassignmentsPerTask: 0, dependencyWaiversAllowed: false },
      approvalPolicy: {},
      orchestrationStrategy: "hierarchical_dag"
    },
    tasks: [{
      taskId: "task-a", title: "Task A", objective: "Complete A", required: true,
      dependsOn: [], assignedAgentId: "agent-a", status: "queued",
      mutationMode: "read_only", writeScope: []
    }],
    agents: [{
      agentId: "agent-a", role: "worker", status: "queued",
      contract: {
        agentId: "agent-a", taskIds: ["task-a"],
        scope: { allowedPaths: ["src/**"], deniedPaths: [".git/**"] },
        budget: { maxUsd: 1, softLimitUsd: 1, maxIterations: 2, maxTokens: 100 },
        maxWallClockMs: 60_000,
        permissions: { networkDomains: [], commands: ["echo verify"] },
        approvalPolicy: {}, verifierAuthority: "child_only"
      }
    }],
    engine: { engine: "codex", model: "gpt-test" },
    childMaxIterations: 1,
    createdAt: "2026-10-03T12:00:00.000Z"
  });
  const store = await createSwarmLiveStore({ rootDir, plan });
  await store.claimStart();
  await store.append({
    idempotencyKey: "child-a:started",
    type: "CHILD_STARTED",
    timestamp: "2026-10-03T12:00:20.000Z",
    taskId: "task-a",
    agentId: "agent-a",
    childRunId: "child-a",
    payload: { attemptId: "attempt-a" }
  }, { expectedRevision: 0 });
  await store.append({
    idempotencyKey: "child-a:verified",
    type: "CHILD_VERIFIED",
    timestamp: "2026-10-03T12:01:00.000Z",
    taskId: "task-a",
    agentId: "agent-a",
    childRunId: "child-a",
    payload: { cleanupId: "cleanup-a" }
  }, { expectedRevision: 1 });
  await store.append({
    idempotencyKey: "verifier:passed",
    type: "GLOBAL_VERIFIER_PASSED",
    timestamp: "2026-10-03T12:01:30.000Z",
    payload: { verificationId: "verify-a", integratedTreeHash: "b".repeat(64) }
  }, { expectedRevision: 2 });
  await store.append({
    idempotencyKey: "parent:stopped",
    type: "SWARM_STOPPED",
    timestamp: "2026-10-03T12:02:00.000Z",
    payload: { reason: "bounded_stop" }
  }, { expectedRevision: 3 });
  const swarmRoot = store.paths().directory;
  const evidenceRoot = join(swarmRoot, "evidence");
  const childLink = {
    parentSwarmId: plan.swarmId,
    agentId: "agent-a",
    attemptId: "attempt-a",
    taskIds: ["task-a"]
  };
  const loopRecord = {
    loopId: "child-a",
    receiptScope: { runId: "child-a", swarmChild: childLink },
    metadata: { "swarm.attemptId": "attempt-a" }
  } as unknown as LoopRecord;
  const ledgerEntries = [{ eventId: "event-child-a", type: "VERIFIED", timestamp: "2026-10-03T12:00:30.000Z" }];
  const childRoot = join(rootDir, "child-a");
  await mkdir(childRoot, { recursive: true });
  await writeFile(join(childRoot, "loop-record.json"), `${JSON.stringify(loopRecord, null, 2)}\n`, "utf8");
  await writeFile(join(childRoot, "ledger.jsonl"), `${ledgerEntries.map((entry) => JSON.stringify(entry)).join("\n")}\n`, "utf8");
  const integrity = await writeReceiptIntegrityMaterial({
    runId: "child-a",
    runsRoot: rootDir,
    loopRecord,
    ledgerEntries,
    scope: loopRecord.receiptScope,
    signedAt: "2026-10-03T12:00:31.000Z"
  });
  if (!integrity) throw new Error("fixture integrity material was not created");
  const receipt = {
    receiptId: "receipt-a",
    swarmId: plan.swarmId,
    childRunId: "child-a",
    agentId: "agent-a",
    attemptId: "attempt-a",
    taskIds: ["task-a"],
    integrity: {
      state: "verified" as const,
      keyId: integrity.keyId,
      loopRecordSha256: integrity.loopRecordSha256,
      ledgerSha256: integrity.ledgerSha256,
      ledgerHeadHash: integrity.ledgerHeadHash
    }
  };
  const artifacts = {
    "child-completions/child.json": {
      swarmId: plan.swarmId, childRunId: "child-a", agentId: "agent-a",
      attemptId: "attempt-a", taskIds: ["task-a"],
      receipt: { ...receipt, bindingSha256: receiptBindingSha256(receipt) },
      workspaceId: "workspace-child-a", processCloseState: "closed", leaseState: "settled",
      evidencePersisted: true, workspaceCleanupState: "completed",
      cleanup: {
        schemaVersion: "martin.swarm.v1", swarmId: plan.swarmId, cleanupId: "cleanup-a",
        workspaceId: "workspace-child-a", workspaceKind: "child", evidencePersisted: true,
        processCloseState: "closed", removalState: "removed", state: "completed",
        attemptedAt: "2026-10-03T12:00:40.000Z", completedAt: "2026-10-03T12:00:41.000Z"
      }
    },
    "cleanup/cleanup.json": {
      schemaVersion: "martin.swarm.v1", swarmId: plan.swarmId, cleanupId: "cleanup-a",
      workspaceId: "workspace-child-a", workspaceKind: "child", evidencePersisted: true,
      processCloseState: "closed", removalState: "removed", state: "completed",
      attemptedAt: "2026-10-03T12:00:40.000Z", completedAt: "2026-10-03T12:00:41.000Z"
    },
    "integration-reconstructions/integration.json": {
      swarmId: plan.swarmId, reconstructionId: "integration-a", failedCandidateId: "candidate-a",
      previousWorkspaceId: "workspace-old", replacementWorkspaceId: "workspace-new",
      baselineCommit: plan.baselineCommit, replayedCandidateIds: [], expectedTreeHash: "b".repeat(64),
      actualTreeHash: "b".repeat(64), state: "completed", recordedAt: "2026-10-03T12:00:50.000Z"
    },
    "integration-outcomes/outcome.json": {
      decision: {
        schemaVersion: "martin.swarm.v1", admissionId: "admission-a", candidateId: "candidate-a",
        swarmId: plan.swarmId, workspaceId: "workspace-child-a", childRunId: "child-a",
        agentId: "agent-a", taskIds: ["task-a"], baselineCommit: plan.baselineCommit,
        changedPaths: ["src/a.ts"], state: "admitted", reasonCode: "admitted",
        receiptIntegrity: "verified", decidedAt: "2026-10-03T12:00:45.000Z"
      },
      event: {
        type: "CHILD_PATCH_ADMITTED", swarmId: plan.swarmId,
        timestamp: "2026-10-03T12:00:45.000Z",
        parentPolicyVersion: plan.parentContract.policyVersion,
        taskId: "task-a", agentId: "agent-a", childRunId: "child-a",
        payload: { candidateId: "candidate-a", patchSha256: "c".repeat(64) }
      }
    },
    "global-verification/verifier.json": {
      schemaVersion: "martin.swarm.v1", swarmId: plan.swarmId, verificationId: "verify-a",
      workspaceId: "workspace-verifier", parentPolicyVersion: plan.parentContract.policyVersion,
      baselineCommit: plan.baselineCommit, integratedTreeHash: "b".repeat(64), commands: ["echo verify"],
      commandState: "passed", mutationState: "clean", startedAt: "2026-10-03T12:01:10.000Z",
      completedAt: "2026-10-03T12:01:11.000Z", subprocessResults: []
    },
    "process-closures/closure.json": {
      swarmId: plan.swarmId, workspaceId: "workspace-child-a", childRunId: "child-a",
      agentId: "agent-a", state: "closed", completedAt: "2026-10-03T12:00:35.000Z"
    }
  } as const;
  for (const [relativePath, value] of Object.entries(artifacts)) {
    const path = join(evidenceRoot, relativePath);
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  }
  return { rootDir, swarmRoot, evidenceRoot, plan, store };
}

async function captureOperationalFiles(fixture: Awaited<ReturnType<typeof createEvidenceFixture>>) {
  const paths = fixture.store.paths();
  const claimFiles = (await readdir(paths.eventClaims)).sort().map((name) => join(paths.eventClaims, name));
  return Promise.all([paths.plan, paths.startClaim, ...claimFiles, paths.events, paths.snapshot].map(async (path) => ({
    path,
    bytes: await readFile(path),
    mtimeMs: (await stat(path)).mtimeMs
  })));
}

async function assertOperationalFilesUnchanged(before: Awaited<ReturnType<typeof captureOperationalFiles>>) {
  for (const entry of before) {
    expect(await readFile(entry.path)).toEqual(entry.bytes);
    expect((await stat(entry.path)).mtimeMs).toBe(entry.mtimeMs);
  }
}

async function recursiveEntries(root: string, prefix = ""): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const result: string[] = [];
  for (const entry of entries) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    result.push(relative);
    if (entry.isDirectory()) result.push(...await recursiveEntries(join(root, entry.name), relative));
  }
  return result.sort();
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function receiptBindingSha256(receipt: {
  receiptId: string;
  swarmId: string;
  childRunId: string;
  agentId: string;
  attemptId: string;
  taskIds: string[];
  integrity: Record<string, unknown>;
}): string {
  return createHash("sha256").update(JSON.stringify({
    ...receipt,
    taskIds: [...receipt.taskIds].sort()
  }), "utf8").digest("hex");
}
