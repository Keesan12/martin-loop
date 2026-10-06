import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { access, appendFile, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createSwarmLivePlan,
  type LoopRecord,
  type SwarmEvent,
  type SwarmLiveEvent,
  type SwarmLivePlan,
  type SwarmRunRecord,
  type SwarmTaskNode
} from "@martin/contracts";
import type { MartinAdapter, MartinAdapterRequest } from "../src/index";
import {
  isAuthoritativeLiveSwarmVerified,
  readSwarmReceiptProjection,
  runProductionLiveSwarm,
  runLiveSwarm,
  runLiveSwarmWithDependencies,
  sameCanonicalSwarmEvent,
  verifySwarmReceiptProjection,
  type RunLiveSwarmInput
} from "../src/swarm/live-runtime";
import { readSwarmOperationalState } from "../src/swarm/operations";
import { createSwarmLiveStore } from "../src/swarm/live-store";

let scratchRoot: string;
let previousIntegrityKeyDir: string | undefined;
const execFileAsync = promisify(execFile);

beforeEach(async () => {
  scratchRoot = await mkdtemp(join(tmpdir(), "martin-live-swarm-"));
  previousIntegrityKeyDir = process.env.MARTIN_INTEGRITY_KEY_DIR;
  process.env.MARTIN_INTEGRITY_KEY_DIR = join(scratchRoot, "keys");
});

afterEach(async () => {
  if (previousIntegrityKeyDir === undefined) delete process.env.MARTIN_INTEGRITY_KEY_DIR;
  else process.env.MARTIN_INTEGRITY_KEY_DIR = previousIntegrityKeyDir;
  await rm(scratchRoot, { recursive: true, force: true });
});

