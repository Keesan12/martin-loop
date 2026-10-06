import { spawn } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  createSwarmLivePlan,
  createSwarmRunRecord
} from "@martin/contracts";
import type {
  SwarmLivePlan,
  SwarmLivePlanDraft,
  SwarmParentContract
} from "@martin/contracts";
import { describe, expect, it, vi } from "vitest";

import {
  SwarmLiveStoreError,
  createSwarmLiveStore,
  isExactPersistedParentResultEvent,
  openSwarmLiveStore,
  readCanonicalSwarmLiveEvidenceBundle
} from "../src/swarm/live-store.js";
import { runParentSwarmPipeline } from "../src/swarm/index.js";

const parentContract: SwarmParentContract = {
  policyVersion: "swarm-policy/live-v1",
  objective: "Complete one governed live swarm.",
  definitionOfDone: ["Required work accepted", "Parent verifier passes"],
  budget: { maxUsd: 10, softLimitUsd: 8, maxIterations: 12, maxTokens: 100_000 },
  maxWallClockMs: 900_000,
  maxConcurrency: 2,
  scope: { allowedPaths: ["packages/**"], deniedPaths: ["**/.env"] },
  permissions: { networkDomains: [], commands: ["pnpm test"] },
  integrationStrategy: "parent_fan_in",
  globalVerifierStack: [{ command: "pnpm test", type: "test_full" }],
  stopPolicy: {
    budgetExhausted: "stop",
    blockingFailure: "needs_review",
    verifierFailure: "stop"
  },
  recoveryPolicy: { maxReassignmentsPerTask: 1, dependencyWaiversAllowed: false },
  approvalPolicy: {
    dependencyAdds: false,
    migrations: false,
    configChanges: false,
    externalWrites: false
  },
  orchestrationStrategy: "parallel_dag"
};

function planDraft(swarmId = "swarm-live-store-001"): SwarmLivePlanDraft {
  return {
    planId: `plan-${swarmId}`,
    swarmId,
    workspaceId: "workspace-live-store",
    projectId: "project-live-store",
    baselineCommit: "0123456789abcdef0123456789abcdef01234567",
    parentContract,
    tasks: [{
      taskId: "task-1",
      title: "Implement",
      objective: "Produce one bounded candidate.",
      required: true,
      dependsOn: [],
      assignedAgentId: "agent-1",
      status: "queued",
      mutationMode: "write",
      writeScope: ["packages/core/**"]
    }],
    agents: [{
      agentId: "agent-1",
      role: "Implementer",
      status: "queued",
      childRunId: "loop-child-1",
      contract: {
        agentId: "agent-1",
        taskIds: ["task-1"],
        scope: { allowedPaths: ["packages/core/**"], deniedPaths: ["**/.env"] },
        budget: { maxUsd: 2, softLimitUsd: 1, maxIterations: 3, maxTokens: 10_000 },
        maxWallClockMs: 120_000,
        permissions: { networkDomains: [], commands: ["pnpm test"] },
        approvalPolicy: {
          dependencyAdds: false,
          migrations: false,
          configChanges: false,
          externalWrites: false
        },
        verifierAuthority: "child_only"
      }
    }],
    engine: { engine: "codex", model: "gpt-5-codex" },
    childMaxIterations: 3,
    createdAt: "2026-10-03T12:00:00.000Z"
  };
}

async function fixture(): Promise<{ rootDir: string; plan: SwarmLivePlan }> {
  return {
    rootDir: await mkdtemp(join(tmpdir(), "martin-swarm-live-store-")),
    plan: createSwarmLivePlan(planDraft())
  };
}

