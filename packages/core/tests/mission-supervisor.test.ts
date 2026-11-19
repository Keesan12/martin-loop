import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  MissionSupervisorError,
  buildMorningDossier,
  createMissionSupervisor,
  decideRecovery,
  evaluateMissionStop,
  getProgressSnapshot,
  stopMission,
  transitionWorkItem,
  validateWorkItemDag,
  type MissionSupervisorState,
  type MissionWorkItem
} from "../src/mission/index.js";

const roots: string[] = [];

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "martin-supervisor-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function workItems(): MissionWorkItem[] {
  return [
    {
      id: "design",
      title: "Design durable state",
      dependsOn: [],
      status: "succeeded",
      attempts: 1,
      maxAttempts: 2,
      updatedAt: "2026-11-03T01:00:00.000Z"
    },
    {
      id: "implement",
      title: "Implement supervisor",
      dependsOn: ["design"],
      status: "running",
      attempts: 1,
      maxAttempts: 3,
      updatedAt: "2026-11-03T02:00:00.000Z"
    },
    {
      id: "verify",
      title: "Verify behavior",
      dependsOn: ["implement"],
      status: "pending",
      attempts: 0,
      maxAttempts: 2,
      updatedAt: "2026-11-03T00:00:00.000Z"
    }
  ];
}

function freshWorkItems(): MissionWorkItem[] {
  return workItems().map((item) => ({
    ...item,
    status: "pending",
    attempts: 0,
    dependsOn: [...item.dependsOn]
  }));
}

function state(overrides: Partial<MissionSupervisorState> = {}): MissionSupervisorState {
  const result: MissionSupervisorState = {
    schemaVersion: "martin.mission-supervisor.v1",
    missionId: "mission-1",
    objective: "Run safely overnight",
    createdAt: "2026-11-03T00:00:00.000Z",
    updatedAt: "2026-11-03T02:00:00.000Z",
    workItems: workItems(),
    recoveryDecisions: [],
    budget: {
      maxUsd: 3,
      spentUsd: 1.25,
      startedAt: "2026-11-03T00:00:00.000Z",
      wallClockDeadline: "9999-12-31T23:59:59.999Z",
      maxRuns: 10,
      runsUsed: 1,
      maxTokens: 100_000,
      tokensUsed: 1_000,
      maxConcurrency: 2,
      activeConcurrency: 1,
      maxNoProgressIntervals: 3,
      noProgressIntervals: 0
    },
    accountingOpening: { spentUsd: 1.25, runsUsed: 1, tokensUsed: 1_000 },
    settlements: [],
    ...overrides
  };
  if (overrides.budget !== undefined && overrides.accountingOpening === undefined &&
      overrides.settlements === undefined) {
    result.accountingOpening = {
      spentUsd: result.budget.spentUsd,
      runsUsed: result.budget.runsUsed,
      tokensUsed: result.budget.tokensUsed
    };
  }
  return result;
}

describe("work-item DAG validation", () => {
  it("rejects duplicate ids, missing dependencies, and cycles", () => {
    expect(() => validateWorkItemDag([
      ...workItems(),
      { ...workItems()[0]!, title: "duplicate" }
    ])).toThrow(expect.objectContaining({ code: "duplicate_work_item" }));

    expect(() => validateWorkItemDag([
      { ...workItems()[0]!, dependsOn: ["missing"] }
    ])).toThrow(expect.objectContaining({ code: "missing_dependency" }));

    expect(() => validateWorkItemDag([
      { ...workItems()[0]!, id: "a", dependsOn: ["b"] },
      { ...workItems()[1]!, id: "b", dependsOn: ["a"] }
    ])).toThrow(expect.objectContaining({ code: "dependency_cycle" }));
  });
});