describe("runLiveSwarm", () => {
  it("dedupes only complete canonical event identities within the same millisecond", () => {
    const event = {
      type: "CHILD_STOPPED" as const,
      swarmId: "swarm-live",
      timestamp: "2026-10-03T00:00:00.000Z",
      parentPolicyVersion: "swarm-policy-v1",
      taskId: "task-a",
      agentId: "agent-a",
      childRunId: "child-a",
      failureClass: "environment_mismatch" as const,
      payload: { reason: "first", attemptId: "attempt-a" }
    };
    const differentFailure = { ...event, failureClass: "budget_pressure" as const };

    expect(sameCanonicalSwarmEvent(event, structuredClone(event))).toBe(true);
    expect(sameCanonicalSwarmEvent(event, { ...event, payload: { ...event.payload, reason: "second" } })).toBe(false);
    expect(sameCanonicalSwarmEvent(event, { ...event, parentPolicyVersion: "swarm-policy-v2" })).toBe(false);
    expect(sameCanonicalSwarmEvent(event, differentFailure)).toBe(false);
  });

  it("runs one child through runMartin with the exact engine, workspace, and iteration cap", async () => {
    const fixture = createFixture(createPlan([task("task-a")]));
    const seen: Array<{ model?: string; cwd: string; maxIterations: number }> = [];
    fixture.input.adapterFactory = ({ engine, workspace, budget }) => {
      seen.push({ model: engine.model, cwd: workspace.path, maxIterations: budget.maxIterations });
      return passAdapter(engine.model);
    };

    const result = await runLiveSwarmWithDependencies(fixture.input, fixture.dependencies);
    expect(seen).toEqual([{
      model: "gpt-test",
      cwd: join(scratchRoot, "workspaces", "child-1"),
      maxIterations: 1
    }]);
    expect(result.record.tasks[0]?.status).toBe("accepted");
    expect(result.outcome.state).toBe("needs_review");
  });

  it("preserves read-only authority and child network, approval, and wall-clock limits", async () => {
    const base = createPlan([task("task-a")]);
    const plan = createSwarmLivePlan({
      ...base,
      parentContract: {
        ...base.parentContract,
        maxWallClockMs: 30_000,
        permissions: { networkDomains: ["api.example.test"], commands: ["echo"] },
        approvalPolicy: { dependencyAdds: true },
      },
      agents: base.agents.map((agent) => ({
        ...agent,
        contract: {
          ...agent.contract,
          maxWallClockMs: 12_345,
          permissions: { networkDomains: ["api.example.test"], commands: ["echo"] },
          approvalPolicy: { dependencyAdds: true },
        },
      })),
    });
    const fixture = createFixture(plan);
    let request: MartinAdapterRequest | undefined;
    fixture.input.adapterFactory = ({ engine }) => ({
      ...passAdapter(engine.model),
      async execute(value) {
        request = value;
        return passedAdapterResult(value);
      },
    });

    await runLiveSwarmWithDependencies(fixture.input, fixture.dependencies);

    expect(request?.context).toMatchObject({
      allowedNetworkDomains: ["api.example.test"],
      approvalPolicy: { dependencyAdds: true },
      providerExecutionTimeoutMs: 12_345,
      deniedPaths: [".git/**"],
    });
    expect(request?.context.mutationMode).toBe("read_only");
    expect(request?.context.allowedPaths).toEqual(["src/**"]);
  });

  it.each(["workspace", "adapter"] as const)("redacts secrets from %s failures before outcomes and events persist", async (failurePoint) => {
    const fixture = createFixture(createPlan([task("task-a")]));
    const secret = failurePoint === "workspace"
      ? "sk-proj-workspace-secret-123456789"
      : "AKIAIOSFODNN7EXAMPLE";
    if (failurePoint === "workspace") {
      fixture.manager.createWorkspace = async () => {
        throw new Error(`workspace failed with ${secret}`);
      };
    } else {
      fixture.input.adapterFactory = () => {
        throw new Error(`adapter failed with ${secret}`);
      };
    }

    const result = await runLiveSwarmWithDependencies(fixture.input, fixture.dependencies);
    const persisted = JSON.stringify({ result, events: fixture.live.events });

    expect(persisted).not.toContain(secret);
    expect(persisted).toContain("[REDACTED");
    if (failurePoint === "workspace") {
      expect(fixture.live.events).toEqual(expect.arrayContaining([
        expect.objectContaining({
          type: "ACTION_BLOCKED",
          payload: expect.objectContaining({
            action: "workspace_creation",
            leaseId: expect.any(String),
            leaseState: "released",
            reservedUsd: 1,
            reservedTokens: 100
          })
        })
      ]));
    }
  });

  it("enforces the effective child and parent wall-clock deadline with the child AbortSignal", async () => {
    const base = createPlan([task("task-a")]);
    const plan = createSwarmLivePlan({
      ...base,
      parentContract: { ...base.parentContract, maxWallClockMs: 2_000 },
      agents: base.agents.map((agent) => ({
        ...agent,
        contract: { ...agent.contract, maxWallClockMs: 250 },
      })),
    });
    const fixture = createFixture(plan);
    let childSignal: AbortSignal | undefined;
    fixture.input.adapterFactory = ({ engine }) => ({
      ...passAdapter(engine.model),
      async execute(request) {
        childSignal = request.signal;
        return new Promise((resolvePromise, rejectPromise) => {
          request.signal?.addEventListener("abort", () => rejectPromise(request.signal?.reason), { once: true });
        });
      },
    });

    const settled = await Promise.race([
      runLiveSwarmWithDependencies(fixture.input, fixture.dependencies).then(() => "settled"),
      new Promise<string>((resolvePromise) => setTimeout(() => resolvePromise("timeout"), 2_000)),
    ]);

    expect(settled).toBe("settled");
    expect(childSignal?.aborted).toBe(true);
  });

  it("uses completion events to bound N children by maxConcurrency", async () => {
    const plan = createPlan([
      task("task-a"),
      task("task-b"),
      task("task-c")
    ], { maxConcurrency: 2 });
    const fixture = createFixture(plan);
    let active = 0;
    let peak = 0;
    const gates = new Map<string, Deferred<void>>();
    fixture.input.adapterFactory = ({ task: assigned }) => ({
      ...passAdapter("gpt-test"),
      async execute(request) {
        active += 1;
        peak = Math.max(peak, active);
        const gate = deferred<void>();
        gates.set(assigned.taskId, gate);
        await gate.promise;
        active -= 1;
        return passedAdapterResult(request);
      }
    });

    const run = runLiveSwarmWithDependencies(fixture.input, fixture.dependencies);
    await vi.waitFor(() => expect(gates.size).toBe(2));
    expect(peak).toBe(2);
    gates.get("task-a")?.resolve(undefined);
    await vi.waitFor(() => expect(gates.has("task-c")).toBe(true));
    gates.get("task-b")?.resolve(undefined);
    gates.get("task-c")?.resolve(undefined);
    const result = await run;

    expect(peak).toBe(2);
    expect(result.record.tasks.every((item) => item.status === "accepted")).toBe(true);
  });

  it("governs uneven concurrent streaming usage under the parent token cap", async () => {
    const base = createPlan([task("task-a"), task("task-b"), task("task-c")], { maxConcurrency: 3 });
    const plan = createSwarmLivePlan({
      ...base,
      parentContract: {
        ...base.parentContract,
        budget: { ...base.parentContract.budget, maxTokens: 600 }
      },
      agents: base.agents.map((agent) => ({
        ...agent,
        contract: {
          ...agent.contract,
          budget: { ...agent.contract.budget, maxTokens: 200 }
        }
      }))
    });
    const fixture = createFixture(plan);
    const observations: Record<string, number> = { "task-a": 230, "task-b": 170, "task-c": 159 };
    const streamedObservations: Record<string, number> = { ...observations, "task-a": 229 };
    const decisions = new Map<string, unknown>();
    const siblingsObserved = deferred<void>();
    let siblingCount = 0;
    fixture.input.adapterFactory = ({ task: assigned }) => ({
      ...passAdapter("gpt-test"),
      async execute(request) {
        if (assigned.taskId !== "task-a") {
          decisions.set(assigned.taskId, request.observedUsageGovernor?.({
            cumulativeUsd: 0.01,
            cumulativeTokens: streamedObservations[assigned.taskId]!,
            turns: 1,
            final: false
          }));
          siblingCount += 1;
          if (siblingCount === 2) siblingsObserved.resolve(undefined);
        } else {
          await siblingsObserved.promise;
          decisions.set(assigned.taskId, request.observedUsageGovernor?.({
            cumulativeUsd: 0.02,
            cumulativeTokens: streamedObservations[assigned.taskId]!,
            turns: 2,
            final: false
          }));
        }
        return {
          ...passedAdapterResult(request),
          usage: {
            actualUsd: assigned.taskId === "task-a" ? 0.02 : 0.01,
            tokensIn: observations[assigned.taskId]!,
            tokensOut: 0,
            provenance: "actual" as const
          }
        };
      }
    });

    const result = await runLiveSwarmWithDependencies(fixture.input, fixture.dependencies);

    expect([...decisions.values()]).toEqual([
      expect.objectContaining({ action: "continue" }),
      expect.objectContaining({ action: "continue" }),
      expect.objectContaining({ action: "continue", grantedTokens: 229 })
    ]);
    expect(result.record.budgetLedger.settledTokens).toBe(559);
    expect(result.record.budgetLedger.leases.every((lease) => lease.status === "settled")).toBe(true);
    expect(result.record.budgetLedger.leases.find((lease) => lease.taskId === "task-a")?.reservedTokens).toBe(230);
  });

  it("admits cumulative usage exactly at the parent token cap", async () => {
    const base = createPlan([task("task-a"), task("task-b"), task("task-c")], { maxConcurrency: 3 });
    const plan = createSwarmLivePlan({
      ...base,
      parentContract: {
        ...base.parentContract,
        budget: { ...base.parentContract.budget, maxTokens: 600 }
      },
      agents: base.agents.map((agent) => ({
        ...agent,
        contract: { ...agent.contract, budget: { ...agent.contract.budget, maxTokens: 200 } }
      }))
    });
    const fixture = createFixture(plan);
    const usage: Record<string, number> = { "task-a": 230, "task-b": 170, "task-c": 200 };
    const siblingsObserved = deferred<void>();
    let siblingCount = 0;
    fixture.input.adapterFactory = ({ task: assigned }) => ({
      ...passAdapter("gpt-test"),
      async execute(request) {
        if (assigned.taskId === "task-a") await siblingsObserved.promise;
        const decision = request.observedUsageGovernor?.({
          cumulativeUsd: 0.01,
          cumulativeTokens: usage[assigned.taskId]!,
          turns: 1,
          final: false
        });
        if (assigned.taskId !== "task-a") {
          siblingCount += 1;
          if (siblingCount === 2) siblingsObserved.resolve(undefined);
        }
        expect(decision?.action).toBe("continue");
        return {
          ...passedAdapterResult(request),
          usage: { actualUsd: 0.01, tokensIn: usage[assigned.taskId]!, tokensOut: 0, provenance: "actual" as const }
        };
      }
    });

    const result = await runLiveSwarmWithDependencies(fixture.input, fixture.dependencies);

    expect(result.record.budgetLedger.settledTokens).toBe(600);
    expect(result.record.budgetLedger.leases.every((lease) => lease.status === "settled")).toBe(true);
    expect(result.record.tasks.every((item) => item.status === "accepted")).toBe(true);
    expect(fixture.live.events.some((event) => event.payload.reason === "lease_overage")).toBe(false);
  });

  it("stops cumulative usage above the parent token cap", async () => {
    const base = createPlan([task("task-a"), task("task-b"), task("task-c")], { maxConcurrency: 3 });
    const plan = createSwarmLivePlan({
      ...base,
      parentContract: {
        ...base.parentContract,
        budget: { ...base.parentContract.budget, maxTokens: 600 }
      },
      agents: base.agents.map((agent) => ({
        ...agent,
        contract: { ...agent.contract, budget: { ...agent.contract.budget, maxTokens: 200 } }
      }))
    });
    const fixture = createFixture(plan);
    const usage: Record<string, number> = { "task-a": 231, "task-b": 170, "task-c": 200 };
    const siblingsObserved = deferred<void>();
    let siblingCount = 0;
    let overCapDecision: unknown;
    fixture.input.adapterFactory = ({ task: assigned }) => ({
      ...passAdapter("gpt-test"),
      async execute(request) {
        if (assigned.taskId === "task-a") await siblingsObserved.promise;
        const decision = request.observedUsageGovernor?.({
          cumulativeUsd: 0.01,
          cumulativeTokens: usage[assigned.taskId]!,
          turns: 1,
          final: false
        });
        if (assigned.taskId !== "task-a") {
          siblingCount += 1;
          if (siblingCount === 2) siblingsObserved.resolve(undefined);
        } else {
          overCapDecision = decision;
        }
        return {
          ...passedAdapterResult(request),
          usage: { actualUsd: 0.01, tokensIn: usage[assigned.taskId]!, tokensOut: 0, provenance: "actual" as const }
        };
      }
    });

    const result = await runLiveSwarmWithDependencies(fixture.input, fixture.dependencies);

    expect(overCapDecision).toEqual(expect.objectContaining({
      action: "terminate",
      reason: "GLOBAL_BUDGET_EXCEEDED"
    }));
    expect(result.outcome.state).not.toBe("verified");
    expect(result.record.budgetLedger.settledTokens).toBe(601);
  });

  it("preserves an explicit child hard token cap below the elastic parent cap", async () => {
    const base = createPlan([task("task-a")]);
    const plan = createSwarmLivePlan({
      ...base,
      agents: base.agents.map((agent) => ({
        ...agent,
        contract: { ...agent.contract, hardMaxTokens: 150 }
      }))
    });
    const fixture = createFixture(plan);
    let decision: unknown;
    fixture.input.adapterFactory = () => ({
      ...failAdapter("gpt-test"),
      async execute(request) {
        decision = request.observedUsageGovernor?.({
          cumulativeUsd: 0.01,
          cumulativeTokens: 151,
          turns: 1,
          final: false
        });
        return failedAdapterResult();
      }
    });

    await runLiveSwarmWithDependencies(fixture.input, fixture.dependencies);

    expect(decision).toEqual(expect.objectContaining({
      action: "terminate",
      reason: "child_hard_cap_exceeded",
      grantedTokens: 100
    }));
  });

  it("stops a completing sibling before candidate admission after the parent is terminal", async () => {
    const writeB = { ...task("task-b"), mutationMode: "write" as const, writeScope: ["src/b.ts"] };
    const writeC = { ...task("task-c"), mutationMode: "write" as const, writeScope: ["src/c.ts"] };
    const fixture = createFixture(createPlan([task("task-a"), writeB, writeC], { maxConcurrency: 3 }));
    const releaseSiblings = deferred<void>();
    const originalAppend = fixture.live.append.bind(fixture.live);
    fixture.live.append = async (event: any, options: { expectedRevision: number }) => {
      const appended = await originalAppend(event, options);
      if (event.type === "CHILD_STOPPED" && event.taskId === "task-a") {
        setTimeout(() => releaseSiblings.resolve(undefined), 0);
      }
      return appended;
    };
    fixture.input.adapterFactory = ({ task: assigned }) => ({
      ...(assigned.taskId === "task-a" ? failAdapter("gpt-test") : passAdapter("gpt-test")),
      async execute(request) {
        if (assigned.taskId === "task-a") return failedAdapterResult();
        await releaseSiblings.promise;
        return passedAdapterResult(request);
      }
    });

    const result = await runLiveSwarmWithDependencies(fixture.input, fixture.dependencies);

    expect(result.outcome.state).toBe("needs_review");
    expect(fixture.dependencies.captureCandidate).not.toHaveBeenCalled();
    expect(fixture.live.events).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "ACTION_BLOCKED", payload: expect.objectContaining({ reason: "identity_mismatch" }) })
    ]));
    for (const taskId of ["task-b", "task-c"]) {
      expect(fixture.live.events).toEqual(expect.arrayContaining([
        expect.objectContaining({
          type: "CHILD_STOPPED",
          taskId,
          payload: expect.objectContaining({ reason: "parent_terminal_not_admitted" })
        })
      ]));
    }
  });

  it("does not release a dependent task until closure, settlement, evidence, and cleanup are durable", async () => {
    const first = { ...task("task-a"), mutationMode: "write" as const, writeScope: ["src/**"] };
    const fixture = createFixture(createPlan([
      first,
      task("task-b", ["task-a"])
    ]));
    const order: string[] = [];
    const cleanupForce = new Map<string, unknown>();
    fixture.dependencies.inventoryCandidatePaths = async () => ["src/a.ts"];
    fixture.dependencies.captureCandidate = async (capture: any) => {
      order.push("admission:task-a");
      expect(capture.swarmRecord.budgetLedger.leases[0]?.status).toBe("settled");
      return { admission: { state: "admitted", reasonCode: "admitted" }, cleanupAuthorized: true };
    };
    fixture.input.adapterFactory = ({ task: assigned }) => ({
      ...passAdapter("gpt-test"),
      async execute(request) {
        order.push(`execute:${assigned.taskId}`);
        return passedAdapterResult(request);
      }
    });
    fixture.evidence.persistChildCompletion = async (completion: any) => {
      order.push(`completion:${completion.taskIds[0]}`);
      fixture.evidence.completions.set(completion.childRunId, completion);
    };
    fixture.evidence.persistProcessClosure = async (closure: any) => {
      order.push(`closure:${closure.childRunId}`);
    };
    fixture.manager.removeWorkspace = async (handle: any, gate: any) => {
      const taskId = handle.record.taskIds[0];
      order.push(`cleanup:${taskId}`);
      cleanupForce.set(taskId, gate.force);
      return cleanupRecord(handle.record.workspaceId);
    };

    await runLiveSwarmWithDependencies(fixture.input, fixture.dependencies);

    expect(order.indexOf("admission:task-a")).toBeGreaterThan(order.findIndex((entry) => entry.startsWith("closure:")));
    expect(order.indexOf("cleanup:task-a")).toBeGreaterThan(order.indexOf("admission:task-a"));
    expect(order.indexOf("completion:task-a")).toBeGreaterThan(order.indexOf("cleanup:task-a"));
    expect(order.indexOf("execute:task-b")).toBeGreaterThan(order.indexOf("completion:task-a"));
    expect(order.indexOf("execute:task-b")).toBeGreaterThan(order.indexOf("cleanup:task-a"));
    expect(cleanupForce.get("task-a")).toBe(true);
    expect(cleanupForce.get("task-b")).toBeUndefined();
    const settledA = fixture.live.events.find((event) => event.type === "CHILD_VERIFIED" && event.taskId === "task-a");
    expect(settledA?.payload).toMatchObject({ leaseState: "settled", processCloseState: "closed" });
  });

  it("records exact overage evidence once and stops fanout", async () => {
    const fixture = createFixture(createPlan([
      task("task-a"),
      task("task-b", ["task-a"])
    ], { childUsd: 0.10, hardMaxUsd: 0.10 }));
    fixture.input.adapterFactory = () => passAdapter("gpt-test", { actualUsd: 0.11 });

    const result = await runLiveSwarmWithDependencies(fixture.input, fixture.dependencies);

    expect(result.outcome.state).not.toBe("verified");
    expect(result.record.tasks.find((item) => item.taskId === "task-b")?.status).toBe("queued");
    const overage = fixture.live.events.filter((event) => event.payload.reason === "lease_overage");
    expect(overage).toHaveLength(1);
    expect(overage[0]?.payload).toMatchObject({ actualUsd: 0.11, reservedUsd: 0.10, leaseState: "overspent" });
    expect(result.record.budgetLedger).toMatchObject({ settledUsd: 0.11, settledTokens: 5 });
    expect(result.record.budgetLedger.leases[0]).toMatchObject({
      status: "overspent",
      actualUsage: { usd: 0.11, tokens: 5 }
    });
  });

  it("retains reported token overage, rejects the child, blocks dependent fanout, and cannot verify the parent", async () => {
    const fixture = createFixture(createPlan([
      task("task-a"),
      task("task-b", ["task-a"])
    ], { hardMaxTokens: 100 }));
    fixture.input.adapterFactory = () => ({
      ...passAdapter("gpt-test"),
      async execute(request) {
        return {
          ...passedAdapterResult(request),
          usage: { actualUsd: 0.01, tokensIn: 70, tokensOut: 40, provenance: "estimated" as const }
        };
      }
    });

    const result = await runLiveSwarmWithDependencies(fixture.input, fixture.dependencies);

    expect(result.outcome.state).not.toBe("verified");
    expect(result.record.tasks.find((item) => item.taskId === "task-a")?.status).toBe("stopped");
    expect(result.record.tasks.find((item) => item.taskId === "task-b")?.status).toBe("queued");
    expect(fixture.live.events.some((event) => event.type === "CHILD_VERIFIED")).toBe(false);
    expect(fixture.live.events.some((event) => event.type === "SWARM_VERIFIED")).toBe(false);

    const overage = fixture.live.events.filter((event) => event.payload.reason === "lease_overage");
    expect(overage).toHaveLength(1);
    expect(overage[0]?.payload).toMatchObject({
      actualTokens: 110,
      reservedTokens: 100,
      leaseState: "overspent"
    });
    expect(result.record.budgetLedger).toMatchObject({ settledTokens: 110 });
    expect(result.record.budgetLedger.leases[0]).toMatchObject({
      status: "overspent",
      actualUsage: { usd: 0.01, tokens: 110 }
    });
  });

  it("atomically settles all concurrent overages, blocks new work, and still seals terminal evidence", async () => {
    const fixture = createFixture(createPlan([
      task("task-a"),
      task("task-b"),
      task("task-c")
    ], { maxConcurrency: 3, hardMaxTokens: 100 }));
    fixture.input.adapterFactory = () => ({
      ...passAdapter("gpt-test"),
      async execute(request) {
        return {
          ...passedAdapterResult(request),
          usage: { actualUsd: 0.01, tokensIn: 108, tokensOut: 10, provenance: "actual" as const }
        };
      }
    });
    const sealTerminal = vi.fn(async () => undefined);

    const result = await runLiveSwarmWithDependencies(fixture.input, {
      ...fixture.dependencies,
      sealTerminal
    });

    expect(["stopped", "needs_review"]).toContain(result.outcome.state);
    expect(result.record.budgetLedger.settledTokens).toBe(354);
    expect(result.record.budgetLedger.leases).toHaveLength(3);
    expect(result.record.budgetLedger.leases.every((lease) => lease.status === "overspent")).toBe(true);
    expect(fixture.live.events.filter((event) => event.payload.reason === "lease_overage")).toHaveLength(3);
    expect(fixture.live.events.some((event) => event.payload.reason === "budget_settlement_failed")).toBe(false);
    expect(sealTerminal).toHaveBeenCalledTimes(1);
  });

  it("keeps the original child failure primary when budget settlement also reports overage", async () => {
    const fixture = createFixture(createPlan([task("task-a")], { hardMaxTokens: 100 }));
    fixture.input.adapterFactory = () => ({
      ...failAdapter("gpt-test"),
      async execute() {
        return {
          ...failedAdapterResult(),
          usage: { actualUsd: 0.01, tokensIn: 105, tokensOut: 5, provenance: "actual" as const }
        };
      }
    });
    const sealTerminal = vi.fn(async () => undefined);

    const result = await runLiveSwarmWithDependencies(fixture.input, {
      ...fixture.dependencies,
      sealTerminal
    });

    expect(result.outcome.reason).not.toMatch(/budget settlement|reserved lease/iu);
    expect(fixture.live.events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "CHILD_STOPPED",
        payload: expect.objectContaining({
          reason: "child_terminal_failure",
          budgetStatus: "exceeded",
          settlementStatus: "failed",
          originalFailureReason: expect.any(String)
        })
      })
    ]));
    expect(sealTerminal).toHaveBeenCalledTimes(1);
  });

  it("reassigns a recoverable failure with a fresh child identity and respects the cap", async () => {
    const plan = createPlan([task("task-a")], { alternateAgent: true, maxReassignments: 1 });
    const fixture = createFixture(plan);
    const childIds: string[] = [];
    fixture.input.adapterFactory = ({ agent, childRunId }) => {
      childIds.push(childRunId);
      return agent.agentId === "agent-a" ? failAdapter("gpt-test") : passAdapter("gpt-test");
    };

    const result = await runLiveSwarmWithDependencies(fixture.input, fixture.dependencies);

    expect(childIds).toHaveLength(2);
    expect(new Set(childIds).size).toBe(2);
    expect(result.record.tasks[0]?.assignedAgentId).toBe("agent-b");
    expect(result.record.tasks[0]?.status).toBe("accepted");
    const reassignment = fixture.live.events.filter((event) => event.type === "TASK_REASSIGNED");
    expect(reassignment).toHaveLength(1);
    expect(reassignment[0]).toMatchObject({
      taskId: "task-a",
      agentId: "agent-b",
      payload: {
        fromAgentId: "agent-a",
        toAgentId: "agent-b",
        reason: "child_terminal_failure",
        fromAttemptId: expect.stringMatching(/^attempt-/),
        toAttemptId: expect.stringMatching(/^attempt-/)
      }
    });
    expect(reassignment[0]?.payload.fromAttemptId).not.toBe(reassignment[0]?.payload.toAttemptId);
    const priorStarted = fixture.live.events.find((event) => event.type === "CHILD_STARTED" && event.childRunId === childIds[0]);
    const priorStopped = fixture.live.events.find((event) => event.type === "CHILD_STOPPED" && event.childRunId === childIds[0]);
    const currentStarted = fixture.live.events.find((event) => event.type === "CHILD_STARTED" && event.childRunId === childIds[1]);
    expect(priorStarted?.payload.attemptId).toBe(reassignment[0]?.payload.fromAttemptId);
    expect(priorStopped?.payload.attemptId).toBe(reassignment[0]?.payload.fromAttemptId);
    expect(currentStarted?.payload.attemptId).toBe(reassignment[0]?.payload.toAttemptId);
  });

  it("persists pre-bound receipt lineage for direct, reassigned, and dependent child attempts", async () => {
    const plan = createPlan([
      task("task-a"),
      task("task-c", ["task-a"])
    ], { alternateAgent: true, maxReassignments: 1 });
    const fixture = createFixture(plan);
    type SwarmLink = NonNullable<NonNullable<LoopRecord["receiptScope"]>["swarmChild"]>;
    const captured = new Map<string, SwarmLink>();

    fixture.input.adapterFactory = ({ agent, childRunId }) => ({
      ...(agent.agentId === "agent-a" ? failAdapter("gpt-test") : passAdapter("gpt-test")),
      async execute(request) {
        const loop = JSON.parse(await readFile(
          join(fixture.input.runsRoot, childRunId, "loop-record.json"),
          "utf8"
        )) as LoopRecord;
        const link = loop.receiptScope?.swarmChild;
        expect(link).toBeDefined();
        expect(link?.attemptId).toBe(loop.metadata["swarm.attemptId"]);
        captured.set(childRunId, link!);
        return agent.agentId === "agent-a" ? failedAdapterResult() : passedAdapterResult(request);
      }
    });

    const result = await runLiveSwarmWithDependencies(fixture.input, fixture.dependencies);

    expect(result.record.tasks.every((item) => item.status === "accepted")).toBe(true);
    expect([...captured.values()]).toEqual([
      expect.objectContaining({
        parentSwarmId: "swarm-live", agentId: "agent-a", taskIds: ["task-a"]
      }),
      expect.objectContaining({
        parentSwarmId: "swarm-live", agentId: "agent-b", taskIds: ["task-a"]
      }),
      expect.objectContaining({
        parentSwarmId: "swarm-live", agentId: "agent-c", taskIds: ["task-c"]
      })
    ]);
    expect(new Set([...captured.values()].map((link) => link.attemptId)).size).toBe(3);
    for (const [childRunId, launchLink] of captured) {
      const finalLoop = JSON.parse(await readFile(
        join(fixture.input.runsRoot, childRunId, "loop-record.json"),
        "utf8"
      )) as LoopRecord;
      expect(finalLoop.receiptScope?.swarmChild).toEqual(launchLink);
      expect(fixture.evidence.completions.get(childRunId)).toMatchObject({
        swarmId: launchLink.parentSwarmId,
        childRunId,
        agentId: launchLink.agentId,
        attemptId: launchLink.attemptId,
        taskIds: launchLink.taskIds,
        receipt: {
          swarmId: launchLink.parentSwarmId,
          childRunId,
          agentId: launchLink.agentId,
          attemptId: launchLink.attemptId,
          taskIds: launchLink.taskIds
        }
      });
    }
  });

  it("closes scheduling before parent cancellation and settles each active attempt once", async () => {
    const fixture = createFixture(createPlan([task("task-a"), task("task-b")], { maxConcurrency: 2 }));
    const abort = new AbortController();
    fixture.input.signal = abort.signal;
    const started = new Set<string>();
    fixture.input.adapterFactory = ({ task: assigned }) => ({
      ...passAdapter("gpt-test"),
      async execute(request) {
        started.add(assigned.taskId);
        if (started.size === 2) abort.abort("operator_cancelled");
        await new Promise<void>((resolve) => {
          if (request.signal?.aborted) resolve();
          else request.signal?.addEventListener("abort", () => resolve(), { once: true });
        });
        return failedAdapterResult();
      }
    });

    const result = await runLiveSwarmWithDependencies(fixture.input, fixture.dependencies);

    expect(started.size).toBe(2);
    expect(result.outcome.state).not.toBe("verified");
    const terminal = fixture.live.events.filter((event) =>
      event.type === "CHILD_STOPPED" || event.type === "CHILD_NEEDS_REVIEW");
    expect(new Set(terminal.map((event) => event.childRunId)).size).toBe(terminal.length);
  });

  it("observes durable cancellation before the next launch and never schedules new children", async () => {
    const fixture = createFixture(createPlan([task("task-a"), task("task-b")], { maxConcurrency: 1 }));
    const started: string[] = [];
    fixture.input.adapterFactory = ({ task: assigned }) => ({
      ...passAdapter("gpt-test"),
      async execute(request) {
        started.push(assigned.taskId);
        if (assigned.taskId === "task-a") {
          await fixture.live.requestCancellation({
            idempotencyKey: "cancel:operator", requestedAt: "2026-10-03T00:00:05.000Z",
            reason: "operator_requested", requestedBy: "test",
          }, { expectedRevision: fixture.live.events.length });
        }
        return passedAdapterResult(request);
      },
    });

    const result = await runLiveSwarmWithDependencies(fixture.input, fixture.dependencies);

    expect(started).toEqual(["task-a"]);
    expect(result.outcome.state).not.toBe("verified");
    expect(fixture.live.events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "SWARM_CANCEL_REQUESTED" }),
      expect.objectContaining({ type: "SWARM_STOPPED" }),
    ]));
  });

  it("releases the lease and closes the prepared workspace when cancellation lands during creation", async () => {
    const fixture = createFixture(createPlan([task("task-a")], { maxConcurrency: 1 }));
    const createWorkspace = fixture.manager.createWorkspace.bind(fixture.manager);
    fixture.manager.createWorkspace = async (spec: any) => {
      const workspace = await createWorkspace(spec);
      await fixture.live.requestCancellation({
        idempotencyKey: "cancel:during-workspace", requestedAt: "2026-10-03T00:00:05.000Z",
        reason: "operator_requested", requestedBy: "test",
      }, { expectedRevision: fixture.live.events.length });
      return workspace;
    };
    const constructAdapter = vi.fn(() => passAdapter("gpt-test"));
    fixture.input.adapterFactory = constructAdapter;

    const result = await runLiveSwarmWithDependencies(fixture.input, fixture.dependencies);

    expect(constructAdapter).not.toHaveBeenCalled();
    expect(result.record.budgetLedger.leases).toEqual([
      expect.objectContaining({ status: "released" }),
    ]);
    expect(fixture.evidence.cleanup).toEqual([
      expect.objectContaining({ state: "completed" }),
    ]);
    expect(fixture.live.events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "CHILD_STOPPED", payload: expect.objectContaining({ reason: "parent_cancelled" }) }),
      expect.objectContaining({ type: "SWARM_STOPPED" }),
    ]));
  });

  it("returns needs_review with the same durable reason when the cancellation monitor fails", async () => {
    const fixture = createFixture(createPlan([task("task-a")], { maxConcurrency: 1 }));
    fixture.live.waitForRevision = async () => {
      throw new Error("operational store monitor failed");
    };

    const result = await runLiveSwarmWithDependencies(fixture.input, fixture.dependencies);
    const terminal = fixture.live.events.find((event) => event.type === "SWARM_NEEDS_REVIEW");

    expect(result.outcome).toMatchObject({ state: "needs_review", reason: "operational store monitor failed" });
    expect(terminal?.payload).toMatchObject({ reason: "operational store monitor failed" });
  });

  it("settles paid usage exactly once when completion races parent cancellation", async () => {
    const fixture = createFixture(createPlan([task("task-a")], { childUsd: 0.50 }));
    const abort = new AbortController();
    fixture.input.signal = abort.signal;
    fixture.input.adapterFactory = () => ({
      ...passAdapter("gpt-test"),
      async execute(request) {
        abort.abort("operator_cancelled");
        return passedAdapterResult(request, 0.25);
      }
    });

    const result = await runLiveSwarmWithDependencies(fixture.input, fixture.dependencies);

    expect(result.outcome.state).not.toBe("verified");
    expect(result.record.budgetLedger.settledUsd).toBe(0.25);
    expect(result.record.budgetLedger.leases[0]).toMatchObject({
      status: "settled",
      actualUsage: { usd: 0.25, tokens: 5 }
    });
    expect(fixture.live.events.filter((event) => (
      event.childRunId === result.record.agents[0]?.childRunId
      && (event.type === "CHILD_STOPPED" || event.type === "CHILD_NEEDS_REVIEW")
    ))).toHaveLength(1);
  });

  it.each([
    ["factory throw", () => { throw new Error("factory exploded"); }],
    ["provider mismatch", () => ({
      ...passAdapter("gpt-test"),
      metadata: { providerId: "claude", model: "gpt-test", capabilities: { workspaceMutations: false } }
    })],
    ["model mismatch", () => passAdapter("wrong-model")]
  ])("terminalizes, releases, and cleans after %s", async (_label, adapterFactory) => {
    const fixture = createFixture(createPlan([task("task-a")]));
    fixture.input.adapterFactory = adapterFactory as never;
    const removed = vi.spyOn(fixture.manager, "removeWorkspace");

    const result = await runLiveSwarmWithDependencies(fixture.input, fixture.dependencies);

    expect(result.outcome.state).toBe("needs_review");
    expect(result.record.budgetLedger.leases[0]?.status).toBe("released");
    expect(removed).toHaveBeenCalledTimes(1);
    expect(fixture.live.events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "CHILD_NEEDS_REVIEW" })
    ]));
  });

  it("terminalizes the prepared lease and workspace when CHILD_STARTED persistence fails", async () => {
    const fixture = createFixture(createPlan([task("task-a")]));
    const execute = vi.fn();
    fixture.input.adapterFactory = () => ({
      ...passAdapter("gpt-test"),
      execute
    });
    const append = fixture.live.append.bind(fixture.live);
    let rejectedStart = false;
    fixture.live.append = async (input: any, options: { expectedRevision: number }) => {
      if (!rejectedStart && input.type === "CHILD_STARTED") {
        rejectedStart = true;
        throw new Error("event store unavailable");
      }
      return append(input, options);
    };
    const removed = vi.spyOn(fixture.manager, "removeWorkspace");

    const result = await runLiveSwarmWithDependencies(fixture.input, fixture.dependencies);

    expect(result.outcome.state).toBe("needs_review");
    expect(result.record.tasks[0]?.status).toBe("needs_review");
    expect(result.record.budgetLedger.leases[0]?.status).toBe("released");
    expect(execute).not.toHaveBeenCalled();
    expect(removed).toHaveBeenCalledTimes(1);
    expect(fixture.evidence.cleanup).toEqual([
      expect.objectContaining({ state: "completed", evidencePersisted: true })
    ]);
  });

  it("settles paid usage and preserves evidence workspace when process-closure persistence fails", async () => {
    const fixture = createFixture(createPlan([task("task-a")], { childUsd: 0.50 }));
    fixture.input.adapterFactory = () => passAdapter("gpt-test", { actualUsd: 0.25 });
    fixture.evidence.persistProcessClosure = async () => {
      throw new Error("closure evidence unavailable");
    };
    const removed = vi.spyOn(fixture.manager, "removeWorkspace");

    const result = await runLiveSwarmWithDependencies(fixture.input, fixture.dependencies);

    expect(result.outcome.state).toBe("needs_review");
    expect(result.record.tasks[0]?.status).toBe("needs_review");
    expect(result.record.budgetLedger).toMatchObject({ settledUsd: 0.25, settledTokens: 5 });
    expect(result.record.budgetLedger.leases[0]).toMatchObject({
      status: "settled",
      actualUsage: { usd: 0.25, tokens: 5 }
    });
    expect(removed).not.toHaveBeenCalled();
    expect(fixture.evidence.cleanup).toEqual([
      expect.objectContaining({
        state: "cleanup_pending",
        removalState: "failed",
        evidencePersisted: false,
        errorCode: "PROCESS_CLOSURE_EVIDENCE_NOT_PERSISTED"
      })
    ]);
    expect(fixture.live.events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "CHILD_NEEDS_REVIEW",
        payload: expect.objectContaining({ reason: "process_closure_evidence_not_persisted" })
      })
    ]));
  });

  it("preserves a prepared workspace when launch-failure closure evidence cannot persist", async () => {
    const fixture = createFixture(createPlan([task("task-a")]));
    fixture.input.adapterFactory = () => {
      throw new Error("factory exploded");
    };
    fixture.evidence.persistProcessClosure = async () => {
      throw new Error("closure evidence unavailable");
    };
    const removed = vi.spyOn(fixture.manager, "removeWorkspace");

    const result = await runLiveSwarmWithDependencies(fixture.input, fixture.dependencies);

    expect(result.outcome.state).toBe("needs_review");
    expect(result.record.budgetLedger.leases[0]?.status).toBe("released");
    expect(removed).not.toHaveBeenCalled();
    expect(fixture.evidence.cleanup).toEqual([
      expect.objectContaining({
        state: "cleanup_pending",
        removalState: "failed",
        evidencePersisted: false,
        errorCode: "PROCESS_CLOSURE_EVIDENCE_NOT_PERSISTED"
      })
    ]);
  });

  it("closes, releases, and cleans a child whose concrete adapter crashes", async () => {
    const fixture = createFixture(createPlan([task("task-a")], { childMaxIterations: 2 }));
    fixture.input.adapterFactory = () => ({
      ...passAdapter("gpt-test"),
      async execute() { throw new Error("provider process crashed"); }
    });

    const result = await runLiveSwarmWithDependencies(fixture.input, fixture.dependencies);

    expect(result.outcome.state).toBe("needs_review");
    expect(result.outcome.reason).toBe("provider process crashed");
    expect(result.record.tasks[0]?.status).toBe("needs_review");
    expect(result.record.budgetLedger.leases[0]?.status).toBe("released");
    expect(fixture.live.events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "CHILD_NEEDS_REVIEW", payload: expect.objectContaining({ reason: "child_crash" }) })
    ]));
  });

  it("keeps a rejected write candidate out of parent integration", async () => {
    const writeTask = { ...task("task-a"), mutationMode: "write" as const, writeScope: ["src/a.ts"] };
    const fixture = createFixture(createPlan([writeTask]));
    fixture.dependencies.inventoryCandidatePaths = async () => ["src/a.ts"];
    fixture.dependencies.captureCandidate = async () => ({
      admission: { state: "rejected", reasonCode: "candidate_conflict" },
      cleanupAuthorized: false
    });

    const result = await runLiveSwarmWithDependencies(fixture.input, fixture.dependencies);

    expect(result.outcome.state).toBe("needs_review");
    expect(result.candidateIds).toEqual([]);
    expect(fixture.live.events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "ACTION_BLOCKED",
        taskId: "task-a",
        agentId: "agent-a",
        payload: expect.objectContaining({
          attemptId: expect.stringMatching(/^attempt-/),
          action: "candidate_admission",
          reason: "candidate_conflict"
        })
      })
    ]));
    expect(result.record.tasks[0]?.status).toBe("needs_review");
    expect(fixture.live.events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "CHILD_NEEDS_REVIEW", payload: expect.objectContaining({ reason: "candidate_conflict" }) })
    ]));
  });

  it("cleans an evidence-backed rejected candidate when cleanup is authorized", async () => {
    const writeTask = { ...task("task-a"), mutationMode: "write" as const, writeScope: ["src/**"] };
    const fixture = createFixture(createPlan([writeTask]));
    fixture.dependencies.inventoryCandidatePaths = async () => ["src/a.ts"];
    fixture.dependencies.captureCandidate = async () => ({
      admission: { state: "rejected", reasonCode: "candidate_conflict" },
      cleanupAuthorized: true
    });
    const removed = vi.spyOn(fixture.manager, "removeWorkspace");

    const result = await runLiveSwarmWithDependencies(fixture.input, fixture.dependencies);

    expect(result.outcome.state).toBe("needs_review");
    expect(removed).toHaveBeenCalledTimes(1);
    expect(removed.mock.calls[0]?.[1]).toEqual({ evidencePersisted: true, processTreeClosed: true });
    expect(fixture.evidence.cleanup).toHaveLength(1);
  });

  it("binds write receipt identity before execution and declares only concrete Git paths", async () => {
    const writeTask = { ...task("task-a"), mutationMode: "write" as const, writeScope: ["src/**"] };
    const fixture = createFixture(createPlan([writeTask]));
    fixture.dependencies.inventoryCandidatePaths = async () => ["src/a.ts"];
    fixture.dependencies.captureCandidate = vi.fn(async (capture: any) => {
      const loop = JSON.parse(await readFile(capture.loopRecordPath, "utf8"));
      expect(capture.declaredPaths).toEqual(["src/a.ts"]);
      expect(loop.metadata).toMatchObject({
        "swarm.parentId": capture.swarmId,
        "swarm.agentId": capture.agentId,
        "swarm.attemptId": capture.attemptId,
        "swarm.proposalId": capture.proposalId,
        "swarm.baselineCommit": capture.expectedBaselineCommit,
        "swarm.taskIds": JSON.stringify(capture.taskIds)
      });
      return {
        admission: { state: "admitted", reasonCode: "admitted" },
        cleanupAuthorized: true
      };
    });

    const result = await runLiveSwarmWithDependencies(fixture.input, fixture.dependencies);

    expect(result.record.tasks[0]?.status).toBe("accepted");
    expect(fixture.dependencies.captureCandidate).toHaveBeenCalledTimes(1);
  });

  it("fails closed on an unverified read-only receipt before dependency release", async () => {
    const fixture = createFixture(createPlan([
      task("task-a"),
      task("task-b", ["task-a"])
    ]));
    fixture.evidence.persistProcessClosure = async (closure: any) => {
      await appendFile(join(fixture.input.runsRoot, closure.childRunId, "ledger.jsonl"), "{\"tampered\":true}\n", "utf8");
    };

    const result = await runLiveSwarmWithDependencies(fixture.input, fixture.dependencies);

    expect(result.outcome.state).toBe("needs_review");
    expect(result.record.tasks.find((item) => item.taskId === "task-a")?.status).toBe("needs_review");
    expect(result.record.tasks.find((item) => item.taskId === "task-b")?.status).toBe("queued");
    expect(fixture.live.events.some((event) => event.type === "CHILD_VERIFIED")).toBe(false);
  });

  it("turns cleanup exceptions into durable cleanup_pending review evidence", async () => {
    const fixture = createFixture(createPlan([task("task-a")]));
    fixture.manager.removeWorkspace = async () => {
      throw Object.assign(new Error("workspace busy"), { code: "EBUSY" });
    };

    const result = await runLiveSwarmWithDependencies(fixture.input, fixture.dependencies);

    expect(result.outcome.state).toBe("needs_review");
    expect(fixture.evidence.cleanup).toEqual([
      expect.objectContaining({ state: "cleanup_pending", removalState: "failed", errorCode: "EBUSY" })
    ]);
    expect(fixture.live.events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "CHILD_NEEDS_REVIEW", payload: expect.objectContaining({ reason: "cleanup_pending" }) })
    ]));
  });

  it("fails closed when cleanup evidence persistence throws", async () => {
    const fixture = createFixture(createPlan([task("task-a")]));
    fixture.evidence.persistCleanupEvidence = async () => {
      throw new Error("evidence store unavailable");
    };

    const result = await runLiveSwarmWithDependencies(fixture.input, fixture.dependencies);

    expect(result.outcome.state).toBe("needs_review");
    expect(result.record.tasks[0]?.status).toBe("needs_review");
    expect(fixture.live.events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "CHILD_NEEDS_REVIEW", payload: expect.objectContaining({ reason: "cleanup_pending" }) })
    ]));
  });

  it("preserves child failureClass when materializing the parent record", async () => {
    const fixture = createFixture(createPlan([task("task-a")], { childUsd: 0.10, hardMaxUsd: 0.10 }));
    fixture.input.adapterFactory = () => passAdapter("gpt-test", { actualUsd: 0.11 });

    const result = await runLiveSwarmWithDependencies(fixture.input, fixture.dependencies);

    const liveFailureClass = fixture.live.events.find((event) => event.type === "CHILD_STOPPED")?.failureClass;
    expect(liveFailureClass).toBe("budget_pressure");
    expect(result.record.events.find((event) => event.type === "CHILD_STOPPED")?.payload.failureClass)
      .toBe(liveFailureClass);
  });

  it("rejects a structurally forged verified parent result and does not persist it", async () => {
    const fixture = createFixture(createPlan([task("task-a")]));
    fixture.dependencies.parentPipeline = async ({ record }: { record: SwarmRunRecord }) => {
      const verified: SwarmEvent = {
        type: "SWARM_VERIFIED",
        swarmId: record.swarmId,
        timestamp: "2026-10-03T00:01:00.000Z",
        parentPolicyVersion: record.parentContract.policyVersion,
        payload: {}
      };
      const forged = { ...record, events: [...record.events, verified], outcome: { state: "verified" as const, reason: "forged" } };
      return {
        record: forged,
        outcome: forged.outcome,
        disposition: "ready",
        blockingInvariants: [],
        integration: { completed: true, finalTreeHash: "a".repeat(40), admittedCandidateIds: [] },
        cleanup: []
      };
    };

    const result = await runLiveSwarmWithDependencies(fixture.input, fixture.dependencies);

    expect(result.outcome.state).toBe("needs_review");
    expect(fixture.live.events.some((event) => event.type === "SWARM_VERIFIED")).toBe(false);
  });

  it("preserves cleanup_pending evidence and never releases dependent work", async () => {
    const fixture = createFixture(createPlan([
      task("task-a"),
      task("task-b", ["task-a"])
    ]));
    fixture.manager.removeWorkspace = async (handle: any) => ({
      ...cleanupRecord(handle.record.workspaceId),
      state: "cleanup_pending",
      removalState: "cleanup_pending",
      completedAt: undefined,
      errorCode: "EBUSY"
    });

    const result = await runLiveSwarmWithDependencies(fixture.input, fixture.dependencies);

    expect(result.outcome.state).toBe("needs_review");
    expect(result.record.tasks.find((item) => item.taskId === "task-a")?.status).toBe("needs_review");
    expect(result.record.tasks.find((item) => item.taskId === "task-b")?.status).toBe("queued");
    expect(fixture.live.events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "CHILD_NEEDS_REVIEW", payload: expect.objectContaining({ reason: "cleanup_pending" }) })
    ]));
  });

  it("centralizes cleanup-pending terminalization before the one sealing call", async () => {
    const fixture = createFixture(createPlan([
      task("task-a"),
      task("task-b", ["task-a"])
    ]));
    fixture.manager.removeWorkspace = async (handle: any) => ({
      ...cleanupRecord(handle.record.workspaceId),
      state: "cleanup_pending",
      removalState: "cleanup_pending",
      completedAt: undefined,
      errorCode: "EBUSY"
    });
    const sealTerminal = vi.fn(async () => undefined);

    const result = await runLiveSwarmWithDependencies(fixture.input, {
      ...fixture.dependencies,
      sealTerminal
    });

    expect(result.outcome.state).toBe("needs_review");
    expect(fixture.live.events.filter((event) => (
      event.type === "SWARM_STOPPED" || event.type === "SWARM_NEEDS_REVIEW" || event.type === "SWARM_VERIFIED"
    ))).toHaveLength(1);
    expect(sealTerminal).toHaveBeenCalledTimes(1);
    expect(sealTerminal.mock.invocationCallOrder[0]).toBeGreaterThan(0);
  });

  it("seals budget denial after exactly one stopped parent event", async () => {
    const fixture = createFixture(createPlan([
      task("task-a"),
      task("task-b")
    ], { maxConcurrency: 2, childUsd: 6 }));
    const sealTerminal = vi.fn(async () => undefined);

    const result = await runLiveSwarmWithDependencies(fixture.input, {
      ...fixture.dependencies,
      sealTerminal
    });

    expect(result.outcome.state).toBe("stopped");
    expect(fixture.live.events.filter((event) => event.type === "SWARM_STOPPED")).toHaveLength(1);
    expect(sealTerminal).toHaveBeenCalledTimes(1);
  });

  it("seals failed global-verifier truth without synthesizing VERIFIED", async () => {
    const fixture = createFixture(createPlan([task("task-a")]));
    fixture.dependencies.parentPipeline = async ({ record }: { record: SwarmRunRecord }) => ({
      record: { ...record, outcome: { state: "stopped", reason: "global verifier failed" } },
      outcome: { state: "stopped", reason: "global verifier failed" },
      disposition: "stopped",
      blockingInvariants: ["globalVerifier"],
      integration: { completed: true, finalTreeHash: "a".repeat(40), admittedCandidateIds: [] },
      cleanup: []
    });
    const sealTerminal = vi.fn(async () => undefined);

    const result = await runLiveSwarmWithDependencies(fixture.input, {
      ...fixture.dependencies,
      sealTerminal
    });

    expect(result.outcome.state).toBe("needs_review");
    expect(fixture.live.events.filter((event) => event.type === "SWARM_NEEDS_REVIEW")).toHaveLength(1);
    expect(fixture.live.events.some((event) => event.type === "SWARM_VERIFIED")).toBe(false);
    expect(sealTerminal).toHaveBeenCalledTimes(1);
  });

  it.each(["index", "receipt-stage", "receipt-publish", "key", "sign", "integrity-publish"])(
    "downgrades a verified return when %s sealing fails without a second terminal event",
    async (stage) => {
      const fixture = createFixture(createPlan([task("task-a")]));
      (fixture.live as any).persistParentOutcome = async (parent: any) => {
        const verified = parent.record.events.find((event: SwarmEvent) => event.type === "SWARM_VERIFIED");
        fixture.live.events.push({
          schemaVersion: "martin.swarm.v1",
          sequence: fixture.live.events.length + 1,
          idempotencyKey: `verified-${stage}`,
          type: "SWARM_VERIFIED",
          swarmId: fixture.input.plan.swarmId,
          timestamp: verified.timestamp,
          parentPolicyVersion: fixture.input.plan.parentContract.policyVersion,
          planHash: fixture.input.plan.planHash,
          payload: {
            ...verified.payload,
            parentPipelineAuthority: "runParentSwarmPipeline:v1",
            parentPipelineResultSha256: "a".repeat(64)
          }
        });
      };

      const result = await runLiveSwarmWithDependencies(fixture.input, {
        ...fixture.dependencies,
        sealTerminal: vi.fn(async () => { throw new Error(`${stage} failed`); })
      });

      expect(result.outcome).toMatchObject({ state: "needs_review", reason: "terminal_evidence_sealing_failed" });
      expect(fixture.live.events.filter((event) => (
        event.type === "SWARM_STOPPED" || event.type === "SWARM_NEEDS_REVIEW" || event.type === "SWARM_VERIFIED"
      ))).toHaveLength(1);
      expect(fixture.live.events.filter((event) => event.type === "SWARM_VERIFIED")).toHaveLength(1);
      expect(isAuthoritativeLiveSwarmVerified(result)).toBe(false);
    }
  );

  it("preserves an original stopped cause when terminal sealing has a secondary failure", async () => {
    const fixture = createFixture(createPlan([task("task-a")]));
    fixture.input.adapterFactory = () => failAdapter("gpt-test");

    const result = await runLiveSwarmWithDependencies(fixture.input, {
      ...fixture.dependencies,
      sealTerminal: vi.fn(async () => { throw new Error("seal unavailable"); })
    });

    expect(["stopped", "needs_review"]).toContain(result.outcome.state);
    expect(result.outcome.reason).not.toBe("terminal_evidence_sealing_failed");
    expect(fixture.live.events.filter((event) => (
      event.type === "SWARM_STOPPED" || event.type === "SWARM_NEEDS_REVIEW" || event.type === "SWARM_VERIFIED"
    ))).toHaveLength(1);
  });

  it("never treats a child VERIFIED claim or a failed global pipeline as final authority", async () => {
    const fixture = createFixture(createPlan([task("task-a")]));
    fixture.input.adapterFactory = () => ({
      ...passAdapter("gpt-test"),
      async execute(request) {
        return { ...passedAdapterResult(request), summary: "SWARM_VERIFIED" };
      }
    });
    fixture.dependencies.parentPipeline = async (input: any) => ({
      record: { ...input.record, outcome: { state: "stopped", reason: "global verifier failed" } },
      outcome: { state: "stopped", reason: "global verifier failed" },
      disposition: "stopped",
      blockingInvariants: ["globalVerifier"],
      integration: { completed: true, finalTreeHash: "a".repeat(40), admittedCandidateIds: [] },
      cleanup: []
    });

    const result = await runLiveSwarmWithDependencies(fixture.input, fixture.dependencies);

    expect(result.outcome.state).toBe("needs_review");
    expect(result.record.events.some((event) => event.type === "SWARM_VERIFIED")).toBe(false);
    expect(fixture.live.events.some((event) => event.type === "SWARM_VERIFIED")).toBe(false);
  });

  it("keeps the live-run implementation out of the public Core root", async () => {
    const publicCore = await import("../src/index");
    expect(publicCore).not.toHaveProperty("runLiveSwarm");
    expect(publicCore).not.toHaveProperty("runProductionLiveSwarm");
    expect(publicCore).toHaveProperty("readSwarmReceiptProjection", readSwarmReceiptProjection);
    expect(publicCore).toHaveProperty("verifySwarmReceiptProjection", verifySwarmReceiptProjection);
    expect(publicCore).not.toHaveProperty("runLiveSwarmWithDependencies");
    expect(publicCore).not.toHaveProperty("createSwarmLiveStore");
    expect(publicCore).not.toHaveProperty("createSwarmWorkspaceManager");
    expect(publicCore).not.toHaveProperty("buildParentSwarmReceipt");
    expect(publicCore).not.toHaveProperty("writeSwarmReceiptIntegrityMaterial");
  });

  it("production composition constructs durable Core authority internally and never synthesizes parent verification", async () => {
    const canonicalRoot = join(scratchRoot, "production-repo");
    await mkdir(canonicalRoot, { recursive: true });
    await git(canonicalRoot, ["init"]);
    await git(canonicalRoot, ["config", "user.email", "swarm-test@example.invalid"]);
    await git(canonicalRoot, ["config", "user.name", "Swarm Test"]);
    await writeFile(join(canonicalRoot, "README.md"), "production composition\n", "utf8");
    await git(canonicalRoot, ["add", "README.md"]);
    await git(canonicalRoot, ["commit", "-m", "fixture"]);
    const baselineCommit = (await git(canonicalRoot, ["rev-parse", "HEAD"])).trim();
    const original = createPlan([task("task-a")]);
    const plan = createSwarmLivePlan({
      ...original,
      planId: "plan-production",
      swarmId: "swarm-production",
      baselineCommit,
    });
    const seen: string[] = [];
    const productionRunsRoot = join(scratchRoot, "production-runs");
    await mkdir(productionRunsRoot, { recursive: true });

    const result = await runProductionLiveSwarm({
      plan,
      canonicalRoot,
      ownedRoot: join(productionRunsRoot, "_swarms", plan.swarmId, "worktrees"),
      storeRoot: productionRunsRoot,
      runsRoot: productionRunsRoot,
      adapterFactory(input) {
        seen.push(input.workspace.path);
        return passAdapter(plan.engine.model);
      },
      verifierExecutor: {
        async execute(request) {
          return {
            passed: true,
            processCloseState: "closed",
            binding: {
              swarmId: request.swarmId,
              workspaceId: request.workspaceId,
              cwd: request.cwd,
              parentPolicyVersion: request.parentPolicyVersion,
              baselineCommit: request.baselineCommit,
              integratedTreeHash: request.integratedTreeHash,
              commands: request.commands.map((step) => step.command),
            },
            subprocessResults: request.commands.map((step) => ({
              command: step.command,
              launched: true,
              completed: true,
              timedOut: false,
              exitCode: 0,
              startedAt: "2026-10-03T00:00:00.000Z",
              completedAt: "2026-10-03T00:00:01.000Z",
            })),
          };
        },
      },
    });

    expect(seen).toHaveLength(1);
    expect(seen[0]).not.toBe(canonicalRoot);
    if (result.outcome.state === "verified") {
      expect(result.parent?.outcome.state).toBe("verified");
    } else {
      expect(result.outcome.state).toBe("needs_review");
      expect(result.parent?.blockingInvariants).toContain("globalVerifier");
    }
    expect(JSON.parse(await readFile(
      join(productionRunsRoot, "_swarms", plan.swarmId, "plan.json"),
      "utf8",
    ))).toMatchObject({ planHash: plan.planHash });
    await expect(access(join(
      productionRunsRoot,
      "_swarms",
      plan.swarmId,
      "evidence",
    ))).resolves.toBeUndefined();
    const projection = await readSwarmReceiptProjection({ runsRoot: productionRunsRoot, swarmId: plan.swarmId });
    expect(projection.receipt.parentOutcome.state).toBe(result.outcome.state);
    expect(projection.integrity.state).toBe("verified");
    expect(projection.seal).toMatchObject({ commitHmacSha256: expect.stringMatching(/^[a-f0-9]{64}$/u) });
    const sealPath = join(productionRunsRoot, "_swarms", plan.swarmId, "evidence", "swarm-receipt-seal.json");
    const originalSeal = await readFile(sealPath, "utf8");
    const forgedSeal = JSON.parse(originalSeal);
    delete forgedSeal.commitHmacSha256;
    await writeFile(sealPath, `${JSON.stringify(forgedSeal, null, 2)}\n`, "utf8");
    await expect(readSwarmReceiptProjection({ runsRoot: productionRunsRoot, swarmId: plan.swarmId }))
      .rejects.toMatchObject({ code: "SWARM_SEAL_COMMIT_MISMATCH" });
    await writeFile(sealPath, originalSeal, "utf8");
    expect(await verifySwarmReceiptProjection({ runsRoot: productionRunsRoot, swarmId: plan.swarmId }))
      .toMatchObject({ state: "verified" });
    await expect(runProductionLiveSwarm({
      plan,
      canonicalRoot,
      ownedRoot: join(productionRunsRoot, "_swarms", plan.swarmId, "worktrees"),
      storeRoot: productionRunsRoot,
      runsRoot: productionRunsRoot,
      adapterFactory(input) {
        seen.push(input.workspace.path);
        return passAdapter(plan.engine.model);
      },
      verifierExecutor: { execute: vi.fn() } as any,
    })).rejects.toThrow(/already started|replay/iu);
    expect(seen).toHaveLength(1);
  }, 60_000);

  it("keeps the production evidence store write-once or byte-identical", async () => {
    const source = await readFile(new URL("../src/swarm/live-runtime.ts", import.meta.url), "utf8");
    expect(source).toContain("writeExclusiveIdempotent");
    expect(source).not.toContain("await rename(temporary, path)");
  });

  it("seals a production pre-launch policy failure as committed needs_review truth", async () => {
    const fixture = await createProductionFixture("seal-needs-review");
    const result = await runProductionLiveSwarm(productionInput(fixture, () => ({
      ...passAdapter(fixture.plan.engine.model),
      metadata: {
        providerId: "claude",
        model: fixture.plan.engine.model,
        capabilities: { workspaceMutations: false }
      }
    })));

    expect(result.outcome.state).toBe("needs_review");
    const projection = await readSwarmReceiptProjection({ runsRoot: fixture.runsRoot, swarmId: fixture.plan.swarmId });
    expect(projection.receipt.parentOutcome.state).toBe("needs_review");
    expect(projection.receipt.blockedActions).toEqual([
      expect.objectContaining({ action: "child_launch", taskId: "task-a", agentId: "agent-a" })
    ]);
    expect(projection.integrity.state).toBe("verified");
    const events = (await readFile(
      join(fixture.runsRoot, "_swarms", fixture.plan.swarmId, "events.jsonl"),
      "utf8"
    )).trim().split("\n").map((line) => JSON.parse(line) as SwarmLiveEvent);
    expect(events.filter((event) => (
      event.type === "SWARM_STOPPED" || event.type === "SWARM_NEEDS_REVIEW" || event.type === "SWARM_VERIFIED"
    ))).toHaveLength(1);
  }, 60_000);

  it("seals production budget denial as committed stopped truth", async () => {
    const fixture = await createProductionFixture("seal-stopped");
    const draft = createPlan([task("task-a"), task("task-b")], { maxConcurrency: 2, childUsd: 6 });
    fixture.plan = createSwarmLivePlan({
      ...draft,
      planId: "plan-seal-stopped",
      swarmId: "swarm-seal-stopped",
      baselineCommit: fixture.plan.baselineCommit
    });
    const result = await runProductionLiveSwarm(productionInput(
      fixture,
      ({ engine }) => passAdapter(engine.model)
    ));

    expect(result.outcome.state).toBe("stopped");
    const projection = await readSwarmReceiptProjection({ runsRoot: fixture.runsRoot, swarmId: fixture.plan.swarmId });
    expect(projection.receipt.parentOutcome.state).toBe("stopped");
    expect(projection.receipt.blockedActions).toEqual([
      expect.objectContaining({ action: "budget_reservation", taskId: "task-b", agentId: "agent-b" })
    ]);
    expect(projection.integrity.state).toBe("verified");
  }, 60_000);

  it("seals production global-verifier failure with verified integrity and failed task truth", async () => {
    const fixture = await createProductionFixture("seal-verifier-failed");
    const input = productionInput(fixture, ({ engine }) => passAdapter(engine.model));
    input.verifierExecutor = {
      async execute(request: any) {
        return {
          passed: false,
          processCloseState: "closed",
          binding: {
            swarmId: request.swarmId,
            workspaceId: request.workspaceId,
            cwd: request.cwd,
            parentPolicyVersion: request.parentPolicyVersion,
            baselineCommit: request.baselineCommit,
            integratedTreeHash: request.integratedTreeHash,
            commands: request.commands.map((step: any) => step.command)
          },
          subprocessResults: request.commands.map((step: any) => ({
            command: step.command,
            launched: true,
            completed: true,
            timedOut: false,
            exitCode: 1,
            startedAt: "2026-10-03T00:00:00.000Z",
            completedAt: "2026-10-03T00:00:01.000Z"
          }))
        };
      }
    } as any;

    const result = await runProductionLiveSwarm(input);
    expect(result.outcome.state).toBe("needs_review");
    const projection = await readSwarmReceiptProjection({ runsRoot: fixture.runsRoot, swarmId: fixture.plan.swarmId });
    expect(projection.receipt.taskVerificationState).toBe("failed");
    expect(projection.integrity).toMatchObject({ state: "verified", taskVerificationState: "failed" });
  }, 60_000);

  it("keeps VERIFIED hidden after restart when receipt sealing fails", async () => {
    const fixture = await createProductionFixture("seal-restart-failure");
    const store = await createSwarmLiveStore({ rootDir: fixture.runsRoot, plan: fixture.plan });
    await store.append({
      idempotencyKey: "parent:terminal-before-seal",
      type: "SWARM_STOPPED",
      timestamp: "2026-10-03T00:00:01.000Z",
      payload: { reason: "temporary" }
    }, { expectedRevision: 0 });
    const paths = store.paths();
    const event = {
      ...(await store.readEvents())[0]!,
      type: "SWARM_VERIFIED" as const,
      payload: {
        reason: "verified",
        parentPipelineAuthority: "runParentSwarmPipeline:v1",
        parentPipelineResultSha256: "a".repeat(64)
      }
    };
    const snapshot = {
      ...(await store.readSnapshot()),
      lastEventType: "SWARM_VERIFIED" as const,
      outcome: { state: "verified" as const, reason: "verified", verifiedAt: event.timestamp }
    };
    await writeFile(join(paths.eventClaims, "000000000001.json"), `${JSON.stringify(event)}\n`, "utf8");
    await writeFile(paths.events, `${JSON.stringify(event)}\n`, "utf8");
    await writeFile(paths.snapshot, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
    const restarted = await readSwarmOperationalState({ runsRoot: fixture.runsRoot, swarmId: fixture.plan.swarmId });
    const terminalEvents = restarted.events.filter((event) => (
      event.type === "SWARM_STOPPED" || event.type === "SWARM_NEEDS_REVIEW" || event.type === "SWARM_VERIFIED"
    ));

    expect(restarted.snapshot.outcome).toMatchObject({ state: "needs_review" });
    expect(terminalEvents).toEqual([expect.objectContaining({ type: "SWARM_VERIFIED" })]);
    await expect(readSwarmReceiptProjection({ runsRoot: fixture.runsRoot, swarmId: fixture.plan.swarmId })).rejects.toBeDefined();
  }, 60_000);

  it("admits a production WRITE candidate when parent and child scopes repeat the same denied path", async () => {
    const fixture = await createProductionFixture("overlapping-denials");
    const writeTask = {
      ...fixture.plan.tasks[0]!,
      mutationMode: "write" as const,
      writeScope: ["README.md"],
    };
    const plan = createSwarmLivePlan({
      ...fixture.plan,
      parentContract: {
        ...fixture.plan.parentContract,
        scope: { allowedPaths: ["README.md"], deniedPaths: [".git/**"] },
      },
      tasks: [writeTask],
      agents: fixture.plan.agents.map((agent) => ({
        ...agent,
        contract: {
          ...agent.contract,
          scope: { allowedPaths: ["README.md"], deniedPaths: [".git/**"] },
        },
      })),
    });

    const input = {
      ...productionInput({ ...fixture, plan }, ({ engine, workspace }) => ({
        ...passAdapter(engine.model),
        metadata: {
          providerId: "codex",
          model: engine.model,
          capabilities: { workspaceMutations: true },
        },
        async execute(request) {
          await writeFile(join(workspace.path, "README.md"), "production write candidate\n", "utf8");
          return {
            ...passedAdapterResult(request),
            execution: { changedFiles: ["README.md"] },
          };
        },
      })),
      verifierExecutor: {
        async execute(request: any) {
          return {
            passed: true,
            processCloseState: "closed" as const,
            binding: {
              swarmId: request.swarmId,
              workspaceId: request.workspaceId,
              cwd: request.cwd,
              parentPolicyVersion: request.parentPolicyVersion,
              baselineCommit: request.baselineCommit,
              integratedTreeHash: request.integratedTreeHash,
              commands: request.commands.map((step: any) => step.command),
            },
            subprocessResults: request.commands.map((step: any) => ({
              command: step.command,
              launched: true,
              completed: true,
              timedOut: false,
              exitCode: 0,
              startedAt: "2026-10-03T00:00:00.000Z",
              completedAt: "2026-10-03T00:00:01.000Z",
            })),
          };
        },
      },
    };
    const result = await runProductionLiveSwarm(input);

    expect(result.outcome.state).toBe("verified");
    expect(result.record.events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "CHILD_PATCH_ADMITTED" }),
      expect.objectContaining({ type: "SWARM_VERIFIED" }),
    ]));
    const operational = await readSwarmOperationalState({ runsRoot: fixture.runsRoot, swarmId: plan.swarmId });
    expect(operational.events).toEqual(expect.arrayContaining([expect.objectContaining({ type: "SWARM_VERIFIED" })]));
    const admitted = result.record.events.find((event) => event.type === "CHILD_PATCH_ADMITTED");
    const candidateId = String(admitted?.payload.candidateId ?? "");
    expect(candidateId).not.toBe("");
    const evidenceRoot = join(fixture.runsRoot, "_swarms", plan.swarmId, "evidence");
    const evidenceFileName = `${createHash("sha256").update(candidateId).digest("hex")}.json`;
    const decisionPath = join(evidenceRoot, "decisions", evidenceFileName);
    const outcomePath = join(evidenceRoot, "integration-outcomes", evidenceFileName);
    const decisionBytes = await readFile(decisionPath, "utf8");
    const outcomeBytes = await readFile(outcomePath, "utf8");
    expect(JSON.parse(decisionBytes)).toMatchObject({ candidateId, state: "admitted", reasonCode: "admitted" });
    expect(JSON.parse(outcomeBytes)).toMatchObject({
      decision: { candidateId, state: "admitted", reasonCode: "admitted" },
      event: { type: "CHILD_PATCH_ADMITTED", payload: { candidateId } },
    });
    expect(outcomeBytes).not.toBe(decisionBytes);

    await expect(runProductionLiveSwarm(input)).rejects.toMatchObject({ code: "LIVE_SWARM_ALREADY_STARTED" });
    await expect(readFile(decisionPath, "utf8")).resolves.toBe(decisionBytes);
    await expect(readFile(outcomePath, "utf8")).resolves.toBe(outcomeBytes);
  }, 60_000);

  it("runs three concurrent declared writes in isolated production worktrees without cross-contamination", async () => {
    const fixture = await createProductionFixture("three-declared-writes");
    const files = ["src/a.txt", "src/b.txt", "src/c.txt"];
    await mkdir(join(fixture.canonicalRoot, "src"), { recursive: true });
    for (const file of files) await writeFile(join(fixture.canonicalRoot, file), "baseline\n", "utf8");
    await git(fixture.canonicalRoot, ["add", "src"]);
    await git(fixture.canonicalRoot, ["commit", "-m", "seed declared files"]);
    const baselineCommit = (await git(fixture.canonicalRoot, ["rev-parse", "HEAD"])).trim();
    const tasks = files.map((file, index) => ({
      ...task(`task-${String.fromCharCode(97 + index)}`),
      mutationMode: "write" as const,
      writeScope: [file]
    }));
    const draft = createPlan(tasks, { maxConcurrency: 3 });
    fixture.plan = createSwarmLivePlan({
      ...draft,
      planId: "plan-three-declared-writes",
      swarmId: "swarm-three-declared-writes",
      baselineCommit,
      parentContract: {
        ...draft.parentContract,
        maxConcurrency: 3,
        scope: { allowedPaths: ["src/**"], deniedPaths: [".git/**"] }
      },
      agents: draft.agents.map((agent, index) => ({
        ...agent,
        contract: {
          ...agent.contract,
          scope: { allowedPaths: [files[index]!], deniedPaths: [".git/**"] }
        }
      }))
    });
    const workspacePaths = new Map<string, string>();
    const input = productionInput(fixture, ({ engine, task: assigned, workspace }) => ({
      ...passAdapter(engine.model),
      metadata: { providerId: "codex", model: engine.model, capabilities: { workspaceMutations: true } },
      async execute(request) {
        const file = assigned.writeScope[0]!;
        workspacePaths.set(assigned.taskId, workspace.path);
        await mkdir(join(workspace.path, "src"), { recursive: true });
        await writeFile(join(workspace.path, file), `${assigned.taskId}\n`, "utf8");
        for (const other of files.filter((candidate) => candidate !== file)) {
          expect((await readFile(join(workspace.path, other), "utf8")).trim()).toBe("baseline");
        }
        return { ...passedAdapterResult(request), execution: { changedFiles: [file] } };
      }
    }));
    input.verifierExecutor = passingVerifierExecutor();

    const result = await runProductionLiveSwarm(input);

    expect(result.outcome.state, JSON.stringify({
      outcome: result.outcome,
      tasks: result.record.tasks,
      events: result.record.events.map((event) => ({ type: event.type, taskId: event.taskId, payload: event.payload }))
    })).toBe("verified");
    expect(new Set(workspacePaths.values()).size).toBe(3);
    expect(result.record.events.filter((event) => event.type === "CHILD_PATCH_ADMITTED")).toHaveLength(3);
  }, 60_000);

  it("seals truthful production evidence when a child exceeds its token lease", async () => {
    const fixture = await createProductionFixture("overspent-terminal-evidence");
    fixture.plan = createSwarmLivePlan({
      ...fixture.plan,
      agents: fixture.plan.agents.map((agent) => ({
        ...agent,
        contract: { ...agent.contract, hardMaxTokens: 100 }
      }))
    });
    const input = productionInput(fixture, ({ engine }) => ({
      ...passAdapter(engine.model),
      async execute(request) {
        return {
          ...passedAdapterResult(request),
          usage: { actualUsd: 0.01, tokensIn: 105, tokensOut: 5, provenance: "actual" as const }
        };
      }
    }));

    const result = await runProductionLiveSwarm(input);

    expect(result.outcome.state).not.toBe("verified");
    expect(result.outcome.reason).toContain("exceeded its reserved lease");
    expect(result.outcome.reason).not.toBe("terminal_evidence_sealing_failed");
    expect(result.record.budgetLedger.leases).toEqual([
      expect.objectContaining({
        status: "overspent",
        actualUsage: expect.objectContaining({ usd: 0.01, tokens: 110 })
      })
    ]);

    const evidenceRoot = join(fixture.runsRoot, "_swarms", fixture.plan.swarmId, "evidence");
    await expect(access(join(evidenceRoot, "evidence-index.json"))).resolves.toBeUndefined();
    await expect(access(join(evidenceRoot, "parent-receipt.json"))).resolves.toBeUndefined();
    await expect(access(join(evidenceRoot, "swarm-receipt-integrity.json"))).resolves.toBeUndefined();
    await expect(access(join(evidenceRoot, "swarm-receipt-seal.json"))).resolves.toBeUndefined();
    await expect(access(join(evidenceRoot, "swarm-receipt-seal-status.json"))).rejects.toMatchObject({ code: "ENOENT" });

    const completionNames = await readdir(join(evidenceRoot, "child-completions"));
    expect(completionNames).toHaveLength(1);
    const completion = JSON.parse(await readFile(join(evidenceRoot, "child-completions", completionNames[0]!), "utf8"));
    expect(completion).toMatchObject({ leaseState: "overspent", evidencePersisted: true });
    const projection = await readSwarmReceiptProjection({ runsRoot: fixture.runsRoot, swarmId: fixture.plan.swarmId });
    expect(projection.integrity.state).toBe("verified");
  }, 60_000);

  it.each([
    ["undeclared", "write", "src/declared.txt", "src/undeclared.txt"],
    ["read-only", "read_only", "src/inspect.txt", "src/inspect.txt"],
    ["outside-root", "write", "src/declared.txt", "../escape.txt"]
  ] as const)("blocks %s writes through the production worktree seam", async (suffix, mutationMode, declared, changed) => {
    const fixture = await createProductionFixture(`blocked-${suffix}`);
    const writeTask = {
      ...fixture.plan.tasks[0]!,
      mutationMode,
      writeScope: mutationMode === "write" ? [declared] : []
    };
    fixture.plan = createSwarmLivePlan({
      ...fixture.plan,
      planId: `plan-blocked-${suffix}`,
      swarmId: `swarm-blocked-${suffix}`,
      parentContract: {
        ...fixture.plan.parentContract,
        scope: { allowedPaths: ["src/**"], deniedPaths: [".git/**"] }
      },
      tasks: [writeTask],
      agents: fixture.plan.agents.map((agent) => ({
        ...agent,
        contract: {
          ...agent.contract,
          scope: { allowedPaths: [declared], deniedPaths: [".git/**"] }
        }
      }))
    });
    const input = productionInput(fixture, ({ engine, workspace }) => ({
      ...passAdapter(engine.model),
      metadata: { providerId: "codex", model: engine.model, capabilities: { workspaceMutations: true } },
      async execute(request) {
        const absolute = join(workspace.path, changed);
        await mkdir(join(absolute, ".."), { recursive: true });
        await writeFile(absolute, "blocked\n", "utf8");
        return { ...passedAdapterResult(request), execution: { changedFiles: [absolute] } };
      }
    }));

    const result = await runProductionLiveSwarm(input);

    expect(result.outcome.state).not.toBe("verified");
    expect(result.record.events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "CHILD_STOPPED",
        failureClass: "safety_leash_blocked"
      })
    ]));
    expect(result.record.events.some((event) => event.type === "CHILD_PATCH_ADMITTED")).toBe(false);
  }, 60_000);

  it("atomically claims one production start so concurrent replays spend at most once", async () => {
    const fixture = await createProductionFixture("concurrent");
    let adapterCalls = 0;
    const input = productionInput(fixture, () => {
      adapterCalls += 1;
      return passAdapter(fixture.plan.engine.model);
    });

    const settled = await Promise.allSettled([
      runProductionLiveSwarm(input),
      runProductionLiveSwarm(input),
    ]);

    expect(settled.filter((entry) => entry.status === "fulfilled")).toHaveLength(1);
    const rejected = settled.find((entry): entry is PromiseRejectedResult => entry.status === "rejected");
    expect(rejected?.reason).toMatchObject({ code: "LIVE_SWARM_ALREADY_STARTED" });
    expect(adapterCalls).toBe(1);
  }, 60_000);

  it("rejects a pre-created _swarms junction escape before store writes or adapter construction", async () => {
    const fixture = await createProductionFixture("junction");
    const outside = join(scratchRoot, "outside-swarm-store");
    await mkdir(outside, { recursive: true });
    await symlink(outside, join(fixture.runsRoot, "_swarms"), process.platform === "win32" ? "junction" : "dir");
    const adapterFactory = vi.fn(() => passAdapter(fixture.plan.engine.model));

    await expect(runProductionLiveSwarm(productionInput(fixture, adapterFactory))).rejects.toMatchObject({
      code: "LIVE_SWARM_PATH_ESCAPE",
    });
    expect(adapterFactory).not.toHaveBeenCalled();
    expect(await readdir(outside)).toEqual([]);
  }, 60_000);
});