describe("swarm live operational store", () => {
  it("publishes one immutable plan under concurrent store creation", async () => {
    const { rootDir, plan } = await fixture();

    const stores = await Promise.all(
      Array.from({ length: 8 }, () => createSwarmLiveStore({ rootDir, plan }))
    );

    expect(stores).toHaveLength(8);
    await expect(readFile(stores[0]!.paths().plan, "utf8"))
      .resolves.toBe(`${JSON.stringify(plan, null, 2)}\n`);

    const claims = await Promise.allSettled(stores.map((store) => store.claimStart()));
    expect(claims.filter((claim) => claim.status === "fulfilled")).toHaveLength(1);
    expect(claims.filter((claim) => claim.status === "rejected")).toHaveLength(7);
    for (const claim of claims.filter((entry): entry is PromiseRejectedResult => entry.status === "rejected")) {
      expect(claim.reason).toMatchObject({ code: "LIVE_SWARM_ALREADY_STARTED" });
    }
  });

  it("binds a crash prefix to the exact authorized parent result hash", () => {
    const input = {
      idempotencyKey: `parent-integration:${"a".repeat(64)}:000000`,
      type: "CHILD_PATCH_ADMITTED" as const,
      timestamp: "2026-10-03T12:01:00.000Z",
      taskId: "task-1",
      agentId: "agent-1",
      childRunId: "loop-child-1",
      payload: { candidateId: "candidate-1" }
    };
    const persisted = {
      ...input,
      schemaVersion: "martin.swarm.v1" as const,
      sequence: 2,
      swarmId: "swarm-live-store-001",
      parentPolicyVersion: parentContract.policyVersion,
      planHash: "c".repeat(64)
    };

    expect(isExactPersistedParentResultEvent(persisted, input)).toBe(true);
    expect(isExactPersistedParentResultEvent(persisted, {
      ...input,
      idempotencyKey: `parent-integration:${"b".repeat(64)}:000000`
    })).toBe(false);
  });

  it("reads a terminal canonical evidence bundle without rewriting operational truth", async () => {
    const { rootDir, plan } = await fixture();
    const store = await createSwarmLiveStore({ rootDir, plan });
    await store.claimStart();
    await store.append({
      idempotencyKey: "parent:stopped",
      type: "SWARM_STOPPED",
      timestamp: "2026-10-03T12:01:00.000Z",
      payload: { reason: "bounded_stop" }
    }, { expectedRevision: 0 });
    const paths = store.paths();
    const claimPath = join(paths.eventClaims, "000000000001.json");
    const observed = [paths.plan, paths.startClaim, claimPath, paths.events, paths.snapshot];
    const before = await Promise.all(observed.map(async (path) => ({
      path,
      bytes: await readFile(path),
      mtimeMs: (await stat(path)).mtimeMs
    })));

    const bundle = await readCanonicalSwarmLiveEvidenceBundle({
      directory: paths.directory,
      swarmId: plan.swarmId
    });

    expect(bundle.snapshot.outcome).toMatchObject({ state: "stopped", reason: "bounded_stop" });
    expect(bundle.events).toHaveLength(1);
    expect(bundle.files.map((file) => file.kind)).toEqual([
      "plan", "start_claim", "event_claim", "events", "snapshot"
    ]);
    for (const entry of before) {
      expect(await readFile(entry.path)).toEqual(entry.bytes);
      expect((await stat(entry.path)).mtimeMs).toBe(entry.mtimeMs);
    }
  });

  it.each([
    ["events", "EVENT_JOURNAL_MISMATCH"],
    ["snapshot", "SNAPSHOT_MISMATCH"]
  ] as const)("rejects stale %s bytes without healing them", async (target, code) => {
    const { rootDir, plan } = await fixture();
    const store = await createSwarmLiveStore({ rootDir, plan });
    await store.claimStart();
    await store.append({
      idempotencyKey: "parent:stopped",
      type: "SWARM_STOPPED",
      timestamp: "2026-10-03T12:01:00.000Z",
      payload: { reason: "bounded_stop" }
    }, { expectedRevision: 0 });
    const path = store.paths()[target];
    const tampered = Buffer.concat([await readFile(path), Buffer.from(" ")]);
    await writeFile(path, tampered);

    await expect(readCanonicalSwarmLiveEvidenceBundle({
      directory: store.paths().directory,
      swarmId: plan.swarmId
    })).rejects.toMatchObject({ code });
    expect(await readFile(path)).toEqual(tampered);
  });

  it("requires the immutable start claim and never creates it during evidence reads", async () => {
    const { rootDir, plan } = await fixture();
    const store = await createSwarmLiveStore({ rootDir, plan });
    await store.claimStart();
    await store.append({
      idempotencyKey: "parent:stopped",
      type: "SWARM_STOPPED",
      timestamp: "2026-10-03T12:01:00.000Z",
      payload: { reason: "bounded_stop" }
    }, { expectedRevision: 0 });
    await rm(store.paths().startClaim);

    await expect(readCanonicalSwarmLiveEvidenceBundle({
      directory: store.paths().directory,
      swarmId: plan.swarmId
    })).rejects.toMatchObject({ code: "MISSING_START_CLAIM" });
    await expect(stat(store.paths().startClaim)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects a second or post-terminal immutable event claim", async () => {
    const { rootDir, plan } = await fixture();
    const store = await createSwarmLiveStore({ rootDir, plan });
    await store.claimStart();
    await store.append({
      idempotencyKey: "parent:stopped",
      type: "SWARM_STOPPED",
      timestamp: "2026-10-03T12:01:00.000Z",
      payload: { reason: "bounded_stop" }
    }, { expectedRevision: 0 });
    const first = JSON.parse(await readFile(join(store.paths().eventClaims, "000000000001.json"), "utf8"));
    const second = {
      ...first,
      sequence: 2,
      idempotencyKey: "parent:stopped:again",
      timestamp: "2026-10-03T12:02:00.000Z"
    };
    await writeFile(
      join(store.paths().eventClaims, "000000000002.json"),
      `${JSON.stringify(second)}\n`,
      "utf8"
    );

    await expect(readCanonicalSwarmLiveEvidenceBundle({
      directory: store.paths().directory,
      swarmId: plan.swarmId
    })).rejects.toMatchObject({ code: "INVALID_TERMINAL_EVENT_CHAIN" });
  });

  it("appends sequenced events and reconstructs identical state after restart", async () => {
    const { rootDir, plan } = await fixture();
    const store = await createSwarmLiveStore({ rootDir, plan });
    await store.append({
      idempotencyKey: "task-1:ready",
      type: "TASK_READY",
      timestamp: "2026-10-03T12:01:00.000Z",
      taskId: "task-1",
      payload: {}
    }, { expectedRevision: 0 });
    const before = await store.readSnapshot();

    const reopened = await openSwarmLiveStore({ rootDir, swarmId: plan.swarmId });

    expect(await reopened.readSnapshot()).toEqual(before);
    expect(await reopened.readEvents()).toHaveLength(1);
    expect((await reopened.readEvents())[0]).toMatchObject({ sequence: 1, planHash: plan.planHash });
  });

  it("returns the original event for an idempotent duplicate without advancing revision", async () => {
    const { rootDir, plan } = await fixture();
    const store = await createSwarmLiveStore({ rootDir, plan });
    const input = {
      idempotencyKey: "task-1:assigned",
      type: "TASK_ASSIGNED" as const,
      timestamp: "2026-10-03T12:01:00.000Z",
      taskId: "task-1",
      agentId: "agent-1",
      payload: {}
    };
    const first = await store.append(input, { expectedRevision: 0 });
    const duplicate = await store.append(input, { expectedRevision: 0 });

    expect(first.duplicate).toBe(false);
    expect(duplicate.duplicate).toBe(true);
    expect(duplicate.event).toEqual(first.event);
    expect(duplicate.snapshot.revision).toBe(1);
    expect(await store.readEvents()).toHaveLength(1);
  });

  it("rejects stale revisions and conflicting reuse of an idempotency key", async () => {
    const { rootDir, plan } = await fixture();
    const store = await createSwarmLiveStore({ rootDir, plan });
    await store.append({
      idempotencyKey: "task-1:ready",
      type: "TASK_READY",
      timestamp: "2026-10-03T12:01:00.000Z",
      taskId: "task-1",
      payload: {}
    }, { expectedRevision: 0 });

    await expect(store.append({
      idempotencyKey: "task-1:started",
      type: "CHILD_STARTED",
      timestamp: "2026-10-03T12:02:00.000Z",
      taskId: "task-1",
      agentId: "agent-1",
      childRunId: "loop-child-1",
      payload: {}
    }, { expectedRevision: 0 })).rejects.toMatchObject({ code: "STALE_REVISION" });
    await expect(store.append({
      idempotencyKey: "task-1:ready",
      type: "TASK_ASSIGNED",
      timestamp: "2026-10-03T12:01:00.000Z",
      taskId: "task-1",
      agentId: "agent-1",
      payload: {}
    }, { expectedRevision: 1 })).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
  });

  it("serializes concurrent writers so exactly one compare-and-swap succeeds", async () => {
    const { rootDir, plan } = await fixture();
    const first = await createSwarmLiveStore({ rootDir, plan });
    const second = await openSwarmLiveStore({ rootDir, swarmId: plan.swarmId });

    const results = await Promise.allSettled([
      first.append({
        idempotencyKey: "writer:first",
        type: "TASK_READY",
        timestamp: "2026-10-03T12:01:00.000Z",
        taskId: "task-1",
        payload: {}
      }, { expectedRevision: 0 }),
      second.append({
        idempotencyKey: "writer:second",
        type: "TASK_ASSIGNED",
        timestamp: "2026-10-03T12:01:00.000Z",
        taskId: "task-1",
        agentId: "agent-1",
        payload: {}
      }, { expectedRevision: 0 })
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(await first.readEvents()).toHaveLength(1);
  });

  it("rebuilds malformed derived snapshot and journal views from immutable claims", async () => {
    const { rootDir, plan } = await fixture();
    const store = await createSwarmLiveStore({ rootDir, plan });
    await store.append({
      idempotencyKey: "task-1:ready",
      type: "TASK_READY",
      timestamp: "2026-10-03T12:01:00.000Z",
      taskId: "task-1",
      payload: {}
    }, { expectedRevision: 0 });
    const paths = store.paths();
    await writeFile(paths.snapshot, "{torn", "utf8");

    const recovered = await openSwarmLiveStore({ rootDir, swarmId: plan.swarmId });
    expect((await recovered.readSnapshot()).revision).toBe(1);

    await writeFile(paths.events, '{"sequence":2,"type":"invented"}\n', { encoding: "utf8", flag: "a" });
    const healed = await openSwarmLiveStore({ rootDir, swarmId: plan.swarmId });
    expect(await healed.readEvents()).toHaveLength(1);
    expect((await healed.readSnapshot()).revision).toBe(1);
    expect(await readFile(paths.events, "utf8")).not.toContain("invented");
  });

  it("recovers the last complete durable event when the final journal record is truncated", async () => {
    const { rootDir, plan } = await fixture();
    const store = await createSwarmLiveStore({ rootDir, plan });
    await store.append({
      idempotencyKey: "task-1:ready",
      type: "TASK_READY",
      timestamp: "2026-10-03T12:01:00.000Z",
      taskId: "task-1",
      payload: {}
    }, { expectedRevision: 0 });
    const paths = store.paths();
    await writeFile(paths.events, '{"schemaVersion":"martin.swarm.v1","sequence":2', {
      encoding: "utf8",
      flag: "a"
    });

    const recovered = await openSwarmLiveStore({ rootDir, swarmId: plan.swarmId });

    expect(await recovered.readEvents()).toHaveLength(1);
    expect((await recovered.readSnapshot()).revision).toBe(1);
    expect(await readFile(paths.events, "utf8")).toMatch(/\}\n$/u);
  });

  it("reclaims an orphaned writer lock whose recorded owner is no longer alive", async () => {
    const { rootDir, plan } = await fixture();
    const store = await createSwarmLiveStore({ rootDir, plan });
    await writeFile(store.paths().writerLock, JSON.stringify({
      pid: 2_147_483_647,
      createdAt: "2026-10-03T12:00:00.000Z",
      nonce: "orphaned-writer"
    }), "utf8");

    const result = await store.append({
      idempotencyKey: "task-1:ready-after-orphan",
      type: "TASK_READY",
      timestamp: "2026-10-03T12:01:00.000Z",
      taskId: "task-1",
      payload: {}
    }, { expectedRevision: 0 });

    expect(result.snapshot.revision).toBe(1);
    expect(await readFile(store.paths().writerLock, "utf8")).toContain("orphaned-writer");
  });

  it("admits exactly one independent writer despite orphaned lock and reclaim artifacts", async () => {
    const { rootDir, plan } = await fixture();
    const store = await createSwarmLiveStore({ rootDir, plan });
    const eventCount = 1;
    await store.append({
      idempotencyKey: "seed:1",
      type: "TASK_READY",
      timestamp: "2026-10-03T12:00:00.000Z",
      taskId: "task-1",
      payload: {}
    }, { expectedRevision: 0 });
    await writeFile(store.paths().writerLock, JSON.stringify({
      pid: 2_147_483_647,
      createdAt: "2026-10-03T12:00:00.000Z",
      nonce: "shared-stale-owner"
    }), "utf8");
    await writeFile(`${store.paths().writerLock}.reclaim`, JSON.stringify({
      pid: 2_147_483_647,
      createdAt: "2026-10-03T12:00:00.000Z",
      nonce: "shared-stale-reclaim-owner"
    }), "utf8");
    await writeFile(store.paths().events, '{"forged":"derived-journal"}\n', "utf8");
    await writeFile(store.paths().snapshot, '{"forged":"derived-snapshot"}\n', "utf8");
    const readyPath = join(rootDir, "reclaim-ready.txt");
    const goPath = join(rootDir, "reclaim-go.txt");

    const children = ["first", "second"].map((label) => runIndependentReclaimer({
      rootDir,
      swarmId: plan.swarmId,
      readyPath,
      goPath,
      label,
      expectedRevision: eventCount
    }));
    await waitForReadyChildren(readyPath, 2);
    await writeFile(goPath, "go", "utf8");
    const results = await Promise.all(children);

    expect(results.filter((result) => result.status === "success")).toHaveLength(1);
    expect(results.every((result) => result.opened)).toBe(true);
    expect(results.filter((result) => result.status === "error")).toEqual([
      expect.objectContaining({ code: "STALE_REVISION" })
    ]);
    expect(await store.readEvents()).toHaveLength(eventCount + 1);
    expect(await readdir(store.paths().eventClaims)).toEqual(["000000000001.json", "000000000002.json"]);
    expect(await readFile(store.paths().writerLock, "utf8")).toContain("shared-stale-owner");
    expect(await readFile(`${store.paths().writerLock}.reclaim`, "utf8")).toContain("shared-stale-reclaim-owner");
  }, 60_000);

  it("uses immutable per-revision event CAS instead of delete-based lock takeover", async () => {
    const source = await readFile(fileURLToPath(new URL("../src/swarm/live-store.ts", import.meta.url)), "utf8");

    expect(source).toContain('resolve(directory, "event-claims")');
    expect(source).toContain("await link(temporary, claimPath)");
    expect(source).not.toContain("removeOwnedLock");
    expect(source).not.toContain('`${path}.reclaim`');
  });

  it("recovers an orphaned exclusive reclamation claim by exact ownership", async () => {
    const { rootDir, plan } = await fixture();
    const store = await createSwarmLiveStore({ rootDir, plan });
    const staleOwner = {
      pid: 2_147_483_647,
      createdAt: "2026-10-03T12:00:00.000Z",
      nonce: "orphaned-reclaim-owner"
    };
    await writeFile(store.paths().writerLock, JSON.stringify({ ...staleOwner, nonce: "orphaned-writer-owner" }), "utf8");
    await writeFile(`${store.paths().writerLock}.reclaim`, JSON.stringify(staleOwner), "utf8");

    const result = await store.append({
      idempotencyKey: "task-1:after-orphaned-claim",
      type: "TASK_READY",
      timestamp: "2026-10-03T12:05:00.000Z",
      taskId: "task-1",
      payload: {}
    }, { expectedRevision: 0 });

    expect(result.snapshot.revision).toBe(1);
    expect(await readFile(`${store.paths().writerLock}.reclaim`, "utf8")).toContain("orphaned-reclaim-owner");
  });

  it.each(["SWARM_STOPPED", "SWARM_NEEDS_REVIEW"] as const)(
    "ignores a raw %s journal injection without a matching immutable claim",
    async (type) => {
      const { rootDir, plan } = await fixture();
      const store = await createSwarmLiveStore({ rootDir, plan });
      const forged = {
        schemaVersion: "martin.swarm.v1",
        sequence: 1,
        idempotencyKey: "forged-terminal-key",
        type,
        swarmId: plan.swarmId,
        timestamp: "2026-10-03T12:02:00.000Z",
        parentPolicyVersion: plan.parentContract.policyVersion,
        planHash: plan.planHash,
        payload: { reason: "raw-journal-write" }
      };
      await writeFile(store.paths().events, `${JSON.stringify(forged)}\n`, "utf8");

      const recovered = await openSwarmLiveStore({ rootDir, swarmId: plan.swarmId });
      expect(await recovered.readEvents()).toEqual([]);
      expect(await recovered.readSnapshot()).toMatchObject({ revision: 0, outcome: { state: "running" } });
      expect(await readFile(store.paths().events, "utf8")).toBe("");
      await expect(recovered.append({
        idempotencyKey: "forged-terminal-key",
        type: "TASK_READY",
        timestamp: "2026-10-03T12:03:00.000Z",
        taskId: "task-1",
        payload: {}
      }, { expectedRevision: 0 })).resolves.toMatchObject({ snapshot: { revision: 1 } });
    }
  );

  it("ignores a raw journal SWARM_VERIFIED injection instead of replaying it as authority", async () => {
    const { rootDir, plan } = await fixture();
    const store = await createSwarmLiveStore({ rootDir, plan });
    const forged = {
      schemaVersion: "martin.swarm.v1",
      sequence: 1,
      idempotencyKey: "forged-disk-verified",
      type: "SWARM_VERIFIED",
      swarmId: plan.swarmId,
      timestamp: "2026-10-03T12:02:00.000Z",
      parentPolicyVersion: plan.parentContract.policyVersion,
      planHash: plan.planHash,
      payload: { claimedBy: "raw-journal-write" }
    };
    await writeFile(store.paths().events, `${JSON.stringify(forged)}\n`, "utf8");

    const recovered = await openSwarmLiveStore({ rootDir, swarmId: plan.swarmId });
    expect(await recovered.readEvents()).toEqual([]);
    expect((await recovered.readSnapshot()).outcome.state).toBe("running");
    expect(await readFile(store.paths().events, "utf8")).toBe("");
  });

  it("persists cancellation idempotently without turning it into a terminal outcome", async () => {
    const { rootDir, plan } = await fixture();
    const store = await createSwarmLiveStore({ rootDir, plan });
    const request = {
      idempotencyKey: "cancel:operator-1",
      requestedAt: "2026-10-03T12:03:00.000Z",
      reason: "operator_requested",
      requestedBy: "operator-1"
    };
    const first = await store.requestCancellation(request, { expectedRevision: 0 });
    const duplicate = await store.requestCancellation(request, { expectedRevision: 0 });

    expect(first.duplicate).toBe(false);
    expect(duplicate.duplicate).toBe(true);
    expect(duplicate.snapshot.cancellation).toEqual({
      requestedAt: request.requestedAt,
      reason: request.reason,
      requestedBy: request.requestedBy
    });
    expect(duplicate.snapshot.outcome.state).toBe("running");
    expect((await store.readEvents())[0]?.type).toBe("SWARM_CANCEL_REQUESTED");
  });

  it("wakes local subscribers on append and rejects an aborted wait without polling", async () => {
    const { rootDir, plan } = await fixture();
    const store = await createSwarmLiveStore({ rootDir, plan });
    const waiting = store.waitForRevision(0);
    await store.append({
      idempotencyKey: "task-1:ready",
      type: "TASK_READY",
      timestamp: "2026-10-03T12:01:00.000Z",
      taskId: "task-1",
      payload: {}
    }, { expectedRevision: 0 });
    await expect(waiting).resolves.toMatchObject({ revision: 1 });

    const abort = new AbortController();
    const abortedWait = store.waitForRevision(1, abort.signal);
    abort.abort(new Error("test cancel"));
    await expect(abortedWait).rejects.toMatchObject({ name: "AbortError" });
  });

  it("closes the abort-registration race and removes the late listener", async () => {
    const { rootDir, plan } = await fixture();
    const store = await createSwarmLiveStore({ rootDir, plan });
    const abort = new AbortController();
    const originalAdd = abort.signal.addEventListener.bind(abort.signal);
    const originalRemove = abort.signal.removeEventListener.bind(abort.signal);
    let removed = 0;
    vi.spyOn(abort.signal, "addEventListener").mockImplementation((type, listener, options) => {
      abort.abort(new Error("abort-before-registration"));
      originalAdd(type, listener, options);
    });
    vi.spyOn(abort.signal, "removeEventListener").mockImplementation((type, listener, options) => {
      removed += 1;
      originalRemove(type, listener, options);
    });

    const outcome = await Promise.race([
      store.waitForRevision(0, abort.signal).then(
        () => "resolved",
        (error: unknown) => (error as Error).name === "AbortError" ? "aborted" : "wrong-error"
      ),
      new Promise<string>((resolvePromise) => setTimeout(() => resolvePromise("hung"), 100))
    ]);

    expect(outcome).toBe("aborted");
    expect(removed).toBe(1);
  });

  it("rejects malformed events and direct SWARM_VERIFIED forgery", async () => {
    const { rootDir, plan } = await fixture();
    const store = await createSwarmLiveStore({ rootDir, plan });

    await expect(store.append({
      idempotencyKey: "bad-failure",
      type: "CHILD_STOPPED",
      timestamp: "2026-10-03T12:01:00.000Z",
      failureClass: "dependency_blocked" as never,
      payload: {}
    }, { expectedRevision: 0 })).rejects.toMatchObject({ code: "INVALID_EVENT" });
    await expect(store.append({
      idempotencyKey: "forged-verified",
      type: "SWARM_VERIFIED",
      timestamp: "2026-10-03T12:02:00.000Z",
      payload: { claimedBy: "child" }
    }, { expectedRevision: 0 })).rejects.toMatchObject({ code: "PARENT_VERIFIED_AUTHORITY_REQUIRED" });

    expect((await store.readSnapshot()).outcome.state).toBe("running");
    expect(await readFile(store.paths().events, "utf8")).toBe("");
  });

  it("durably persists only an actual parent pipeline terminal result", async () => {
    const { rootDir, plan } = await fixture();
    const store = await createSwarmLiveStore({ rootDir, plan });
    const record = createSwarmRunRecord({
      swarmId: plan.swarmId,
      workspaceId: plan.workspaceId,
      projectId: plan.projectId,
      parentContract: plan.parentContract,
      tasks: plan.tasks,
      agents: plan.agents,
      budgetLedger: {
        capUsd: plan.parentContract.budget.maxUsd,
        capTokens: plan.parentContract.budget.maxTokens ?? 0,
        settledUsd: 0,
        settledTokens: 0,
        leases: []
      },
      createdAt: plan.createdAt,
      updatedAt: plan.createdAt
    }, { now: plan.createdAt });
    const abort = new AbortController();
    abort.abort("operator_cancelled");
    await store.append({
      idempotencyKey: `${plan.planHash}:created`,
      type: "SWARM_CREATED",
      timestamp: plan.createdAt,
      payload: {}
    }, { expectedRevision: 0 });
    const parent = await runParentSwarmPipeline({
      record,
      candidateIds: [],
      workspaceManager: {} as never,
      evidenceStore: {} as never,
      integrationWorkspaceId: "integration-unused",
      verifierWorkspaceId: "verifier-unused",
      verifierExecutor: {} as never,
      signal: abort.signal,
      now: () => "2026-10-03T12:05:00.000Z"
    });

    await expect(store.persistParentOutcome(
      JSON.parse(JSON.stringify(parent)),
      { expectedRevision: 0 }
    )).rejects.toMatchObject({ code: "PARENT_PIPELINE_AUTHORITY_REQUIRED" });
    const persisted = await store.persistParentOutcome(parent, { expectedRevision: 1 });
    const replayed = await store.persistParentOutcome(parent, {
      expectedRevision: persisted.snapshot.revision
    });
    const competing = await runParentSwarmPipeline({
      record,
      candidateIds: [],
      workspaceManager: {} as never,
      evidenceStore: {} as never,
      integrationWorkspaceId: "integration-unused",
      verifierWorkspaceId: "verifier-unused",
      verifierExecutor: {} as never,
      signal: abort.signal,
      now: () => "2026-10-03T12:06:00.000Z"
    });
    await expect(store.persistParentOutcome(competing, {
      expectedRevision: replayed.snapshot.revision
    })).rejects.toMatchObject({ code: "PARENT_PIPELINE_EVENT_MISMATCH" });
    const reopened = await openSwarmLiveStore({ rootDir, swarmId: plan.swarmId });

    expect(replayed.duplicate).toBe(true);
    expect((await reopened.readSnapshot()).outcome.state).toBe(parent.outcome.state);
    expect(await reopened.readEvents()).toEqual([
      expect.objectContaining({ type: "SWARM_CREATED" }),
      expect.objectContaining({
        type: parent.outcome.state === "stopped" ? "SWARM_STOPPED" : "SWARM_NEEDS_REVIEW",
        payload: expect.objectContaining({ parentPipelineAuthority: "runParentSwarmPipeline:v1" })
      })
    ]);
  });
});

interface IndependentReclaimerResult {
  status: "success" | "error";
  opened: boolean;
  code?: string;
  stderr?: string;
}

async function runIndependentReclaimer(input: {
  rootDir: string;
  swarmId: string;
  readyPath: string;
  goPath: string;
  label: string;
  expectedRevision: number;
}): Promise<IndependentReclaimerResult> {
  const moduleUrl = new URL("../src/swarm/live-store.ts", import.meta.url).href;
  const tsconfigPath = fileURLToPath(new URL("../tsconfig.json", import.meta.url));
  const script = `
    import { appendFile, readFile } from "node:fs/promises";
    const { openSwarmLiveStore } = await import(process.env.STORE_MODULE_URL);
    await appendFile(process.env.READY_PATH, process.env.LABEL + "\\n", "utf8");
    while (!(await readFile(process.env.GO_PATH).then(() => true).catch(() => false))) {
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    let opened = false;
    try {
      const store = await openSwarmLiveStore({ rootDir: process.env.ROOT_DIR, swarmId: process.env.SWARM_ID });
      opened = true;
      await store.append({
        idempotencyKey: "reclaimer:" + process.env.LABEL,
        type: "TASK_ASSIGNED",
        timestamp: process.env.LABEL === "first" ? "2026-10-03T13:00:00.000Z" : "2026-10-03T13:00:01.000Z",
        taskId: "task-1",
        agentId: "agent-1",
        payload: {}
      }, { expectedRevision: Number(process.env.EXPECTED_REVISION) });
      console.log("RESULT:" + JSON.stringify({ status: "success", opened }));
    } catch (error) {
      console.log("RESULT:" + JSON.stringify({ status: "error", opened, code: error?.code ?? "UNKNOWN" }));
    }
  `;
  return new Promise<IndependentReclaimerResult>((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", script], {
      cwd: fileURLToPath(new URL("../../..", import.meta.url)),
      env: {
        ...process.env,
        TSX_TSCONFIG_PATH: tsconfigPath,
        STORE_MODULE_URL: moduleUrl,
        ROOT_DIR: input.rootDir,
        SWARM_ID: input.swarmId,
        READY_PATH: input.readyPath,
        GO_PATH: input.goPath,
        LABEL: input.label,
        EXPECTED_REVISION: String(input.expectedRevision)
      },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    child.once("error", rejectPromise);
    child.once("exit", () => {
      const line = stdout.split(/\r?\n/u).find((candidate) => candidate.startsWith("RESULT:"));
      if (!line) {
        rejectPromise(new Error(`Independent reclaimer did not report a result: ${stderr || stdout}`));
        return;
      }
      resolvePromise({ ...JSON.parse(line.slice("RESULT:".length)), stderr } as IndependentReclaimerResult);
    });
  });
}

async function waitForReadyChildren(path: string, count: number): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const ready = await readFile(path, "utf8").catch(() => "");
    if (ready.split(/\r?\n/u).filter(Boolean).length >= count) return;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 5));
  }
  throw new Error("Independent reclaimers did not reach the start barrier.");
}
