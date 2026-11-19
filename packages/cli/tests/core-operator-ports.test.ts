import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

import {
  createCheckpointStore,
  MemoryStoreV2,
  writeMissionRuntimeControlIntent,
  type MissionRuntimeState,
} from "@martin/core";
import { afterEach, describe, expect, it } from "vitest";

import { createCoreOperatorPorts } from "../src/core-operator-ports.js";
import { executeCli } from "../src/index.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixtureRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "martin-operator-"));
  roots.push(root);
  return root;
}

function runtimeState(missionId: string): MissionRuntimeState {
  const now = "2026-11-03T12:00:00.000Z";
  return {
    schemaVersion: "martin.mission-runtime.v1",
    missionId,
    objective: "prove the operator boundary",
    createdAt: now,
    updatedAt: now,
    sequence: 4,
    bindings: {
      sourceSha: "a".repeat(40), workspaceId: "workspace-1", workspaceIdentityHash: "b".repeat(64),
      missionLedgerHeadHash: "c".repeat(64), workQueueHash: "d".repeat(64),
      contextManifestHash: "e".repeat(64), memoryLedgerHeadHash: null, memorySnapshotHash: null,
    },
    context: { manifestHash: "e".repeat(64), tokenCount: 40, compactAtTokens: 1_000 },
    providerPolicy: { primary: "codex", allowFallback: false },
    queue: [
      { workItemId: "done", phase: "integrated" },
      { workItemId: "active", phase: "verifying", candidateHash: "f".repeat(64) },
      { workItemId: "blocked", phase: "blocked" },
    ],
    candidates: { active: { kind: "candidate", runId: "run-1", receiptHash: "1".repeat(64), candidateHash: "f".repeat(64), actualUsd: 1, tokens: 20, handoff: {
      manifestHash: "2".repeat(64), summary: "candidate", tokenCount: 20,
      receipt: {
        schemaVersion: "martin.handoff.v1", handoffId: "handoff:run-1", chainId: `chain:${missionId}`,
        missionId, producerRunId: "run-1", producerReceiptHash: "1".repeat(64), claims: [],
        artifacts: [{ sha256: "2".repeat(64), required: true }], unresolvedAssumptions: [],
        upstreamIntegrity: "verified", createdAt: now,
      },
      producerReceiptVerified: true,
      availableArtifactHashes: ["2".repeat(64)],
    } } },
    verifications: {}, failedCandidates: [], blockers: [],
    settlement: { budget: { maxUsd: 10, spentUsd: 1, startedAt: now, wallClockDeadline: "2099-11-04T12:00:00.000Z", maxRuns: 10, runsUsed: 1, maxTokens: 10_000, tokensUsed: 20, maxConcurrency: 2, activeConcurrency: 1, maxNoProgressIntervals: 3, noProgressIntervals: 0 }, settlementIds: ["settlement-1"] },
  };
}