function task(taskId: string, dependsOn: string[] = []): SwarmTaskNode {
  return {
    taskId,
    title: taskId,
    objective: `Complete ${taskId}`,
    required: true,
    dependsOn,
    assignedAgentId: `agent-${taskId.slice(-1)}`,
    status: "queued",
    mutationMode: "read_only",
    writeScope: []
  };
}

function createPlan(
  tasks: SwarmTaskNode[],
  options: {
    maxConcurrency?: number;
    childUsd?: number;
    alternateAgent?: boolean;
    maxReassignments?: number;
    childMaxIterations?: number;
    hardMaxUsd?: number;
    hardMaxTokens?: number;
  } = {}
): SwarmLivePlan {
  const childUsd = options.childUsd ?? 1;
  const agents = tasks.map((item) => ({
    agentId: item.assignedAgentId!,
    role: "worker",
    status: "queued" as const,
    contract: {
      agentId: item.assignedAgentId!,
      taskIds: [item.taskId],
      scope: { allowedPaths: ["src/**"], deniedPaths: [".git/**"] },
      budget: { maxUsd: childUsd, softLimitUsd: childUsd, maxIterations: 3, maxTokens: 100 },
      ...(options.hardMaxUsd !== undefined ? { hardMaxUsd: options.hardMaxUsd } : {}),
      ...(options.hardMaxTokens !== undefined ? { hardMaxTokens: options.hardMaxTokens } : {}),
      maxWallClockMs: 60_000,
      permissions: { networkDomains: [], commands: ["echo"] },
      approvalPolicy: {},
      verifierAuthority: "child_only" as const
    }
  }));
  if (options.alternateAgent) {
    agents.push({
      ...agents[0]!,
      agentId: "agent-b",
      contract: { ...agents[0]!.contract, agentId: "agent-b" }
    });
  }
  return createSwarmLivePlan({
    planId: "plan-live",
    swarmId: "swarm-live",
    workspaceId: "workspace-parent",
    projectId: "project-live",
    baselineCommit: "a".repeat(40),
    parentContract: {
      policyVersion: "swarm-policy-v1",
      objective: "Complete governed live tasks",
      definitionOfDone: ["All required tasks accepted"],
      budget: { maxUsd: 10, softLimitUsd: 8, maxIterations: 10, maxTokens: 1000 },
      maxWallClockMs: 120_000,
      maxConcurrency: options.maxConcurrency ?? 1,
      scope: { allowedPaths: ["src/**"], deniedPaths: [".git/**"] },
      permissions: { networkDomains: [], commands: ["echo"] },
      integrationStrategy: "parent_fan_in",
      globalVerifierStack: [{ command: "echo verify", type: "custom" }],
      stopPolicy: { budgetExhausted: "stop", blockingFailure: "needs_review", verifierFailure: "stop" },
      recoveryPolicy: {
        maxReassignmentsPerTask: options.maxReassignments ?? 0,
        dependencyWaiversAllowed: false
      },
      approvalPolicy: {},
      orchestrationStrategy: "hierarchical_dag"
    },
    tasks,
    agents,
    engine: { engine: "codex", model: "gpt-test" },
    childMaxIterations: options.childMaxIterations ?? 1,
    createdAt: "2026-10-03T00:00:00.000Z"
  });
}