describe("MissionSupervisor durability and authority", () => {
  it("persists and reloads a validated mission state through checkpoints", async () => {
    const root = await tempRoot();
    const supervisor = createMissionSupervisor({ root, missionId: "mission-1" });
    const initialized = await supervisor.initialize({
      objective: "Run safely overnight",
      workItems: freshWorkItems(),
      budget: { maxUsd: 3, spentUsd: 0 },
      checkpointId: "mission-init",
      writerId: "supervisor-a",
      now: "2026-11-03T00:00:00.000Z"
    });

    expect(initialized.state.missionId).toBe("mission-1");
    await expect(supervisor.load()).resolves.toEqual(initialized.state);
  });

  it("uses a separate exclusive lease and rejects a non-holder save", async () => {
    const root = await tempRoot();
    const supervisor = createMissionSupervisor({ root, missionId: "mission-1" });
    const initialized = await supervisor.initialize({
      objective: "Run safely overnight",
      workItems: freshWorkItems(),
      budget: { maxUsd: 3, spentUsd: 0 },
      checkpointId: "mission-init",
      writerId: "bootstrap"
    });
    const lease = await supervisor.acquireLease({
      holderId: "supervisor-a",
      ttlMs: 60_000,
      now: "2026-11-03T00:00:00.000Z"
    });

    await expect(supervisor.acquireLease({
      holderId: "supervisor-b",
      ttlMs: 60_000,
      now: "2026-11-03T00:00:01.000Z"
    })).rejects.toMatchObject({ code: "lease_held" });

    await expect(supervisor.save(
      { ...initialized.state, updatedAt: "2026-11-03T00:00:02.000Z" },
      {
        checkpointId: "mission-save-denied",
        expectedHeadHash: initialized.checkpointHash,
        leaseToken: "not-the-token",
        now: "2026-11-03T00:00:02.000Z"
      }
    )).rejects.toMatchObject({ code: "lease_lost" });

    const saved = await supervisor.save(
      { ...initialized.state, updatedAt: "2026-11-03T00:00:02.000Z" },
      {
        checkpointId: "mission-save",
        expectedHeadHash: initialized.checkpointHash,
        leaseToken: lease.token,
        now: "2026-11-03T00:00:02.000Z"
      }
    );
    expect(saved.checkpointHash).not.toBe(initialized.checkpointHash);
  });

  it("allows deterministic takeover only after a lease expires", async () => {
    const root = await tempRoot();
    const supervisor = createMissionSupervisor({ root, missionId: "mission-1" });
    await supervisor.acquireLease({
      holderId: "supervisor-a",
      ttlMs: 1_000,
      now: "2026-11-03T00:00:00.000Z"
    });
    const takeover = await supervisor.acquireLease({
      holderId: "supervisor-b",
      ttlMs: 1_000,
      now: "2026-11-03T00:00:02.000Z"
    });
    expect(takeover.holderId).toBe("supervisor-b");
  });
});

