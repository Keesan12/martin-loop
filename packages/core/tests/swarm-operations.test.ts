import { mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createSwarmLivePlan, type SwarmLivePlanDraft } from "@martin/contracts";
import { describe, expect, it } from "vitest";

import {
  readSwarmOperationalState,
  requestSwarmOperationalCancellation,
  waitForSwarmOperationalRevision,
} from "../src/swarm/operations.js";
import { createSwarmLiveStore, openSwarmLiveStore } from "../src/swarm/live-store.js";

function draft(swarmId: string, createdAt: string): SwarmLivePlanDraft {
  return {
    planId: `plan-${swarmId}`,
    swarmId,
    workspaceId: `workspace-${swarmId}`,
    projectId: "project-operations",
    baselineCommit: "a".repeat(40),
    parentContract: {
      policyVersion: "swarm-policy/live-v1",
      objective: `Operate ${swarmId}`,
      definitionOfDone: ["Parent verifier passes"],
      budget: { maxUsd: 2, softLimitUsd: 1, maxIterations: 2, maxTokens: 2_000 },
      maxWallClockMs: 60_000,
      maxConcurrency: 1,
      scope: { allowedPaths: ["packages/**"], deniedPaths: ["**/.env"] },
      permissions: { networkDomains: [], commands: ["pnpm test"] },
      integrationStrategy: "parent_fan_in",
      globalVerifierStack: [{ command: "pnpm test", type: "test_full" }],
      stopPolicy: { budgetExhausted: "stop", blockingFailure: "needs_review", verifierFailure: "stop" },
      recoveryPolicy: { maxReassignmentsPerTask: 0, dependencyWaiversAllowed: false },
      approvalPolicy: {},
      orchestrationStrategy: "parallel_dag",
    },
    tasks: [{
      taskId: "task-1", title: "Inspect", objective: "Inspect", required: true,
      dependsOn: [], assignedAgentId: "agent-1", status: "queued",
      mutationMode: "read_only", writeScope: [],
    }],
    agents: [{
      agentId: "agent-1", role: "Inspector", status: "queued",
      contract: {
        agentId: "agent-1", taskIds: ["task-1"],
        scope: { allowedPaths: ["packages/**"], deniedPaths: ["**/.env"] },
        budget: { maxUsd: 1, softLimitUsd: 0.5, maxIterations: 1, maxTokens: 1_000 },
        maxWallClockMs: 30_000,
        permissions: { networkDomains: [], commands: ["pnpm test"] },
        approvalPolicy: {}, verifierAuthority: "child_only",
      },
    }],
    engine: { engine: "codex", model: "gpt-test" },
    childMaxIterations: 1,
    createdAt,
  };
}