function createFixture(plan: SwarmLivePlan) {
  const live = new MemoryLiveStore(plan);
  let workspaceCounter = 0;
  const manager: any = {
    baselineCommit: plan.baselineCommit,
    canonicalRoot: join(scratchRoot, "canonical"),
    ownedRoot: join(scratchRoot, "workspaces"),
    async createWorkspace(spec: any) {
      workspaceCounter += 1;
      return {
        path: join(scratchRoot, "workspaces", `child-${workspaceCounter}`),
        record: {
          schemaVersion: "martin.swarm.v1",
          baselineCommit: plan.baselineCommit,
          state: "active",
          createdAt: "2026-10-03T00:00:00.000Z",
          swarmId: plan.swarmId,
          ...spec
        }
      };
    },
    async removeWorkspace(handle: any) {
      return cleanupRecord(handle.record.workspaceId);
    }
  };
  const evidence: any = {
    completions: new Map(),
    cleanup: [],
    async persistChildCompletion(completion: any) { this.completions.set(completion.childRunId, completion); },
    async loadPersistedChildCompletion(childRunId: string) { return this.completions.get(childRunId); },
    async persistProcessClosure() {},
    async persistCleanupEvidence(record: any) { this.cleanup.push(record); },
    async persistTerminalRecord() {},
    async persistBeforeCleanup() {}
  };
  const input = {
    plan,
    liveStore: live as any,
    workspaceManager: manager,
    evidenceStore: evidence,
    adapterFactory: ({ engine }) => passAdapter(engine.model),
    verifierExecutor: { execute: vi.fn() } as any,
    runsRoot: join(scratchRoot, "runs"),
    signal: new AbortController().signal,
    now: sequenceClock(),
    createId: idSequence()
  } satisfies RunLiveSwarmInput;
  const dependencies: any = {
    captureCandidate: vi.fn(),
    inventoryCandidatePaths: async () => ["src/a.ts"],
    parentPipeline: async ({ record }: { record: SwarmRunRecord }) => {
      const verified: SwarmEvent = {
        type: "SWARM_VERIFIED",
        swarmId: record.swarmId,
        timestamp: "2026-10-03T00:01:00.000Z",
        parentPolicyVersion: record.parentContract.policyVersion,
        payload: {}
      };
      const finalRecord = {
        ...record,
        outcome: { state: "verified" as const, reason: "parent verifier passed" },
        events: [...record.events, verified]
      };
      return {
        record: finalRecord,
        outcome: finalRecord.outcome,
        disposition: "ready",
        blockingInvariants: [],
        integration: { completed: true, finalTreeHash: plan.baselineCommit, admittedCandidateIds: [] },
        cleanup: []
      };
    }
  };
  return { input, dependencies, live, manager, evidence };
}