describe("core operator ports", () => {
  it("reads the latest persisted mission without caller-supplied authority", async () => {
    const root = await fixtureRoot();
    const missionId = "mission-operator";
    const store = createCheckpointStore<MissionRuntimeState>({ root: join(root, "missions", missionId, "runtime") });
    await store.append(runtimeState(missionId), { checkpointId: "checkpoint-1", writerId: "test", expectedHeadHash: null, now: "2026-11-03T12:00:00.000Z" });

    const ports = createCoreOperatorPorts({ defaultRunsRoot: root, env: {} });
    const view = await ports.mission.status({ selector: { latest: true } });

    expect(view).toMatchObject({
      missionId,
      authority: { kind: "persisted", revision: 4 },
      lifecycle: "interrupted",
      completed: { count: 1, taskIds: ["done"] },
      active: { count: 1, taskIds: ["active"] },
      interrupted: { count: 1, taskIds: ["blocked"] },
      candidates: { count: 1, candidateIds: ["active"] },
      budget: { status: "within_limit", spentUsd: 1, maxUsd: 10 },
      verification: { status: "pending" },
    });

    const direct = await executeCli(["mission", "status", "--latest", "--runs-dir", root, "--json"]);
    expect(direct.exitCode).toBe(0);
    expect(JSON.parse(direct.stdout)).toMatchObject({ missionId, authority: { kind: "persisted", revision: 4 } });
  });

  it("reads and verifies memory while mutation fails closed without host authority", async () => {
    const root = await fixtureRoot();
    const store = new MemoryStoreV2(root);
    await store.append({
      id: "memory-candidate", kind: "pattern", scope: { workspaceId: "workspace-1", subject: "operator" },
      content: { summary: "candidate" }, provenance: { source: "inferred", actorId: "agent:test", observedAt: "2026-11-03T12:00:00.000Z", sourceRefs: ["run-1"] },
      trust: { level: "untrusted", confidence: 0.5 }, sensitivity: "internal",
    });

    const ports = createCoreOperatorPorts({ defaultRunsRoot: root, env: {} });
    await expect(ports.memory.inspect({ selector: { latest: true } })).resolves.toMatchObject({ memory: { memoryId: "memory-candidate", state: "candidate" } });
    await expect(ports.memory.verify({ selector: { memoryId: "memory-candidate" } })).resolves.toMatchObject({ verification: { status: "valid" } });
    await expect(ports.memory.revoke({ selector: { memoryId: "memory-candidate" }, reason: "superseded", hostApprovalPath: join(root, "missing.json") })).rejects.toThrow(/approval authority/iu);
  });

  it("rejects mission selectors that could escape the persisted mission root", async () => {
    const root = await fixtureRoot();
    const ports = createCoreOperatorPorts({ defaultRunsRoot: root, env: {} });
    await expect(ports.mission.status({ selector: { missionId: "../outside" } })).rejects.toThrow(/safe path component/iu);
  });

  it("reports resume posture read-only in the standalone CLI", async () => {
    const root = await fixtureRoot();
    const missionId = "mission-resume";
    const store = createCheckpointStore<MissionRuntimeState>({ root: join(root, "missions", missionId, "runtime") });
    await store.append(runtimeState(missionId), { checkpointId: "checkpoint-1", writerId: "test", expectedHeadHash: null, now: "2026-11-03T12:00:00.000Z" });

    const result = await executeCli(["mission", "resume", "--mission-id", missionId, "--runs-dir", root, "--json"]);
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      command: "mission resume",
      missionId,
      lifecycle: "interrupted",
      rollback: { status: "unavailable", reason: "not_persisted" },
    });
  });

  it("does not treat an unconsumed control intent as an applied lifecycle", async () => {
    const root = await fixtureRoot();
    const missionId = "mission-control-pending";
    const state = runtimeState(missionId);
    state.queue = [{ workItemId: "active", phase: "verifying", candidateHash: "f".repeat(64) }];
    const store = createCheckpointStore<MissionRuntimeState>({ root: join(root, "missions", missionId, "runtime") });
    await store.append(state, { checkpointId: "checkpoint-1", writerId: "test", expectedHeadHash: null, now: "2026-11-03T12:00:00.000Z" });
    await writeMissionRuntimeControlIntent(root, missionId, {
      intentId: "intent-1",
      action: "pause",
      reason: "operator maintenance",
      requestedAt: "2026-11-03T12:01:00.000Z",
      approval: {
        schemaVersion: "martin.host-approval.v1",
        approvalId: "approval-1",
        missionId,
        action: "pause",
        actorId: "human:operator",
        issuedAt: "2026-11-03T12:00:00.000Z",
        expiresAt: "2026-11-03T12:05:00.000Z",
        signature: "signed",
      },
    }, { authorityId: "test-authority", verify: () => true });

    const view = await createCoreOperatorPorts({ defaultRunsRoot: root, env: {} }).mission.status({ selector: { missionId } });
    expect(view).toMatchObject({
      lifecycle: "active",
      controlIntent: { action: "pause", status: "requested", approvalId: "approval-1" },
      rollback: { status: "unavailable", reason: "not_persisted" },
    });
  });

  it("preserves missing memory as not_found instead of unreadable", async () => {
    const root = await fixtureRoot();
    const result = await executeCli(["memory", "verify", "--memory-id", "missing", "--runs-dir", root, "--json"]);
    expect(result.exitCode).toBe(5);
    expect(JSON.parse(result.stdout)).toMatchObject({ ok: false, category: "not_found" });
  });

  it("reports the ledger revision and head rather than the filtered candidate count", async () => {
    const root = await fixtureRoot();
    const store = new MemoryStoreV2(root);
    const first = await store.append({
      id: "memory-a", kind: "pattern", scope: { workspaceId: "workspace-1", subject: "operator" },
      content: { summary: "a" }, provenance: { source: "inferred", actorId: "agent:test", observedAt: "2026-11-03T12:00:00.000Z", sourceRefs: ["run-1"] },
      trust: { level: "untrusted", confidence: 0.5 }, sensitivity: "internal",
    });
    await store.compact("2026-11-03T12:01:00.000Z");

    const view = await createCoreOperatorPorts({ defaultRunsRoot: root, env: {} }).memory.candidates({});
    expect(view.candidates).toHaveLength(1);
    expect(view.authority).toMatchObject({ kind: "persisted", revision: 2 });
    expect(view.authority.headHash).not.toBe(first.entryHash);
  });

  it("reports wall-clock budget exhaustion from persisted limits", async () => {
    const root = await fixtureRoot();
    const missionId = "mission-expired-budget";
    const state = runtimeState(missionId);
    state.settlement.budget.wallClockDeadline = "2026-11-03T12:00:01.000Z";
    const store = createCheckpointStore<MissionRuntimeState>({ root: join(root, "missions", missionId, "runtime") });
    await store.append(state, { checkpointId: "checkpoint-1", writerId: "test", expectedHeadHash: null, now: "2026-11-03T12:00:00.000Z" });

    const view = await createCoreOperatorPorts({
      defaultRunsRoot: root,
      env: {},
      now: () => "2026-11-03T12:00:02.000Z",
    }).mission.status({ selector: { missionId } });
    expect(view.budget).toMatchObject({ status: "limit_reached", reasons: ["wall_clock_limit"] });
  });

  it("returns already_revoked without appending on a same-receipt retry", async () => {
    const root = await fixtureRoot();
    const store = new MemoryStoreV2(root);
    const target = await store.append({
      id: "memory-revoke", kind: "pattern", scope: { workspaceId: "workspace-1", subject: "operator" },
      content: { summary: "candidate" }, provenance: { source: "inferred", actorId: "agent:test", observedAt: "2026-11-04T02:00:00.000Z", sourceRefs: ["run-1"] },
      trust: { level: "untrusted", confidence: 0.5 }, sensitivity: "internal",
    });
    const sourceRef = "operator-request-1";
    const sourceHash = createHash("sha256").update(JSON.stringify({ sourceRef, targetEntryHash: target.entryHash })).digest("hex");
    const approvalPath = join(root, "approval.json");
    await writeFile(approvalPath, JSON.stringify({
      sourceRef,
      receipt: {
        schemaVersion: "memory-approval/1",
        receiptId: "receipt-revoke-1",
        contextId: "test-context",
        action: "revocation",
        actorId: "human:operator",
        workspaceId: "workspace-1",
        subject: "operator",
        targetId: target.id,
        sourceHash,
        issuedAt: "2026-11-04T02:00:00.000Z",
        expiresAt: "2026-11-04T02:05:00.000Z",
        signature: "test-signature",
      },
    }), "utf8");
    const ports = createCoreOperatorPorts({
      defaultRunsRoot: root,
      env: {},
      now: () => "2026-11-04T02:01:00.000Z",
      memoryApprovalAuthority: { verifierId: "test-authority", verify: () => true },
    });
    const request = {
      selector: { memoryId: target.id } as const,
      reason: "superseded",
      hostApprovalPath: approvalPath,
    };

    await expect(ports.memory.revoke(request)).resolves.toMatchObject({ outcome: "revoked" });
    const countAfterFirst = (await store.readAll()).length;
    await expect(ports.memory.revoke(request)).resolves.toMatchObject({ outcome: "already_revoked" });
    expect((await store.readAll()).length).toBe(countAfterFirst);
  });
});