describe("swarm operational facade", () => {
  it("reads selected and latest durable state after restart with the full event history", async () => {
    const runsRoot = await mkdtemp(join(tmpdir(), "martin-swarm-operations-"));
    const older = createSwarmLivePlan(draft("swarm-older", "2026-10-03T10:00:00.000Z"));
    const latest = createSwarmLivePlan(draft("swarm-latest", "2026-10-03T11:00:00.000Z"));
    await createSwarmLiveStore({ rootDir: runsRoot, plan: older });
    const store = await createSwarmLiveStore({ rootDir: runsRoot, plan: latest });
    await store.append({
      idempotencyKey: "task-1:ready", type: "TASK_READY",
      timestamp: "2026-10-03T11:01:00.000Z", taskId: "task-1", payload: {},
    }, { expectedRevision: 0 });

    const selected = await readSwarmOperationalState({ runsRoot, swarmId: latest.swarmId });
    const newest = await readSwarmOperationalState({ runsRoot, latest: true });

    expect(selected).toEqual(newest);
    expect(selected.plan.planHash).toBe(latest.planHash);
    expect(selected.snapshot).toMatchObject({ revision: 1, lastEventType: "TASK_READY" });
    expect(selected.events).toEqual([expect.objectContaining({ sequence: 1, type: "TASK_READY" })]);
  });

  it("rejects traversal IDs and a pre-created _swarms junction escape", async () => {
    const runsRoot = await mkdtemp(join(tmpdir(), "martin-swarm-contained-"));
    await expect(readSwarmOperationalState({ runsRoot, swarmId: "../../escape" }))
      .rejects.toMatchObject({ code: expect.stringMatching(/UNSAFE|INVALID/u) });

    const escapedRoot = await mkdtemp(join(tmpdir(), "martin-swarm-escaped-"));
    await symlink(escapedRoot, join(runsRoot, "_swarms"), process.platform === "win32" ? "junction" : "dir");
    await expect(readSwarmOperationalState({ runsRoot, latest: true }))
      .rejects.toMatchObject({ code: "STORE_PATH_ESCAPE" });
  });

  it("opens an explicitly selected store through its validated canonical directory", async () => {
    const source = await readFile(new URL("../src/swarm/operations.ts", import.meta.url), "utf8");
    expect(source).toContain("openSwarmLiveStoreAtDirectory({ directory");
    expect(source).not.toContain("openSwarmLiveStore({ rootDir: runsRoot");
  });

  it("surfaces malformed selected stores as typed corruption", async () => {
    const runsRoot = await mkdtemp(join(tmpdir(), "martin-swarm-malformed-"));
    const directory = join(runsRoot, "_swarms", "swarm-bad");
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "plan.json"), "{broken", "utf8");

    await expect(readSwarmOperationalState({ runsRoot, swarmId: "swarm-bad" }))
      .rejects.toMatchObject({ code: expect.stringMatching(/MALFORMED|INVALID/u) });
  });

  it("wakes across independently opened stores and removes an aborted wait", async () => {
    const runsRoot = await mkdtemp(join(tmpdir(), "martin-swarm-wakeup-"));
    const plan = createSwarmLivePlan(draft("swarm-wakeup", "2026-10-03T12:00:00.000Z"));
    await createSwarmLiveStore({ rootDir: runsRoot, plan });
    const writer = await openSwarmLiveStore({ rootDir: runsRoot, swarmId: plan.swarmId });
    const wait = waitForSwarmOperationalRevision({
      runsRoot, swarmId: plan.swarmId, afterRevision: 0,
    });
    await writer.append({
      idempotencyKey: "task-1:ready", type: "TASK_READY",
      timestamp: "2026-10-03T12:01:00.000Z", taskId: "task-1", payload: {},
    }, { expectedRevision: 0 });
    await expect(wait).resolves.toMatchObject({ snapshot: { revision: 1 } });

    const abort = new AbortController();
    const aborted = waitForSwarmOperationalRevision({
      runsRoot, swarmId: plan.swarmId, afterRevision: 1, signal: abort.signal,
    });
    abort.abort("done");
    await expect(aborted).rejects.toMatchObject({ name: "AbortError" });
    expect(await readFile(join(runsRoot, "_swarms", plan.swarmId, "events.jsonl"), "utf8"))
      .toContain("TASK_READY");
  });

  it("records one authoritative cancellation and preserves its original bytes on repeats", async () => {
    const runsRoot = await mkdtemp(join(tmpdir(), "martin-swarm-cancel-"));
    const plan = createSwarmLivePlan(draft("swarm-cancel", "2026-10-03T12:00:00.000Z"));
    const store = await createSwarmLiveStore({ rootDir: runsRoot, plan });
    const first = await requestSwarmOperationalCancellation({
      runsRoot, swarmId: plan.swarmId, reason: "operator_requested",
      requestedBy: "cli",
    });
    const before = await readFile(store.paths().events, "utf8");
    const repeat = await requestSwarmOperationalCancellation({
      runsRoot, swarmId: plan.swarmId, reason: "must-not-overwrite",
      requestedBy: "other",
    });

    expect(first.outcome).toBe("created");
    expect(repeat.outcome).toBe("already_requested");
    expect(await readFile(store.paths().events, "utf8")).toBe(before);
    expect(repeat.state.snapshot.cancellation).toMatchObject({
      reason: "operator_requested", requestedBy: "cli",
    });
  });

  it("makes cancellation a no-op after a terminal claim wins the store order", async () => {
    const runsRoot = await mkdtemp(join(tmpdir(), "martin-swarm-terminal-cancel-"));
    const plan = createSwarmLivePlan(draft("swarm-terminal", "2026-10-03T12:00:00.000Z"));
    const store = await createSwarmLiveStore({ rootDir: runsRoot, plan });
    await store.append({
      idempotencyKey: "parent:stopped", type: "SWARM_STOPPED",
      timestamp: "2026-10-03T12:01:00.000Z", payload: { reason: "complete" },
    }, { expectedRevision: 0 });
    const before = await readFile(store.paths().events, "utf8");

    const result = await requestSwarmOperationalCancellation({
      runsRoot, swarmId: plan.swarmId, reason: "too-late",
      requestedBy: "cli",
    });

    expect(result.outcome).toBe("already_terminal");
    expect(result.state.snapshot.outcome.state).toBe("stopped");
    expect(await readFile(store.paths().events, "utf8")).toBe(before);
  });
});