class MemoryLiveStore {
  readonly events: SwarmLiveEvent[] = [];
  readonly listeners = new Set<(snapshot: any) => void>();
  constructor(readonly plan: SwarmLivePlan) {}
  async append(input: any, options: { expectedRevision: number }) {
    if (input.type === "SWARM_VERIFIED") throw new Error("PARENT_VERIFIED_AUTHORITY_REQUIRED");
    if (options.expectedRevision !== this.events.length) throw new Error("STALE_REVISION");
    const event = {
      schemaVersion: "martin.swarm.v1" as const,
      sequence: this.events.length + 1,
      swarmId: this.plan.swarmId,
      parentPolicyVersion: this.plan.parentContract.policyVersion,
      planHash: this.plan.planHash,
      ...input
    };
    this.events.push(event);
    const snapshot = await this.readSnapshot();
    for (const listener of [...this.listeners]) listener(snapshot);
    return { event, snapshot, duplicate: false };
  }
  async requestCancellation(request: any, options: { expectedRevision: number }) {
    return this.append({
      idempotencyKey: request.idempotencyKey,
      type: "SWARM_CANCEL_REQUESTED",
      timestamp: request.requestedAt,
      payload: { reason: request.reason, requestedBy: request.requestedBy },
    }, options);
  }
  async readSnapshot() {
    return {
      schemaVersion: "martin.swarm.v1" as const,
      swarmId: this.plan.swarmId,
      planHash: this.plan.planHash,
      revision: this.events.length,
      lastSequence: this.events.length,
      eventCount: this.events.length,
      ...(this.events.find((event) => event.type === "SWARM_CANCEL_REQUESTED")
        ? { cancellation: {
            requestedAt: this.events.find((event) => event.type === "SWARM_CANCEL_REQUESTED")!.timestamp,
            reason: String(this.events.find((event) => event.type === "SWARM_CANCEL_REQUESTED")!.payload.reason),
            requestedBy: String(this.events.find((event) => event.type === "SWARM_CANCEL_REQUESTED")!.payload.requestedBy),
          } }
        : {}),
      outcome: { state: "running" as const, reason: "running" },
      updatedAt: this.events.at(-1)?.timestamp ?? this.plan.createdAt
    };
  }
  async readEvents() { return [...this.events]; }
  async waitForRevision(afterRevision: number, signal?: AbortSignal) {
    if (signal?.aborted) throw Object.assign(new Error("aborted"), { name: "AbortError" });
    const snapshot = await this.readSnapshot();
    if (snapshot.revision > afterRevision) return snapshot;
    return new Promise((resolve, reject) => {
      const listener = (next: any) => {
        if (next.revision <= afterRevision) return;
        cleanup();
        resolve(next);
      };
      const abort = () => { cleanup(); reject(Object.assign(new Error("aborted"), { name: "AbortError" })); };
      const cleanup = () => { this.listeners.delete(listener); signal?.removeEventListener("abort", abort); };
      this.listeners.add(listener);
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
    });
  }
}