describe("supervisor decisions and morning evidence", () => {
  it("reports measurable progress and runnable work from dependency truth", () => {
    expect(getProgressSnapshot(state())).toEqual({
      total: 3,
      pending: 1,
      running: 1,
      succeeded: 1,
      verified: 0,
      failed: 0,
      blocked: 0,
      cancelled: 0,
      terminal: 0,
      completionRatio: 0,
      runnableWorkItemIds: []
    });
  });

  it("bounds recovery decisions and emits typed stop reasons", () => {
    const failedState = state({
      workItems: workItems().map((item) =>
        item.id === "implement" ? { ...item, status: "failed", attempts: 1 } : item
      )
    });
    const retry = decideRecovery(failedState, "implement", {
      maxRecoveryDecisions: 2,
      now: "2026-11-03T03:00:00.000Z"
    });
    expect(retry.decision.kind).toBe("retry");
    expect(retry.state.recoveryDecisions).toHaveLength(1);

    const exhausted = decideRecovery({
      ...retry.state,
      recoveryDecisions: [
        ...retry.state.recoveryDecisions,
        { ...retry.decision, decisionId: "existing", kind: "retry" }
      ]
    }, "implement", {
      maxRecoveryDecisions: 2,
      now: "2026-11-03T03:01:00.000Z"
    });
    expect(exhausted.decision.kind).toBe("stop");
    expect(exhausted.state.stop).toMatchObject({ code: "recovery_limit" });

    expect(() => stopMission(state(), { code: "not-real" } as never)).toThrow(
      expect.objectContaining<Partial<MissionSupervisorError>>({ code: "invalid_stop_reason" })
    );
  });

  it("derives deterministic terminal reasons without mutating mission state", () => {
    const originalState = state();
    const original = state({ budget: { ...originalState.budget, maxUsd: 3, spentUsd: 3 } });
    expect(evaluateMissionStop(original, "2026-11-03T04:00:00.000Z")).toEqual({
      code: "budget_exhausted",
      message: "mission budget is exhausted",
      at: "2026-11-03T04:00:00.000Z"
    });
    expect(original.stop).toBeUndefined();

    const complete = state({
      workItems: workItems().map((item) => ({
        ...item,
        status: "verified" as const,
        verification: {
          verifierId: "verifier",
          evidenceHash: "a".repeat(64),
          source: "test",
          verifiedAt: "2026-11-03T04:00:00.000Z"
        }
      }))
    });
    expect(evaluateMissionStop(complete, "2026-11-03T04:01:00.000Z")).toMatchObject({
      code: "completed"
    });

    const deadlocked = state({
      workItems: [
        { ...workItems()[0]!, id: "a", status: "blocked", dependsOn: [] },
        { ...workItems()[1]!, id: "b", status: "pending", dependsOn: ["a"] }
      ]
    });
    expect(evaluateMissionStop(deadlocked, "2026-11-03T04:02:00.000Z")).toMatchObject({
      code: "no_runnable_work"
    });
  });

  it("builds bounded morning dossier data with blockers, recovery, cost, and stop truth", () => {
    const stopped = stopMission(state({
      workItems: workItems().map((item) =>
        item.id === "implement"
          ? { ...item, status: "blocked", lastError: "provider unavailable" }
          : item
      )
    }), {
      code: "operator_stop",
      message: "overnight window ended",
      at: "2026-11-03T07:00:00.000Z"
    });
    const dossier = buildMorningDossier(stopped, { maxItems: 2 });

    expect(dossier.missionId).toBe("mission-1");
    expect(dossier.progress.blocked).toBe(1);
    expect(dossier.blockers).toEqual([
      { workItemId: "implement", title: "Implement supervisor", reason: "provider unavailable" }
    ]);
    expect(dossier.budget).toMatchObject({ maxUsd: 3, spentUsd: 1.25, remainingUsd: 1.75 });
    expect(dossier.stop).toMatchObject({ code: "operator_stop" });
    expect(dossier.workItems).toHaveLength(2);
    expect(dossier.truncatedWorkItemCount).toBe(1);
  });
});


describe("MissionSupervisor authority regressions", () => {
  it("rejects oversized DAG state before compaction can remove dependencies", async () => {
    const root = await tempRoot();
    const supervisor = createMissionSupervisor({ root, missionId: "mission-1", maxArrayEntries: 2 });
    await expect(supervisor.initialize({
      objective: "Preserve dependency truth", workItems: freshWorkItems(),
      budget: { maxUsd: 3, spentUsd: 0 }, checkpointId: "init", writerId: "bootstrap"
    })).rejects.toMatchObject({ code: "invalid_mission_state" });
    await expect(supervisor.load()).resolves.toBeNull();
  });

  it("serializes save authority with lease mutation", async () => {
    const root = await tempRoot();
    const supervisor = createMissionSupervisor({ root, missionId: "mission-1", leaseLockTimeoutMs: 1 });
    const initialized = await supervisor.initialize({
      objective: "Fence lease changes", workItems: freshWorkItems(),
      budget: { maxUsd: 3, spentUsd: 0 }, checkpointId: "init", writerId: "bootstrap"
    });
    const lease = await supervisor.acquireLease({ holderId: "writer", ttlMs: 60_000 });
    await writeFile(join(root, "missions", "mission-1", ".supervisor-lease.lock"), "other process");
    await expect(supervisor.save(initialized.state, {
      checkpointId: "save", expectedHeadHash: initialized.checkpointHash, leaseToken: lease.token
    })).rejects.toMatchObject({ code: "lease_lock_timeout" });
    await expect(supervisor.load()).resolves.toEqual(initialized.state);
  });

  it("rejects invalid lease time rather than bypassing expiry", async () => {
    const root = await tempRoot();
    const supervisor = createMissionSupervisor({ root, missionId: "mission-1" });
    const initialized = await supervisor.initialize({
      objective: "Validate authority", workItems: freshWorkItems(),
      budget: { maxUsd: 3, spentUsd: 0 }, checkpointId: "init", writerId: "bootstrap"
    });
    const lease = await supervisor.acquireLease({ holderId: "writer", ttlMs: 60_000 });
    await expect(supervisor.save(initialized.state, {
      checkpointId: "save", expectedHeadHash: initialized.checkpointHash,
      leaseToken: lease.token, now: "not-a-date"
    })).rejects.toThrow(TypeError);
  });

  it("does not offer exhausted attempts as runnable work or restart stopped recovery", () => {
    const exhausted = state({ workItems: [{
      ...workItems()[0]!, status: "pending", attempts: 2, maxAttempts: 2
    }] });
    expect(getProgressSnapshot(exhausted).runnableWorkItemIds).toEqual([]);
    expect(evaluateMissionStop(exhausted, "2026-11-03T04:00:00.000Z")?.code).toBe("no_runnable_work");
    const stopped = stopMission(state(), {
      code: "operator_stop", message: "Stop now", at: "2026-11-03T04:00:00.000Z"
    });
    const result = decideRecovery(stopped, "implement", { maxRecoveryDecisions: 2 });
    expect(result.decision.kind).toBe("stop");
    expect(result.state.stop).toEqual(stopped.stop);
    expect(() => createMissionSupervisor({ root: ".", missionId: "../escape" })).toThrow(TypeError);
  });
});

describe("MissionSupervisor release-blocking authority contracts", () => {
  it("reserves succeeded-to-blocked reconciliation for mission-runtime supervisor authority", () => {
    const evidence = {
      hash: "f".repeat(64),
      source: "child:run-1",
      observedAt: "2026-11-04T04:00:00.000Z"
    };
    expect(() => transitionWorkItem(state(), {
      workItemId: "design",
      to: "blocked",
      actor: { id: "child-run-adapter", role: "executor" },
      evidence
    })).toThrow(expect.objectContaining({ code: "transition_not_authorized" }));

    const reconciled = transitionWorkItem(state(), {
      workItemId: "design",
      to: "blocked",
      actor: { id: "mission-runtime", role: "supervisor" },
      evidence
    });
    expect(reconciled.workItems.find((item) => item.id === "design")?.status).toBe("blocked");
  });

  it("requires validated verifier authority and evidence before VERIFIED", () => {
    const running = state({
      workItems: workItems().map((item) => item.id === "implement"
        ? { ...item, status: "running" }
        : item)
    });
    const succeeded = transitionWorkItem(running, {
      workItemId: "implement",
      to: "succeeded",
      actor: { id: "executor-1", role: "executor" },
      evidence: { hash: "a".repeat(64), source: "run-receipt", observedAt: "2026-11-03T03:00:00.000Z" }
    });
    expect(() => transitionWorkItem(succeeded, {
      workItemId: "implement",
      to: "verified",
      actor: { id: "executor-1", role: "executor" },
      evidence: { hash: "b".repeat(64), source: "verifier", observedAt: "2026-11-03T03:01:00.000Z" }
    })).toThrow(expect.objectContaining({ code: "transition_not_authorized" }));

    const verified = transitionWorkItem(succeeded, {
      workItemId: "implement",
      to: "verified",
      actor: { id: "verifier-1", role: "verifier" },
      evidence: { hash: "b".repeat(64), source: "verifier", observedAt: "2026-11-03T03:01:00.000Z" }
    });
    expect(verified.workItems.find((item) => item.id === "implement")).toMatchObject({
      status: "verified",
      verification: { verifierId: "verifier-1", evidenceHash: "b".repeat(64) }
    });
  });

  it("rejects caller-seeded succeeded work when initializing a fresh mission", async () => {
    const root = await tempRoot();
    const supervisor = createMissionSupervisor({ root, missionId: "mission-1" });
    await expect(supervisor.initialize({
      objective: "Do not trust caller success",
      workItems: workItems(),
      budget: { maxUsd: 3, spentUsd: 0 },
      checkpointId: "init",
      writerId: "bootstrap"
    })).rejects.toMatchObject({ code: "transition_not_authorized" });
  });

  it("supports the complete operational stop taxonomy", () => {
    const codes = [
      "wall_clock_exhausted", "no_progress", "external_event", "provider_failure",
      "policy_blocked", "scope_violation", "approval_required", "human_interrupt",
      "security_risk", "host_failure", "corrupt_state"
    ] as const;
    for (const code of codes) {
      expect(stopMission(state(), {
        code,
        message: code,
        at: "2026-11-03T05:00:00.000Z"
      }).stop?.code).toBe(code);
    }
  });

  it("enforces wall-clock, run, token, concurrency, and no-progress budgets", () => {
    const budget = {
      maxUsd: 3, spentUsd: 1,
      startedAt: "2026-11-03T00:00:00.000Z",
      wallClockDeadline: "2026-11-03T06:00:00.000Z",
      maxRuns: 5, runsUsed: 2,
      maxTokens: 10_000, tokensUsed: 2_000,
      maxConcurrency: 2, activeConcurrency: 1,
      maxNoProgressIntervals: 3, noProgressIntervals: 1
    };
    expect(evaluateMissionStop(state({ budget }), "2026-11-03T06:00:00.000Z")).toMatchObject({
      code: "wall_clock_exhausted"
    });
    expect(evaluateMissionStop(state({ budget: { ...budget, runsUsed: 5 } }), "2026-11-03T05:00:00.000Z")).toMatchObject({
      code: "budget_exhausted"
    });
    expect(evaluateMissionStop(state({ budget: { ...budget, tokensUsed: 10_000 } }), "2026-11-03T05:00:00.000Z")).toMatchObject({
      code: "budget_exhausted"
    });
    expect(evaluateMissionStop(state({ budget: { ...budget, noProgressIntervals: 3 } }), "2026-11-03T05:00:00.000Z")).toMatchObject({
      code: "no_progress"
    });
    expect(getProgressSnapshot(state({ budget: { ...budget, activeConcurrency: 2 } })).runnableWorkItemIds).toEqual([]);
  });

  it("persists lease heartbeats and rejects backward-clock renewal", async () => {
    const root = await tempRoot();
    const supervisor = createMissionSupervisor({ root, missionId: "mission-1" });
    const lease = await supervisor.acquireLease({
      holderId: "a", ttlMs: 60_000, now: "2026-11-03T01:00:00.000Z"
    });
    expect(lease.heartbeatAt).toBe("2026-11-03T01:00:00.000Z");
    const renewed = await supervisor.renewLease({
      leaseToken: lease.token, ttlMs: 60_000, now: "2026-11-03T01:00:30.000Z"
    });
    expect(renewed.heartbeatAt).toBe("2026-11-03T01:00:30.000Z");
    await expect(supervisor.renewLease({
      leaseToken: lease.token, ttlMs: 60_000, now: "2026-11-03T00:59:00.000Z"
    })).rejects.toMatchObject({ code: "clock_anomaly" });
  });

  it("admits only one lease owner across independent processes", async () => {
    const root = await tempRoot();
    const moduleUrl = new URL("../src/mission/supervisor.ts", import.meta.url).href;
    const run = promisify(execFile);
    const results = await Promise.all(["a", "b"].map(async (holderId) => {
      const script = `
        const { createMissionSupervisor } = await import(${JSON.stringify(moduleUrl)});
        const supervisor = createMissionSupervisor({ root: ${JSON.stringify(root)}, missionId: "mission-1" });
        try {
          await supervisor.acquireLease({ holderId: ${JSON.stringify(holderId)}, ttlMs: 60000, now: "2026-11-03T01:00:00.000Z" });
          console.log("acquired");
        } catch (error) {
          if (error.code !== "lease_held") throw error;
          console.log(error.code);
        }
      `;
      const result = await run(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script]);
      return result.stdout.trim();
    }));
    expect(results.sort()).toEqual(["acquired", "lease_held"]);
  });

  it("rejects DAG mutation and non-USD recovery after initialization", async () => {
    const root = await tempRoot();
    const supervisor = createMissionSupervisor({ root, missionId: "mission-1" });
    const initialized = await supervisor.initialize({
      objective: "Immutable DAG",
      workItems: freshWorkItems(),
      budget: { maxUsd: 3, spentUsd: 0 },
      checkpointId: "init",
      writerId: "bootstrap"
    });
    const lease = await supervisor.acquireLease({ holderId: "writer", ttlMs: 60_000 });
    const mutated = structuredClone(initialized.state);
    mutated.workItems.find((item) => item.id === "verify")!.dependsOn = ["design"];
    await expect(supervisor.save(mutated, {
      checkpointId: "mutated",
      expectedHeadHash: initialized.checkpointHash,
      leaseToken: lease.token
    })).rejects.toMatchObject({ code: "authority_mutation" });

    const failed = state({
      budget: { ...state().budget, tokensUsed: state().budget.maxTokens },
      workItems: workItems().map((item) => item.id === "implement"
        ? { ...item, status: "failed" }
        : item)
    });
    const recovery = decideRecovery(failed, "implement", {
      maxRecoveryDecisions: 2,
      now: "2026-11-03T03:00:00.000Z"
    });
    expect(recovery.decision.kind).toBe("stop");
    expect(recovery.state.stop?.code).toBe("budget_exhausted");
  });

  it("recovers a supervisor lease lock after both dead owners crash", async () => {
    const root = await tempRoot();
    const missionRoot = join(root, "missions", "mission-1");
    await mkdir(missionRoot, { recursive: true });
    await writeFile(join(missionRoot, ".supervisor-lease.lock"), JSON.stringify({
      token: "dead-lock", pid: 2_147_483_647, acquiredAt: "2000-01-01T00:00:00.000Z"
    }));
    await writeFile(join(missionRoot, ".supervisor-lease.lock.reclaim"), JSON.stringify({
      token: "dead-reclaimer", pid: 2_147_483_647, acquiredAt: "2000-01-01T00:00:00.000Z"
    }));
    const supervisor = createMissionSupervisor({
      root, missionId: "mission-1", leaseLockStaleMs: 1, leaseLockTimeoutMs: 100
    });
    await expect(supervisor.acquireLease({ holderId: "new-owner", ttlMs: 60_000 }))
      .resolves.toMatchObject({ holderId: "new-owner" });
  });

  it("rejects forged authority state and settles verifier evidence exactly once across restart", async () => {
    const root = await tempRoot();
    const supervisor = createMissionSupervisor({ root, missionId: "mission-1" });
    const initialized = await supervisor.initialize({
      objective: "Receipt-authoritative mission",
      workItems: freshWorkItems(),
      budget: { maxUsd: 10, spentUsd: 2, runsUsed: 1, tokensUsed: 100 },
      checkpointId: "init",
      writerId: "bootstrap"
    });
    const lease = await supervisor.acquireLease({
      holderId: "host",
      ttlMs: 7_200_000,
      now: "2026-11-04T04:00:00.000Z"
    });

    const forged = structuredClone(initialized.state);
    forged.workItems[0]!.status = "succeeded";
    forged.budget.spentUsd = 0;
    forged.stop = {
      code: "completed",
      message: "forged",
      at: "2026-11-03T05:00:00.000Z"
    };
    await expect(supervisor.save(forged, {
      checkpointId: "forged",
      expectedHeadHash: initialized.checkpointHash,
      leaseToken: lease.token,
      now: "2026-11-04T04:00:30.000Z"
    })).rejects.toMatchObject({ code: "authority_mutation" });

    const running = await supervisor.transitionWorkItem({
      workItemId: "design",
      to: "running",
      actor: { id: "host", role: "supervisor" },
      at: "2026-11-03T01:00:00.000Z"
    }, {
      checkpointId: "running",
      expectedHeadHash: initialized.checkpointHash,
      leaseToken: lease.token,
      now: "2026-11-04T04:01:00.000Z"
    });
    const succeeded = await supervisor.transitionWorkItem({
      workItemId: "design",
      to: "succeeded",
      actor: { id: "executor", role: "executor" },
      evidence: {
        hash: "a".repeat(64),
        source: "run-receipt",
        observedAt: "2026-11-04T04:05:00.000Z"
      }
    }, {
      checkpointId: "succeeded",
      expectedHeadHash: running.checkpointHash,
      leaseToken: lease.token,
      now: "2026-11-04T04:05:00.000Z"
    });

    await expect(supervisor.transitionWorkItem({
      workItemId: "design",
      to: "verified",
      actor: { id: "verifier", role: "verifier" },
      evidence: {
        hash: "c".repeat(64),
        source: "focused-tests",
        observedAt: "2026-11-04T04:05:30.000Z"
      }
    }, {
      checkpointId: "verify-without-settlement",
      expectedHeadHash: succeeded.checkpointHash,
      leaseToken: lease.token,
      now: "2026-11-04T04:05:30.000Z"
    })).rejects.toMatchObject({ code: "authority_mutation" });

    const settlement = {
      settlementId: "settlement-1",
      runId: "run-1",
      workItemId: "design",
      receiptHash: "b".repeat(64),
      actualUsd: 1.25,
      tokens: 500,
      settledAt: "2026-11-04T04:06:00.000Z",
      verifier: {
        passed: false,
        verifierId: "verifier",
        evidenceHash: "c".repeat(64),
        source: "focused-tests"
      }
    } as const;
    const failedVerification = await supervisor.recordSettlement(settlement, {
      checkpointId: "settlement",
      expectedHeadHash: succeeded.checkpointHash,
      leaseToken: lease.token,
      now: "2026-11-04T04:06:00.000Z"
    });
    expect(failedVerification.state.workItems.find((item) => item.id === "design")?.status)
      .toBe("succeeded");
    expect(failedVerification.state.budget).toMatchObject({
      spentUsd: 3.25,
      runsUsed: 2,
      tokensUsed: 600
    });
    expect(failedVerification.state.settlements).toHaveLength(1);

    const restarted = createMissionSupervisor({ root, missionId: "mission-1" });
    const duplicate = await restarted.recordSettlement(settlement, {
      checkpointId: "duplicate-ignored",
      expectedHeadHash: failedVerification.checkpointHash,
      leaseToken: lease.token,
      now: "2026-11-04T04:07:00.000Z"
    });
    expect(duplicate.checkpointHash).toBe(failedVerification.checkpointHash);
    expect(duplicate.state.settlements).toHaveLength(1);
    expect(duplicate.state.budget.spentUsd).toBe(3.25);

    await expect(restarted.recordSettlement({ ...settlement, actualUsd: 9 }, {
      checkpointId: "duplicate-conflict",
      expectedHeadHash: failedVerification.checkpointHash,
      leaseToken: lease.token,
      now: "2026-11-04T04:08:00.000Z"
    })).rejects.toMatchObject({ code: "settlement_conflict" });

    await expect(restarted.recordSettlement({
      ...settlement,
      settlementId: "settlement-over-budget",
      runId: "run-over-budget",
      receiptHash: "f".repeat(64),
      actualUsd: 100,
      tokens: 100,
      verifier: { ...settlement.verifier, passed: true, evidenceHash: "f".repeat(64) }
    }, {
      checkpointId: "verified-over-budget",
      expectedHeadHash: failedVerification.checkpointHash,
      leaseToken: lease.token,
      now: "2026-11-04T04:08:30.000Z"
    })).rejects.toMatchObject({ code: "settlement_conflict" });

    const passedVerification = await restarted.recordSettlement({
      ...settlement,
      settlementId: "settlement-2",
      runId: "run-2",
      receiptHash: "d".repeat(64),
      actualUsd: 0.5,
      tokens: 100,
      settledAt: "2026-11-04T04:09:00.000Z",
      verifier: { ...settlement.verifier, passed: true, evidenceHash: "e".repeat(64) }
    }, {
      checkpointId: "verified-settlement",
      expectedHeadHash: failedVerification.checkpointHash,
      leaseToken: lease.token,
      now: "2026-11-04T04:09:00.000Z"
    });
    expect(passedVerification.state.workItems.find((item) => item.id === "design"))
      .toMatchObject({
        status: "verified",
        verification: { evidenceHash: "e".repeat(64), verifierId: "verifier" }
      });
    expect(passedVerification.state.settlements).toHaveLength(2);
    expect(passedVerification.state.budget).toMatchObject({
      spentUsd: 3.75,
      runsUsed: 3,
      tokensUsed: 700
    });
  });
});