function passAdapter(model: string, usage: { actualUsd?: number } = {}): MartinAdapter {
  return {
    adapterId: `codex:${model}`,
    kind: "agent-cli",
    label: "test child",
    metadata: { providerId: "codex", model, capabilities: { workspaceMutations: false } },
    async execute(request) { return passedAdapterResult(request, usage.actualUsd); }
  };
}

function failAdapter(model: string): MartinAdapter {
  return {
    ...passAdapter(model),
    async execute() { return failedAdapterResult(); }
  };
}

function passedAdapterResult(request: MartinAdapterRequest, actualUsd = 0.01) {
  return {
    status: "completed" as const,
    summary: "done",
    usage: { actualUsd, tokensIn: 2, tokensOut: 3 },
    verification: {
      passed: true,
      summary: "pass",
      binding: {
        runId: request.loopId,
        attemptId: request.attemptId,
        ...(request.context.runsRoot ? { runsRoot: request.context.runsRoot } : {}),
        ...(request.context.executionProfile ? { executionProfile: request.context.executionProfile } : {}),
        ...(request.context.allowedNetworkDomains?.length ? { allowedNetworkDomains: request.context.allowedNetworkDomains } : {}),
        workspaceId: request.workspaceId,
        cwd: request.context.repoRoot ?? process.cwd(),
        commands: request.context.verificationPlan
      },
      steps: [{
        command: "echo",
        launched: true,
        completed: true,
        crashed: false,
        exitCode: 0,
        timedOut: false
      }]
    }
  };
}

function failedAdapterResult() {
  return {
    status: "failed" as const,
    summary: "failed",
    usage: { actualUsd: 0.01, tokensIn: 2, tokensOut: 3 },
    verification: { passed: false, summary: "failed" },
    failure: { message: "transient child failure", classHint: "environment_mismatch" as const }
  };
}

function cleanupRecord(workspaceId: string) {
  return {
    schemaVersion: "martin.swarm.v1" as const,
    cleanupId: `cleanup-${workspaceId}`,
    swarmId: "swarm-live",
    workspaceId,
    workspaceKind: "child" as const,
    evidencePersisted: true,
    processCloseState: "closed" as const,
    removalState: "removed" as const,
    state: "completed" as const,
    attemptedAt: "2026-10-03T00:00:10.000Z",
    completedAt: "2026-10-03T00:00:11.000Z"
  };
}

function sequenceClock(): () => string {
  let tick = 0;
  return () => new Date(Date.UTC(2026, 9, 3, 0, 0, tick++)).toISOString();
}

function idSequence(): (prefix: string) => string {
  let sequence = 0;
  return (prefix) => `${prefix}-${++sequence}`;
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T | PromiseLike<T>): void;
  reject(reason?: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function git(cwd: string, args: string[]): Promise<string> {
  const result = await execFileAsync("git", args, {
    cwd,
    windowsHide: true,
    maxBuffer: 8 * 1024 * 1024,
  });
  return result.stdout;
}

async function createProductionFixture(suffix: string) {
  const canonicalRoot = join(scratchRoot, `production-${suffix}-repo`);
  const runsRoot = join(scratchRoot, `production-${suffix}-runs`);
  await mkdir(canonicalRoot, { recursive: true });
  await mkdir(runsRoot, { recursive: true });
  await git(canonicalRoot, ["init"]);
  await git(canonicalRoot, ["config", "user.email", "swarm-test@example.invalid"]);
  await git(canonicalRoot, ["config", "user.name", "Swarm Test"]);
  await writeFile(join(canonicalRoot, "README.md"), `${suffix}\n`, "utf8");
  await git(canonicalRoot, ["add", "README.md"]);
  await git(canonicalRoot, ["commit", "-m", "fixture"]);
  const baselineCommit = (await git(canonicalRoot, ["rev-parse", "HEAD"])).trim();
  const original = createPlan([task("task-a")]);
  const plan = createSwarmLivePlan({
    ...original,
    planId: `plan-${suffix}`,
    swarmId: `swarm-${suffix}`,
    baselineCommit,
  });
  return { canonicalRoot, runsRoot, plan };
}

function productionInput(
  fixture: Awaited<ReturnType<typeof createProductionFixture>>,
  adapterFactory: RunLiveSwarmInput["adapterFactory"],
) {
  return {
    plan: fixture.plan,
    canonicalRoot: fixture.canonicalRoot,
    ownedRoot: join(fixture.runsRoot, "_swarms", fixture.plan.swarmId, "worktrees"),
    storeRoot: fixture.runsRoot,
    runsRoot: fixture.runsRoot,
    adapterFactory,
    verifierExecutor: { execute: vi.fn() } as any,
  };
}

function passingVerifierExecutor() {
  return {
    async execute(request: any) {
      return {
        passed: true,
        processCloseState: "closed" as const,
        binding: {
          swarmId: request.swarmId,
          workspaceId: request.workspaceId,
          cwd: request.cwd,
          parentPolicyVersion: request.parentPolicyVersion,
          baselineCommit: request.baselineCommit,
          integratedTreeHash: request.integratedTreeHash,
          commands: request.commands.map((step: any) => step.command)
        },
        subprocessResults: request.commands.map((step: any) => ({
          command: step.command,
          launched: true,
          completed: true,
          timedOut: false,
          exitCode: 0,
          startedAt: "2026-10-03T00:00:00.000Z",
          completedAt: "2026-10-03T00:00:01.000Z"
        }))
      };
    }
  };
}
