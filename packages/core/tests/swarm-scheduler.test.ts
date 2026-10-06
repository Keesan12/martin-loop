import { describe, expect, it } from "vitest";
import * as publicCoreApi from "../src/index.js";

import {
  completeDeterministicDemoSwarmRun,
  createSwarmBudgetLedger,
  extendSwarmBudgetLease,
  releaseSwarmBudgetLease,
  reserveSwarmBudgetLease,
  selectNextSwarmBatch as selectNextSwarmBatchCore,
  settleSwarmBudgetLease,
  validateSwarmTaskGraph
} from "../src/index.js";
import { createSwarmRunRecord } from "@martin/contracts";
import type {
  SwarmDeterministicDemoReceiptEvidence,
  SwarmRunRecord,
  SwarmTaskNode
} from "@martin/contracts";
import type { DeterministicDemoVerifierExecutionFacts } from "../src/index.js";
import {
  createParentDependencyWaiverRegistry,
  issueParentDependencyWaiver
} from "../src/swarm/index.js";

const schedulingPolicy = {
  policyVersion: "swarm-policy/1",
  maxConcurrency: 5,
  recoveryPolicy: {
    maxReassignmentsPerTask: 1,
    dependencyWaiversAllowed: true
  }
};

type SelectBatchInput = Parameters<typeof selectNextSwarmBatchCore>[0];

function selectNextSwarmBatch(
  input: Omit<SelectBatchInput, "swarmId"> & { swarmId?: string }
) {
  return selectNextSwarmBatchCore({
    ...input,
    swarmId: input.swarmId ?? "swarm-001"
  } as SelectBatchInput);
}

function task(
  taskId: string,
  overrides: Partial<SwarmTaskNode> = {}
): SwarmTaskNode {
  return {
    taskId,
    title: taskId,
    objective: `Complete ${taskId}`,
    required: true,
    dependsOn: [],
    status: "queued",
    mutationMode: "write",
    writeScope: [`packages/${taskId}/**`],
    ...overrides
  };
}

describe("swarm DAG validation", () => {
  it.each([
    ["duplicate identifiers", [task("a"), task("a")], "DUPLICATE_TASK_ID"],
    ["missing dependencies", [task("a", { dependsOn: ["missing"] })], "MISSING_DEPENDENCY"],
    ["self dependencies", [task("a", { dependsOn: ["a"] })], "SELF_DEPENDENCY"],
    ["cycles", [task("a", { dependsOn: ["b"] }), task("b", { dependsOn: ["a"] })], "TASK_CYCLE"]
  ] as const)("fails closed on %s", (_name, tasks, code) => {
    const result = validateSwarmTaskGraph([...tasks]);

    expect(result.ok).toBe(false);
    expect(result.errors).toEqual(expect.arrayContaining([expect.objectContaining({ code })]));
  });

  it("accepts a valid acyclic graph", () => {
    expect(validateSwarmTaskGraph([
      task("a"),
      task("b", { dependsOn: ["a"] })
    ])).toEqual({ ok: true, errors: [] });
  });
});

describe("deterministic bounded scheduling", () => {
  it("orders ready work deterministically and caps the admitted batch", () => {
    const tasks = [task("c"), task("a"), task("b")];

    const first = selectNextSwarmBatch({ tasks, maxConcurrency: 2, parentContract: schedulingPolicy });
    const second = selectNextSwarmBatch({ tasks, maxConcurrency: 2, parentContract: schedulingPolicy });

    expect(first).toEqual(second);
    expect(first.ok).toBe(true);
    expect(first.tasks.map((item) => item.taskId)).toEqual(["a", "b"]);
  });

  it("never exceeds the parent concurrency cap when the request asks for more", () => {
    const result = selectNextSwarmBatch({
      tasks: Array.from({ length: 15 }, (_, index) => task(`task-${String(index).padStart(2, "0")}`)),
      maxConcurrency: 15,
      parentContract: schedulingPolicy
    });

    expect(result.ok).toBe(true);
    expect(result.tasks).toHaveLength(5);
  });

  it("subtracts active running work from the concurrency cap", () => {
    const result = selectNextSwarmBatch({
      tasks: [task("active", { status: "running" }), task("a"), task("b")],
      maxConcurrency: 2,
      parentContract: schedulingPolicy
    });

    expect(result.ok).toBe(true);
    expect(result.tasks.map((item) => item.taskId)).toEqual(["a"]);
  });

  it.each(["rejected", "stopped", "running", "queued", "needs_review"] as const)(
    "does not release downstream work for a %s dependency",
    (status) => {
      const result = selectNextSwarmBatch({
        tasks: [task("upstream", { status }), task("downstream", { dependsOn: ["upstream"] })],
        maxConcurrency: 2,
        parentContract: schedulingPolicy
      });

      expect(result.ok).toBe(true);
      expect(result.tasks.map((item) => item.taskId)).not.toContain("downstream");
    }
  );

  it.each(["accepted"] as const)(
    "releases downstream work for an admissible %s dependency",
    (status) => {
      const result = selectNextSwarmBatch({
        tasks: [task("upstream", { status }), task("downstream", { dependsOn: ["upstream"] })],
        maxConcurrency: 2,
        parentContract: schedulingPolicy
      });

      expect(result.ok).toBe(true);
      expect(result.tasks.map((item) => item.taskId)).toEqual(["downstream"]);
    }
  );

  it("releases a dependency only with a matching parent-issued waiver record", () => {
    const registry = createParentDependencyWaiverRegistry({
      swarmId: "swarm-001",
      parentPolicyVersion: "swarm-policy/1",
      dependencyWaiversAllowed: true
    });
    const issued = issueParentDependencyWaiver(registry, {
      taskId: "downstream",
      dependencyTaskId: "upstream",
      parentPolicyVersion: "swarm-policy/1",
      approvedBy: "owner-001",
      approvedAt: "2026-10-02T13:00:00.000Z"
    });
    expect(issued.ok).toBe(true);
    if (!issued.ok) return;

    const result = selectNextSwarmBatch({
      tasks: [
        task("upstream", { status: "rejected" }),
        task("downstream", { dependsOn: ["upstream"] })
      ],
      maxConcurrency: 2,
      parentContract: schedulingPolicy,
      dependencyWaiverRegistry: registry,
      dependencyWaiverCapabilities: [issued.capability]
    });

    expect(result.ok).toBe(true);
    expect(result.tasks.map((item) => item.taskId)).toEqual(["downstream"]);
  });

  it("does not accept an unapproved dependency waiver", () => {
    const result = selectNextSwarmBatch({
      tasks: [
        task("upstream", { status: "rejected" }),
        task("downstream", { dependsOn: ["upstream"] })
      ],
      maxConcurrency: 2,
      parentContract: schedulingPolicy
    });

    expect(result.ok).toBe(true);
    expect(result.tasks.map((item) => item.taskId)).not.toContain("downstream");
  });

  it("rejects a structurally valid but non-issued waiver capability", () => {
    const forged = {
      taskId: "downstream",
      dependencyTaskId: "upstream",
      parentPolicyVersion: "swarm-policy/1",
      approvedBy: "owner-001",
      approvedAt: "2026-10-02T13:00:00.000Z"
    };
    const result = selectNextSwarmBatch({
      tasks: [
        task("upstream", { status: "rejected" }),
        task("downstream", { dependsOn: ["upstream"] })
      ],
      maxConcurrency: 2,
      parentContract: schedulingPolicy,
      dependencyWaiverCapabilities: [forged as never]
    });

    expect(result.ok).toBe(false);
    expect(result.tasks).toEqual([]);
    expect(result.errors).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "UNISSUED_DEPENDENCY_WAIVER" })])
    );
  });

  it("rejects waivers when parent policy disables them", () => {
    const registry = createParentDependencyWaiverRegistry({
      swarmId: "swarm-001",
      parentPolicyVersion: "swarm-policy/1",
      dependencyWaiversAllowed: true
    });
    const issued = issueParentDependencyWaiver(registry, {
      taskId: "downstream",
      dependencyTaskId: "upstream",
      parentPolicyVersion: "swarm-policy/1",
      approvedBy: "owner-001",
      approvedAt: "2026-10-02T13:00:00.000Z"
    });
    expect(issued.ok).toBe(true);
    if (!issued.ok) return;

    const result = selectNextSwarmBatch({
      tasks: [
        task("upstream", { status: "rejected" }),
        task("downstream", { dependsOn: ["upstream"] })
      ],
      maxConcurrency: 2,
      parentContract: {
        ...schedulingPolicy,
        recoveryPolicy: { ...schedulingPolicy.recoveryPolicy, dependencyWaiversAllowed: false }
      },
      dependencyWaiverRegistry: registry,
      dependencyWaiverCapabilities: [issued.capability]
    });

    expect(result.ok).toBe(false);
    expect(result.errors).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "DEPENDENCY_WAIVERS_DISABLED" })])
    );
  });

  it("rejects waivers bound to a different parent policy version", () => {
    const registry = createParentDependencyWaiverRegistry({
      swarmId: "swarm-001",
      parentPolicyVersion: "swarm-policy/old",
      dependencyWaiversAllowed: true
    });
    const issued = issueParentDependencyWaiver(registry, {
      taskId: "downstream",
      dependencyTaskId: "upstream",
      parentPolicyVersion: "swarm-policy/old",
      approvedBy: "owner-001",
      approvedAt: "2026-10-02T13:00:00.000Z"
    });
    expect(issued.ok).toBe(true);
    if (!issued.ok) return;

    const result = selectNextSwarmBatch({
      tasks: [
        task("upstream", { status: "rejected" }),
        task("downstream", { dependsOn: ["upstream"] })
      ],
      maxConcurrency: 2,
      parentContract: schedulingPolicy,
      dependencyWaiverRegistry: registry,
      dependencyWaiverCapabilities: [issued.capability]
    });

    expect(result.ok).toBe(false);
    expect(result.errors).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "WAIVER_POLICY_VERSION_MISMATCH" })])
    );
  });

  it("rejects replay of a legitimate waiver capability across swarms", () => {
    const registry = createParentDependencyWaiverRegistry({
      swarmId: "swarm-a",
      parentPolicyVersion: "swarm-policy/1",
      dependencyWaiversAllowed: true
    });
    const issued = issueParentDependencyWaiver(registry, {
      taskId: "downstream",
      dependencyTaskId: "upstream",
      parentPolicyVersion: "swarm-policy/1",
      approvedBy: "owner-001",
      approvedAt: "2026-10-02T13:00:00.000Z"
    });
    expect(issued.ok).toBe(true);
    if (!issued.ok) return;

    const result = selectNextSwarmBatch({
      swarmId: "swarm-b",
      tasks: [
        task("upstream", { status: "rejected" }),
        task("downstream", { dependsOn: ["upstream"] })
      ],
      maxConcurrency: 2,
      parentContract: schedulingPolicy,
      dependencyWaiverRegistry: registry,
      dependencyWaiverCapabilities: [issued.capability]
    });

    expect(result.ok).toBe(false);
    expect(result.tasks).toEqual([]);
    expect(result.errors).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "WAIVER_SWARM_MISMATCH" })])
    );
  });

  it("fails closed instead of scheduling an invalid graph", () => {
    const result = selectNextSwarmBatch({
      tasks: [task("a", { dependsOn: ["missing"] })],
      maxConcurrency: 2,
      parentContract: schedulingPolicy
    });

    expect(result.ok).toBe(false);
    expect(result.tasks).toEqual([]);
  });
});

describe("path collision admission", () => {
  it("serializes overlapping mutating scopes", () => {
    const result = selectNextSwarmBatch({
      tasks: [
        task("parent", { writeScope: ["packages/contracts/**"] }),
        task("child", { writeScope: ["packages/contracts/src/**"] }),
        task("safe", { writeScope: ["packages/core/**"] })
      ],
      maxConcurrency: 3,
      parentContract: schedulingPolicy
    });

    expect(result.ok).toBe(true);
    expect(result.tasks.map((item) => item.taskId)).toEqual(["child", "safe"]);
  });

  it("allows read-only tasks with no write authority to coexist", () => {
    const result = selectNextSwarmBatch({
      tasks: [
        task("review-a", { mutationMode: "read_only", writeScope: [] }),
        task("review-b", { mutationMode: "read_only", writeScope: [] })
      ],
      maxConcurrency: 2,
      parentContract: schedulingPolicy
    });

    expect(result.ok).toBe(true);
    expect(result.tasks.map((item) => item.taskId)).toEqual(["review-a", "review-b"]);
  });

  it("rejects read-only tasks that declare write scope", () => {
    const result = selectNextSwarmBatch({
      tasks: [task("unsafe-review", { mutationMode: "read_only", writeScope: ["packages/**"] })],
      maxConcurrency: 1,
      parentContract: schedulingPolicy
    });

    expect(result.ok).toBe(false);
    expect(result.errors).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "READ_ONLY_SCOPE_CONFLICT" })])
    );
  });

  it("rejects write tasks without nonempty valid declared write scope", () => {
    const empty = selectNextSwarmBatch({
      tasks: [task("empty", { mutationMode: "write", writeScope: [] })],
      maxConcurrency: 1,
      parentContract: schedulingPolicy
    });
    const malformed = selectNextSwarmBatch({
      tasks: [task("malformed", { mutationMode: "write", writeScope: ["../packages/**"] })],
      maxConcurrency: 1,
      parentContract: schedulingPolicy
    });

    expect(empty).toMatchObject({
      ok: false,
      errors: [expect.objectContaining({ code: "WRITE_SCOPE_REQUIRED" })]
    });
    expect(malformed).toMatchObject({
      ok: false,
      errors: [expect.objectContaining({ code: "INVALID_WRITE_SCOPE" })]
    });
  });

  it("rejects tasks with missing or unknown mutation modes", () => {
    for (const mutationMode of [undefined, "maybe"]) {
      const value = task("invalid-mode", { mutationMode: mutationMode as never });
      const result = selectNextSwarmBatch({
        tasks: [value],
        maxConcurrency: 1,
        parentContract: schedulingPolicy
      });
      expect(result).toMatchObject({
        ok: false,
        errors: [expect.objectContaining({ code: "INVALID_MUTATION_MODE" })]
      });
    }
  });
});

describe("global budget leasing", () => {
  it("atomically transfers idle sibling capacity to an uneven active lease without exceeding the parent cap", () => {
    const initial = createSwarmBudgetLedger({ capUsd: 6, capTokens: 600 });
    const first = reserveSwarmBudgetLease(initial, {
      leaseId: "lease-a", agentId: "agent-a", taskId: "task-a", reservedUsd: 2, reservedTokens: 200
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const second = reserveSwarmBudgetLease(first.ledger, {
      leaseId: "lease-b", agentId: "agent-b", taskId: "task-b", reservedUsd: 2, reservedTokens: 200
    });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    const third = reserveSwarmBudgetLease(second.ledger, {
      leaseId: "lease-c", agentId: "agent-c", taskId: "task-c", reservedUsd: 2, reservedTokens: 200
    });
    expect(third.ok).toBe(true);
    if (!third.ok) return;

    const extended = extendSwarmBudgetLease(third.ledger, {
      leaseId: "lease-a",
      requiredUsd: 3.25,
      requiredTokens: 325,
      protectedUsage: {
        "lease-a": { usd: 3.25, tokens: 325 },
        "lease-b": { usd: 0.5, tokens: 50 },
        "lease-c": { usd: 0.25, tokens: 25 }
      }
    });

    expect(extended.ok).toBe(true);
    if (!extended.ok) return;
    expect(extended.lease).toMatchObject({ leaseId: "lease-a", reservedUsd: 3.25, reservedTokens: 325 });
    expect(extended.ledger.leases.find((lease) => lease.leaseId === "lease-b")).toMatchObject({
      reservedUsd: 0.75,
      reservedTokens: 75
    });
    expect(extended.ledger.leases.reduce((sum, lease) => sum + (lease.status === "reserved" ? lease.reservedUsd : 0), 0)).toBe(6);
    expect(extended.ledger.leases.reduce((sum, lease) => sum + (lease.status === "reserved" ? lease.reservedTokens : 0), 0)).toBe(600);
  });

  it("fails closed when concurrent observations require more than the aggregate parent cap", () => {
    let ledger = createSwarmBudgetLedger({ capUsd: 2, capTokens: 200 });
    for (const suffix of ["a", "b"]) {
      const reserved = reserveSwarmBudgetLease(ledger, {
        leaseId: `lease-${suffix}`,
        agentId: `agent-${suffix}`,
        taskId: `task-${suffix}`,
        reservedUsd: 1,
        reservedTokens: 100
      });
      expect(reserved.ok).toBe(true);
      if (!reserved.ok) return;
      ledger = reserved.ledger;
    }
    const first = extendSwarmBudgetLease(ledger, {
      leaseId: "lease-a",
      requiredUsd: 1.25,
      requiredTokens: 125,
      protectedUsage: {
        "lease-a": { usd: 1.25, tokens: 125 },
        "lease-b": { usd: 0.75, tokens: 75 }
      }
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    const rejected = extendSwarmBudgetLease(first.ledger, {
      leaseId: "lease-b",
      requiredUsd: 0.76,
      requiredTokens: 76,
      protectedUsage: {
        "lease-a": { usd: 1.25, tokens: 125 },
        "lease-b": { usd: 0.76, tokens: 76 }
      }
    });

    expect(rejected.ok).toBe(false);
    expect(rejected.errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "GLOBAL_BUDGET_EXCEEDED" })
    ]));
    expect(rejected.ledger).toEqual(first.ledger);
  });

  it("preserves an uncapped token ledger while enforcing USD", () => {
    const initial = createSwarmBudgetLedger({ capUsd: 2 });
    expect(initial.capTokens).toBeUndefined();

    const reserved = reserveSwarmBudgetLease(initial, {
      leaseId: "lease-uncapped",
      agentId: "agent-a",
      taskId: "task-a",
      reservedUsd: 1,
      reservedTokens: 10_000_000
    });

    expect(reserved.ok).toBe(true);
  });

  it("reserves before launch and prevents concurrent cap overbooking", () => {
    const initial = createSwarmBudgetLedger({ capUsd: 5, capTokens: 1_000 });
    const first = reserveSwarmBudgetLease(initial, {
      leaseId: "lease-a",
      agentId: "agent-a",
      taskId: "task-a",
      reservedUsd: 3,
      reservedTokens: 600
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    const rejected = reserveSwarmBudgetLease(first.ledger, {
      leaseId: "lease-b",
      agentId: "agent-b",
      taskId: "task-b",
      reservedUsd: 2.01,
      reservedTokens: 401
    });

    expect(rejected.ok).toBe(false);
    expect(rejected.errors).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "GLOBAL_BUDGET_EXCEEDED" })])
    );
    expect(initial.leases).toEqual([]);
  });

  it("settles actual usage once and returns unused reservation", () => {
    const reserved = reserveSwarmBudgetLease(
      createSwarmBudgetLedger({ capUsd: 5, capTokens: 1_000 }),
      {
        leaseId: "lease-a",
        agentId: "agent-a",
        taskId: "task-a",
        reservedUsd: 4,
        reservedTokens: 800
      }
    );
    expect(reserved.ok).toBe(true);
    if (!reserved.ok) return;

    const settled = settleSwarmBudgetLease(reserved.ledger, {
      leaseId: "lease-a",
      actualUsd: 1.25,
      actualTokens: 250,
      provenance: "provider_reported"
    });
    expect(settled.ok).toBe(true);
    if (!settled.ok) return;

    expect(settled.ledger.settledUsd).toBe(1.25);
    expect(settled.ledger.settledTokens).toBe(250);
    expect(settled.ledger.leases[0]).toMatchObject({
      status: "settled",
      actualUsage: { usd: 1.25, tokens: 250, provenance: "provider_reported" }
    });

    const next = reserveSwarmBudgetLease(settled.ledger, {
      leaseId: "lease-b",
      agentId: "agent-b",
      taskId: "task-b",
      reservedUsd: 3.75,
      reservedTokens: 750
    });
    expect(next.ok).toBe(true);
  });

  it("records exact terminal overage truth and rejects duplicate settlement", () => {
    const reserved = reserveSwarmBudgetLease(
      createSwarmBudgetLedger({ capUsd: 3, capTokens: 300 }),
      {
        leaseId: "lease-a",
        agentId: "agent-a",
        taskId: "task-a",
        reservedUsd: 2,
        reservedTokens: 200
      }
    );
    expect(reserved.ok).toBe(true);
    if (!reserved.ok) return;

    const overspent = settleSwarmBudgetLease(reserved.ledger, {
      leaseId: "lease-a",
      actualUsd: 2.01,
      actualTokens: 201,
      provenance: "provider_reported"
    });
    expect(overspent.ok).toBe(false);
    expect(overspent.errors).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "LEASE_OVERSPEND" })])
    );
    expect(overspent.ledger).toMatchObject({ settledUsd: 2.01, settledTokens: 201 });
    expect(overspent.ledger.leases[0]).toMatchObject({
      status: "overspent",
      actualUsage: { usd: 2.01, tokens: 201, provenance: "provider_reported" }
    });

    const replayOverage = settleSwarmBudgetLease(overspent.ledger, {
      leaseId: "lease-a",
      actualUsd: 2.01,
      actualTokens: 201,
      provenance: "provider_reported"
    });
    expect(replayOverage.ok).toBe(false);
    expect(replayOverage.errors).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "LEASE_ALREADY_FINAL" })])
    );

    const settled = settleSwarmBudgetLease(reserved.ledger, {
      leaseId: "lease-a",
      actualUsd: 2,
      actualTokens: 200,
      provenance: "provider_reported"
    });
    expect(settled.ok).toBe(true);
    if (!settled.ok) return;
    const replay = settleSwarmBudgetLease(settled.ledger, {
      leaseId: "lease-a",
      actualUsd: 2,
      actualTokens: 200,
      provenance: "provider_reported"
    });
    expect(replay.ok).toBe(false);
    expect(replay.errors).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "LEASE_ALREADY_FINAL" })])
    );
  });

  it("releases a reservation exactly once without adding settled spend", () => {
    const reserved = reserveSwarmBudgetLease(
      createSwarmBudgetLedger({ capUsd: 2, capTokens: 200 }),
      {
        leaseId: "lease-a",
        agentId: "agent-a",
        taskId: "task-a",
        reservedUsd: 2,
        reservedTokens: 200
      }
    );
    expect(reserved.ok).toBe(true);
    if (!reserved.ok) return;

    const released = releaseSwarmBudgetLease(reserved.ledger, "lease-a");
    expect(released.ok).toBe(true);
    if (!released.ok) return;
    expect(released.ledger).toMatchObject({ settledUsd: 0, settledTokens: 0 });
    expect(released.ledger.leases[0]?.status).toBe("released");

    const reusable = reserveSwarmBudgetLease(released.ledger, {
      leaseId: "lease-b",
      agentId: "agent-b",
      taskId: "task-b",
      reservedUsd: 2,
      reservedTokens: 200
    });
    expect(reusable.ok).toBe(true);

    expect(releaseSwarmBudgetLease(released.ledger, "lease-a")).toMatchObject({
      ok: false,
      errors: [expect.objectContaining({ code: "LEASE_ALREADY_FINAL" })]
    });
  });

  it("rejects invalid numbers and duplicate lease identifiers", () => {
    const initial = createSwarmBudgetLedger({ capUsd: 2, capTokens: 200 });
    const invalidLedger = reserveSwarmBudgetLease(
      createSwarmBudgetLedger({ capUsd: Number.NaN, capTokens: -1 }),
      {
        leaseId: "lease-invalid-ledger",
        agentId: "agent-a",
        taskId: "task-a",
        reservedUsd: 0,
        reservedTokens: 0
      }
    );
    expect(invalidLedger).toMatchObject({
      ok: false,
      errors: [expect.objectContaining({ code: "INVALID_BUDGET_LEDGER" })]
    });

    const invalid = reserveSwarmBudgetLease(initial, {
      leaseId: "lease-invalid",
      agentId: "agent-a",
      taskId: "task-a",
      reservedUsd: Number.NaN,
      reservedTokens: -1
    });
    expect(invalid.ok).toBe(false);
    expect(invalid.errors).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "INVALID_LEASE_AMOUNT" })])
    );

    const fractionalTokens = reserveSwarmBudgetLease(initial, {
      leaseId: "lease-fractional",
      agentId: "agent-a",
      taskId: "task-a",
      reservedUsd: 0,
      reservedTokens: 1.5
    });
    expect(fractionalTokens).toMatchObject({
      ok: false,
      errors: [expect.objectContaining({ code: "INVALID_LEASE_AMOUNT" })]
    });

    const first = reserveSwarmBudgetLease(initial, {
      leaseId: "lease-a",
      agentId: "agent-a",
      taskId: "task-a",
      reservedUsd: 1,
      reservedTokens: 100
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(reserveSwarmBudgetLease(first.ledger, {
      leaseId: "lease-a",
      agentId: "agent-a",
      taskId: "task-a",
      reservedUsd: 1,
      reservedTokens: 100
    })).toMatchObject({
      ok: false,
      errors: [expect.objectContaining({ code: "DUPLICATE_LEASE_ID" })]
    });
  });

  it("validates the complete ledger before reserve, settle, and release", () => {
    const duplicateLeaseLedger = {
      capUsd: 10,
      capTokens: 1_000,
      settledUsd: 0,
      settledTokens: 0,
      leases: [
        {
          leaseId: "lease-a",
          agentId: "agent-a",
          taskId: "task-a",
          reservedUsd: 1,
          reservedTokens: 100,
          status: "reserved" as const
        },
        {
          leaseId: "lease-a",
          agentId: "agent-b",
          taskId: "task-b",
          reservedUsd: 1,
          reservedTokens: 100,
          status: "reserved" as const
        }
      ]
    };

    const transitions = [
      reserveSwarmBudgetLease(duplicateLeaseLedger, {
        leaseId: "lease-new",
        agentId: "agent-new",
        taskId: "task-new",
        reservedUsd: 0,
        reservedTokens: 0
      }),
      settleSwarmBudgetLease(duplicateLeaseLedger, {
        leaseId: "lease-a",
        actualUsd: 0,
        actualTokens: 0
      }),
      releaseSwarmBudgetLease(duplicateLeaseLedger, "lease-a")
    ];

    for (const result of transitions) {
      expect(result).toMatchObject({
        ok: false,
        errors: [expect.objectContaining({ code: "INVALID_BUDGET_LEDGER" })]
      });
    }
  });

  it.each([
    ["empty lease id", {
      capUsd: 10, capTokens: 1_000, settledUsd: 0, settledTokens: 0,
      leases: [{ leaseId: "", agentId: "agent-a", taskId: "task-a", reservedUsd: 1, reservedTokens: 100, status: "reserved" }]
    }],
    ["illegal status", {
      capUsd: 10, capTokens: 1_000, settledUsd: 0, settledTokens: 0,
      leases: [{ leaseId: "lease-a", agentId: "agent-a", taskId: "task-a", reservedUsd: 1, reservedTokens: 100, status: "invented" }]
    }],
    ["fractional tokens", {
      capUsd: 10, capTokens: 1_000, settledUsd: 0, settledTokens: 0,
      leases: [{ leaseId: "lease-a", agentId: "agent-a", taskId: "task-a", reservedUsd: 1, reservedTokens: 1.5, status: "reserved" }]
    }],
    ["settled usage exceeds reservation", {
      capUsd: 10, capTokens: 1_000, settledUsd: 2, settledTokens: 200,
      leases: [{ leaseId: "lease-a", agentId: "agent-a", taskId: "task-a", reservedUsd: 1, reservedTokens: 100, status: "settled", actualUsage: { usd: 2, tokens: 200 } }]
    }],
    ["settled totals mismatch leases", {
      capUsd: 10, capTokens: 1_000, settledUsd: 2, settledTokens: 200,
      leases: [{ leaseId: "lease-a", agentId: "agent-a", taskId: "task-a", reservedUsd: 1, reservedTokens: 100, status: "settled", actualUsage: { usd: 1, tokens: 100 } }]
    }],
    ["reserved plus settled exceeds caps", {
      capUsd: 2, capTokens: 200, settledUsd: 1, settledTokens: 100,
      leases: [
        { leaseId: "lease-a", agentId: "agent-a", taskId: "task-a", reservedUsd: 1, reservedTokens: 100, status: "settled", actualUsage: { usd: 1, tokens: 100 } },
        { leaseId: "lease-b", agentId: "agent-b", taskId: "task-b", reservedUsd: 2, reservedTokens: 200, status: "reserved" }
      ]
    }]
  ])("rejects tampered ledger: %s", (_name, ledger) => {
    const result = reserveSwarmBudgetLease(ledger as never, {
      leaseId: "lease-new",
      agentId: "agent-new",
      taskId: "task-new",
      reservedUsd: 0,
      reservedTokens: 0
    });

    expect(result).toMatchObject({
      ok: false,
      errors: [expect.objectContaining({ code: "INVALID_BUDGET_LEDGER" })]
    });
  });

  it("settles every in-flight actual after one lease overspends and blocks new admission", () => {
    let ledger = createSwarmBudgetLedger({ capUsd: 3, capTokens: 600 });
    for (const id of ["a", "b", "c"]) {
      const reserved = reserveSwarmBudgetLease(ledger, {
        leaseId: `lease-${id}`,
        agentId: `agent-${id}`,
        taskId: `task-${id}`,
        reservedUsd: 1,
        reservedTokens: 200
      });
      expect(reserved.ok).toBe(true);
      ledger = reserved.ledger;
    }

    for (const [id, tokens] of [["a", 218], ["b", 219], ["c", 217]] as const) {
      const settled = settleSwarmBudgetLease(ledger, {
        leaseId: `lease-${id}`,
        actualUsd: 0.25,
        actualTokens: tokens,
        provenance: "actual"
      });
      expect(settled.errors).toEqual([expect.objectContaining({ code: "LEASE_OVERSPEND" })]);
      ledger = settled.ledger;
    }

    expect(ledger.settledTokens).toBe(654);
    expect(ledger.leases.every((lease) => lease.status === "overspent")).toBe(true);
    expect(reserveSwarmBudgetLease(ledger, {
      leaseId: "lease-new",
      agentId: "agent-new",
      taskId: "task-new",
      reservedUsd: 0,
      reservedTokens: 0
    })).toMatchObject({
      ok: false,
      errors: [expect.objectContaining({ code: "GLOBAL_BUDGET_EXCEEDED" })]
    });
  });
});

describe("parent-only final outcome authority", () => {
  function validFixture() {
    const agentIds = Array.from({ length: 15 }, (_, index) => `agent-${String(index + 1).padStart(2, "0")}`);
    const tasks = agentIds.map((agentId, index) => task(`task-${String(index + 1).padStart(2, "0")}`, {
      assignedAgentId: index === 5 ? "agent-10" : agentId,
      status: "accepted",
      writeScope: [`packages/demo/${String(index + 1).padStart(2, "0")}/**`]
    }));
    const roles = [
      "Planner",
      "Data",
      "API",
      "Validation",
      "UI",
      "State",
      "Unit Tests",
      "Integration Tests",
      "Accessibility",
      "Error Handling",
      "Docs",
      "Scope Reviewer",
      "Test Reviewer",
      "Integrator",
      "Final Verifier"
    ];
    const agents = agentIds.map((agentId, index) => ({
      agentId,
      role: roles[index]!,
      status: index === 5 ? "stopped" as const : "verified" as const,
      childRunId: `loop-child-${String(index + 1).padStart(3, "0")}`,
      contract: {
        agentId,
        taskIds: index === 9 ? ["task-10", "task-06"] : [`task-${String(index + 1).padStart(2, "0")}`],
        scope: {
          allowedPaths: index === 9
            ? ["packages/demo/10/**", "packages/demo/06/**"]
            : [`packages/demo/${String(index + 1).padStart(2, "0")}/**`],
          deniedPaths: ["**/.env", "packages/private/**", "packages/demo/blocked/**"]
        },
        budget: { maxUsd: 1, softLimitUsd: 0.8, maxIterations: 3, maxTokens: 10_000 },
        maxWallClockMs: 120_000,
        permissions: { networkDomains: [], commands: ["pnpm test"] },
        approvalPolicy: {
          dependencyAdds: false,
          migrations: false,
          configChanges: false,
          externalWrites: false
        },
        verifierAuthority: "child_only" as const
      }
    }));
    const admittedEvents = tasks.map((currentTask, index) => ({
      type: "CHILD_PATCH_ADMITTED" as const,
      swarmId: "swarm-001",
      timestamp: `2026-10-02T12:${String(30 + index).padStart(2, "0")}:00.000Z`,
      parentPolicyVersion: "swarm-policy/1",
      taskId: currentTask.taskId,
      agentId: currentTask.assignedAgentId,
      childRunId: currentTask.assignedAgentId === "agent-10"
        ? "loop-child-010"
        : `loop-child-${String(index + 1).padStart(3, "0")}`,
      payload: { paths: [`packages/demo/${String(index + 1).padStart(2, "0")}/output.ts`] }
    }));
    const record = createSwarmRunRecord({
      swarmId: "swarm-001",
      workspaceId: "workspace-001",
      projectId: "project-001",
      parentContract: {
        policyVersion: "swarm-policy/1",
        objective: "Integrate one accountable outcome.",
        definitionOfDone: ["Required work accepted", "Global verification passed"],
        budget: { maxUsd: 5, softLimitUsd: 4, maxIterations: 15, maxTokens: 50_000 },
        maxWallClockMs: 600_000,
        maxConcurrency: 5,
        scope: { allowedPaths: ["packages/**"], deniedPaths: ["**/.env", "packages/private/**", "packages/demo/blocked/**"] },
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
        orchestrationStrategy: "hybrid"
      },
      tasks,
      agents,
      budgetLedger: {
        capUsd: 5,
        capTokens: 50_000,
        settledUsd: 1,
        settledTokens: 1_000,
        leases: [{
          leaseId: "lease-001",
          agentId: "agent-01",
          taskId: "task-01",
          reservedUsd: 1,
          reservedTokens: 1_000,
          status: "settled",
          actualUsage: { usd: 1, tokens: 1_000, provenance: "deterministic_demo" }
        }]
      },
      verification: [{
        verifierId: "parent-verifier-001",
        scope: "parent_global",
        state: "passed",
        steps: [{ command: "pnpm test", type: "test_full" }],
        boundAt: "2026-10-02T13:00:00.000Z"
      }],
      events: [
        {
          type: "SWARM_CREATED",
          swarmId: "swarm-001",
          timestamp: "2026-10-02T12:00:00.000Z",
          parentPolicyVersion: "swarm-policy/1",
          payload: {}
        },
        {
          type: "CHILD_PATCH_REJECTED",
          swarmId: "swarm-001",
          timestamp: "2026-10-02T12:20:00.000Z",
          parentPolicyVersion: "swarm-policy/1",
          taskId: "task-06",
          agentId: "agent-06",
          childRunId: "loop-child-006",
          payload: { reason: "scope_creep" }
        },
        {
          type: "CHILD_STOPPED",
          swarmId: "swarm-001",
          timestamp: "2026-10-02T12:21:00.000Z",
          parentPolicyVersion: "swarm-policy/1",
          taskId: "task-06",
          agentId: "agent-06",
          childRunId: "loop-child-006",
          payload: { reason: "scope_creep" }
        },
        {
          type: "TASK_REASSIGNED",
          swarmId: "swarm-001",
          timestamp: "2026-10-02T12:23:00.000Z",
          parentPolicyVersion: "swarm-policy/1",
          taskId: "task-06",
          agentId: "agent-10",
          childRunId: "loop-child-010",
          payload: { fromAgentId: "agent-06" }
        },
        ...admittedEvents,
        {
          type: "INTEGRATION_COMPLETED",
          swarmId: "swarm-001",
          timestamp: "2026-10-02T12:45:00.000Z",
          parentPolicyVersion: "swarm-policy/1",
          payload: {}
        },
        {
          type: "GLOBAL_VERIFIER_PASSED",
          swarmId: "swarm-001",
          timestamp: "2026-10-02T13:00:00.000Z",
          parentPolicyVersion: "swarm-policy/1",
          payload: { verifierId: "parent-verifier-001" }
        }
      ]
    }, { now: "2026-10-02T12:00:00.000Z" });

    const receiptEvidence: SwarmDeterministicDemoReceiptEvidence[] = agents.map((agent) => ({
      evidenceKind: "deterministic_demo",
      swarmId: "swarm-001",
      agentId: agent.agentId,
      taskIds: [...agent.contract.taskIds],
      childRunId: agent.childRunId,
      referentialBinding: "passed",
      signedIntegrity: "not_evaluated"
    }));

    const verifier: DeterministicDemoVerifierExecutionFacts = {
      verifierId: "parent-verifier-001",
      swarmId: "swarm-001",
      workspaceId: "workspace-001",
      parentPolicyVersion: "swarm-policy/1",
      commands: ["pnpm test"],
      launched: true,
      completed: true,
      crashed: false,
      timedOut: false,
      exitCode: 0,
      evaluatedAt: "2026-10-02T13:00:00.000Z"
    };

    return {
      record,
      verifier,
      receiptEvidence
    };
  }

  function addGenericHistoricalReassignment(record: SwarmRunRecord): void {
    const priorAgent = record.agents.find((agent) => agent.agentId === "agent-02")!;
    priorAgent.contract.taskIds.push("task-01");
    record.budgetLedger.leases.push({
      leaseId: "lease-historical-01",
      agentId: "agent-02",
      taskId: "task-01",
      reservedUsd: 0.25,
      reservedTokens: 100,
      status: "settled",
      actualUsage: { usd: 0.25, tokens: 100, provenance: "deterministic_demo" }
    });
    record.budgetLedger.settledUsd = 1.25;
    record.budgetLedger.settledTokens = 1_100;
    record.events.splice(1, 0,
      {
        type: "CHILD_STARTED",
        swarmId: record.swarmId,
        timestamp: "2026-10-02T12:05:00.000Z",
        parentPolicyVersion: record.parentContract.policyVersion,
        taskId: "task-01",
        agentId: "agent-02",
        childRunId: "loop-child-002",
        payload: { leaseId: "lease-historical-01", attemptId: "attempt-prior-01" }
      },
      {
        type: "CHILD_STOPPED",
        swarmId: record.swarmId,
        timestamp: "2026-10-02T12:06:00.000Z",
        parentPolicyVersion: record.parentContract.policyVersion,
        taskId: "task-01",
        agentId: "agent-02",
        childRunId: "loop-child-002",
        payload: { reason: "child_terminal_failure", attemptId: "attempt-prior-01" }
      },
      {
        type: "TASK_REASSIGNED",
        swarmId: record.swarmId,
        timestamp: "2026-10-02T12:07:00.000Z",
        parentPolicyVersion: record.parentContract.policyVersion,
        taskId: "task-01",
        agentId: "agent-01",
        childRunId: "loop-child-001",
        payload: {
          fromAgentId: "agent-02",
          toAgentId: "agent-01",
          fromAttemptId: "attempt-prior-01",
          toAttemptId: "attempt-current-01",
          reason: "child_terminal_failure",
          reassignment: 1
        }
      },
      {
        type: "CHILD_STARTED",
        swarmId: record.swarmId,
        timestamp: "2026-10-02T12:08:00.000Z",
        parentPolicyVersion: record.parentContract.policyVersion,
        taskId: "task-01",
        agentId: "agent-01",
        childRunId: "loop-child-001",
        payload: { attemptId: "attempt-current-01" }
      }
    );
  }

  it("exposes only the record-derived parent completion transition through public Core", () => {
    expect(publicCoreApi).toHaveProperty("completeDeterministicDemoSwarmRun");
    expect(publicCoreApi).not.toHaveProperty("completeParentSwarmRun");
    expect(publicCoreApi).not.toHaveProperty("assessSwarmOutcomeEvidence");
    expect(publicCoreApi).not.toHaveProperty("finalizeParentSwarmOutcome");
    expect(publicCoreApi).not.toHaveProperty("createParentDependencyWaiverRegistry");
    expect(publicCoreApi).not.toHaveProperty("issueParentDependencyWaiver");
  });

  it("rejects invalid and non-running records before terminal authority", () => {
    const invalid = validFixture();
    invalid.record.tasks.push({ ...invalid.record.tasks[0]! });
    expect(completeDeterministicDemoSwarmRun(invalid)).toMatchObject({
      outcome: { state: "stopped" },
      blockingInvariants: ["record"]
    });

    const terminal = validFixture();
    terminal.record.outcome = { state: "verified", reason: "already done" };
    expect(completeDeterministicDemoSwarmRun(terminal)).toMatchObject({
      outcome: { state: "stopped" },
      blockingInvariants: ["parentState"]
    });
  });

  it.each([
    ["blank record workspace", (fixture: ReturnType<typeof validFixture>) => { fixture.record.workspaceId = ""; fixture.verifier.workspaceId = ""; }],
    ["blank record project", (fixture: ReturnType<typeof validFixture>) => { fixture.record.projectId = " "; }],
    ["blank verifier id", (fixture: ReturnType<typeof validFixture>) => {
      fixture.verifier.verifierId = "";
      fixture.record.verification[0]!.verifierId = "";
      fixture.record.events.find((event) => event.type === "GLOBAL_VERIFIER_PASSED")!.payload.verifierId = "";
    }],
    ["blank verifier swarm", (fixture: ReturnType<typeof validFixture>) => { fixture.verifier.swarmId = ""; }],
    ["blank verifier workspace", (fixture: ReturnType<typeof validFixture>) => { fixture.verifier.workspaceId = ""; }],
    ["blank verifier policy", (fixture: ReturnType<typeof validFixture>) => { fixture.verifier.parentPolicyVersion = ""; }],
    ["malformed evaluated time", (fixture: ReturnType<typeof validFixture>) => {
      fixture.verifier.evaluatedAt = "not-an-iso-date";
      fixture.record.verification[0]!.boundAt = "not-an-iso-date";
      fixture.record.events.find((event) => event.type === "GLOBAL_VERIFIER_PASSED")!.timestamp = "not-an-iso-date";
    }]
  ] as const)("rejects empty or malformed completion identity: %s", (_name, mutate) => {
    const fixture = validFixture();
    mutate(fixture);

    const result = completeDeterministicDemoSwarmRun(fixture);

    expect(result.outcome.state).not.toBe("verified");
  });

  it.each([
    ["outside parent scope", "admittedScope", (fixture: ReturnType<typeof validFixture>) => {
      fixture.record.tasks[0]!.writeScope = ["docs/**"];
      fixture.record.events.find((event) => event.type === "CHILD_PATCH_ADMITTED" && event.taskId === "task-01")!.payload.paths = ["docs/file.ts"];
    }],
    ["outside child scope", "admittedScope", (fixture: ReturnType<typeof validFixture>) => {
      fixture.record.tasks[0]!.writeScope = ["packages/demo/02/**"];
      fixture.record.events.find((event) => event.type === "CHILD_PATCH_ADMITTED" && event.taskId === "task-01")!.payload.paths = ["packages/demo/02/file.ts"];
    }],
    ["overlapping denied scope", "admittedScope", (fixture: ReturnType<typeof validFixture>) => {
      fixture.record.agents[0]!.contract.scope.allowedPaths = ["packages/demo/blocked/**"];
      fixture.record.tasks[0]!.writeScope = ["packages/demo/blocked/**"];
      fixture.record.events.find((event) => event.type === "CHILD_PATCH_ADMITTED" && event.taskId === "task-01")!.payload.paths = ["packages/demo/blocked/secret.ts"];
    }],
    ["admitted event outside task scope", "admittedScope", (fixture: ReturnType<typeof validFixture>) => {
      fixture.record.events.find((event) => event.type === "CHILD_PATCH_ADMITTED" && event.taskId === "task-01")!.payload.paths = ["packages/demo/02/file.ts"];
    }],
    ["unsafe non-normalized task scope", "record", (fixture: ReturnType<typeof validFixture>) => {
      fixture.record.tasks[0]!.writeScope = ["packages/demo/01/../blocked/**"];
    }]
  ] as const)("rejects false VERIFIED scope: %s", (_name, invariant, mutate) => {
    const fixture = validFixture();
    mutate(fixture);

    const result = completeDeterministicDemoSwarmRun(fixture);

    expect(result.outcome.state).not.toBe("verified");
    expect(result.blockingInvariants).toContain(invariant);
  });

  it.each([
    ["valid-first denied replay", (record: SwarmRunRecord) => {
      const event = record.events.find((item) => item.type === "CHILD_PATCH_ADMITTED" && item.taskId === "task-01")!;
      record.events.splice(record.events.indexOf(event) + 1, 0, {
        ...event,
        timestamp: "2026-10-02T12:31:30.000Z",
        payload: { paths: ["packages/demo/01/.env"] }
      });
    }],
    ["stray unknown task", (record: SwarmRunRecord) => {
      const event = record.events.find((item) => item.type === "CHILD_PATCH_ADMITTED")!;
      record.events.push({ ...event, taskId: "task-unknown", payload: { paths: ["packages/demo/01/output.ts"] } });
    }],
    ["read-only task admission", (record: SwarmRunRecord) => {
      record.tasks[1]!.mutationMode = "read_only";
      record.tasks[1]!.writeScope = [];
    }],
    ["wrong current agent", (record: SwarmRunRecord) => {
      record.events.find((item) => item.type === "CHILD_PATCH_ADMITTED" && item.taskId === "task-01")!.agentId = "agent-02";
    }],
    ["wrong current child run", (record: SwarmRunRecord) => {
      record.events.find((item) => item.type === "CHILD_PATCH_ADMITTED" && item.taskId === "task-01")!.childRunId = "loop-child-002";
    }]
  ] as const)("rejects ambiguous or stray admission evidence: %s", (_name, mutate) => {
    const fixture = validFixture();
    mutate(fixture.record);

    const result = completeDeterministicDemoSwarmRun(fixture);

    expect(result.outcome.state).not.toBe("verified");
    expect(result.blockingInvariants).toContain("admittedScope");
  });

  it.each([
    ["negative amount", (record: SwarmRunRecord) => { record.budgetLedger.leases[0]!.reservedUsd = -1; }],
    ["nonfinite amount", (record: SwarmRunRecord) => { record.budgetLedger.leases[0]!.reservedUsd = Number.NaN; }],
    ["duplicate lease", (record: SwarmRunRecord) => { record.budgetLedger.leases.push({ ...record.budgetLedger.leases[0]!, actualUsage: { ...record.budgetLedger.leases[0]!.actualUsage! } }); }],
    ["empty identity", (record: SwarmRunRecord) => { record.budgetLedger.leases[0]!.agentId = ""; }],
    ["illegal status", (record: SwarmRunRecord) => { record.budgetLedger.leases[0]!.status = "invented" as never; }],
    ["released usage", (record: SwarmRunRecord) => { record.budgetLedger.leases[0]!.status = "released"; }],
    ["totals mismatch", (record: SwarmRunRecord) => { record.budgetLedger.settledUsd = 0.5; }],
    ["cap overbook", (record: SwarmRunRecord) => { record.budgetLedger.leases.push({ leaseId: "lease-overbook", agentId: "agent-02", taskId: "task-02", reservedUsd: 5, reservedTokens: 49_001, status: "reserved" }); }]
  ] as const)("rejects tampered terminal budget ledger: %s", (_name, mutate) => {
    const fixture = validFixture();
    mutate(fixture.record);

    const result = completeDeterministicDemoSwarmRun(fixture);

    expect(result.outcome.state).not.toBe("verified");
    expect(result.blockingInvariants).toContain("budget");
  });

  it.each([
    ["lease agent/task mismatch", (record: SwarmRunRecord) => { record.budgetLedger.leases[0]!.agentId = "agent-02"; }],
    ["child USD cap overspend", (record: SwarmRunRecord) => {
      record.budgetLedger.leases.push({
        leaseId: "lease-child-over",
        agentId: "agent-01",
        taskId: "task-01",
        reservedUsd: 0.1,
        reservedTokens: 1,
        status: "settled",
        actualUsage: { usd: 0.1, tokens: 1, provenance: "deterministic_demo" }
      });
      record.budgetLedger.settledUsd = 1.1;
      record.budgetLedger.settledTokens = 1_001;
    }],
    ["child token cap overspend", (record: SwarmRunRecord) => {
      record.agents[0]!.contract.budget.maxUsd = 2;
      record.agents[0]!.contract.budget.softLimitUsd = 1;
      record.budgetLedger.leases.push({
        leaseId: "lease-child-token-over",
        agentId: "agent-01",
        taskId: "task-01",
        reservedUsd: 0,
        reservedTokens: 9_001,
        status: "settled",
        actualUsage: { usd: 0, tokens: 9_001, provenance: "deterministic_demo" }
      });
      record.budgetLedger.settledTokens = 10_001;
    }]
  ] as const)("rejects invalid child lease authority or cap: %s", (_name, mutate) => {
    const fixture = validFixture();
    mutate(fixture.record);

    const result = completeDeterministicDemoSwarmRun(fixture);

    expect(result.outcome.state).not.toBe("verified");
    expect(result.blockingInvariants).toContain("budget");
  });

  it("accepts a settled historical lease only when an exact reassignment chain binds the prior attempt", () => {
    const fixture = validFixture();
    addGenericHistoricalReassignment(fixture.record);

    const result = completeDeterministicDemoSwarmRun(fixture);

    expect(result.blockingInvariants).not.toContain("budget");
  });

  it.each([
    ["unrelated task", (record: SwarmRunRecord) => {
      record.events.find((event) => event.type === "TASK_REASSIGNED" && event.payload.fromAttemptId === "attempt-prior-01")!.taskId = "task-02";
    }],
    ["unrelated prior agent", (record: SwarmRunRecord) => {
      record.events.find((event) => event.type === "TASK_REASSIGNED" && event.payload.fromAttemptId === "attempt-prior-01")!.payload.fromAgentId = "agent-03";
    }],
    ["missing prior terminal", (record: SwarmRunRecord) => {
      record.events = record.events.filter((event) => !(event.type === "CHILD_STOPPED" && event.childRunId === "loop-child-002" && event.taskId === "task-01"));
    }],
    ["unordered reassignment", (record: SwarmRunRecord) => {
      record.events.find((event) => event.type === "TASK_REASSIGNED" && event.payload.fromAttemptId === "attempt-prior-01")!.timestamp = "2026-10-02T12:04:00.000Z";
    }],
    ["mismatched prior attempt", (record: SwarmRunRecord) => {
      const reassigned = record.events.find((event) => event.type === "TASK_REASSIGNED" && event.payload.fromAttemptId === "attempt-prior-01")!;
      reassigned.payload.fromAttemptId = "attempt-invented-prior";
      reassigned.payload.toAttemptId = "attempt-invented-current";
    }],
    ["same replacement assignment", (record: SwarmRunRecord) => {
      const reassigned = record.events.find((event) => event.type === "TASK_REASSIGNED" && event.payload.fromAttemptId === "attempt-prior-01")!;
      reassigned.agentId = "agent-02";
      reassigned.childRunId = "loop-child-002";
      reassigned.payload.toAgentId = "agent-02";
      reassigned.payload.toAttemptId = "attempt-prior-01";
    }]
  ] as const)("rejects an unbound historical lease chain: %s", (_name, mutate) => {
    const fixture = validFixture();
    addGenericHistoricalReassignment(fixture.record);
    mutate(fixture.record);

    const result = completeDeterministicDemoSwarmRun(fixture);

    expect(result.blockingInvariants).toContain("budget");
  });

  it.each([
    ["missing rejection", (record: SwarmRunRecord) => { record.events = record.events.filter((event) => event.type !== "CHILD_PATCH_REJECTED"); }],
    ["missing stop", (record: SwarmRunRecord) => { record.events = record.events.filter((event) => event.type !== "CHILD_STOPPED"); }],
    ["wrong replacement child run", (record: SwarmRunRecord) => { record.events.find((event) => event.type === "TASK_REASSIGNED")!.childRunId = "loop-forged"; }],
    ["replayed reassignment", (record: SwarmRunRecord) => { const event = record.events.find((item) => item.type === "TASK_REASSIGNED")!; record.events.push({ ...event, payload: { ...event.payload } }); }],
    ["ambiguous duplicate rejection", (record: SwarmRunRecord) => { const event = record.events.find((item) => item.type === "CHILD_PATCH_REJECTED")!; record.events.push({ ...event, payload: { reason: "wrong_reason" } }); }],
    ["noncausal order", (record: SwarmRunRecord) => { record.events.find((event) => event.type === "TASK_REASSIGNED")!.timestamp = "2026-10-02T12:19:00.000Z"; }],
    ["noncanonical sandbox-write reason", (record: SwarmRunRecord) => { for (const event of record.events.filter((item) => item.type === "CHILD_PATCH_REJECTED" || item.type === "CHILD_STOPPED")) event.payload.reason = "sandbox_write_blocked"; }]
  ] as const)("rejects noncanonical Agent06 recovery: %s", (_name, mutate) => {
    const fixture = validFixture();
    mutate(fixture.record);

    const result = completeDeterministicDemoSwarmRun(fixture);

    expect(result.outcome.state).not.toBe("verified");
    expect(result.blockingInvariants).toContain("blockingFailures");
  });

  it("enforces the canonical roster, roles, terminal states, and one parent verifier", () => {
    const wrongRole = validFixture();
    wrongRole.record.agents[0]!.role = "Invented";
    expect(completeDeterministicDemoSwarmRun(wrongRole).outcome.state).not.toBe("verified");

    for (const status of ["queued", "running", "needs_review"] as const) {
      const nonterminal = validFixture();
      nonterminal.record.agents[1]!.status = status;
      expect(completeDeterministicDemoSwarmRun(nonterminal).blockingInvariants).toContain("blockingFailures");
    }

    const duplicateVerifier = validFixture();
    duplicateVerifier.record.verification.push({
      ...duplicateVerifier.record.verification[0]!,
      verifierId: "parent-verifier-duplicate",
      steps: duplicateVerifier.record.verification[0]!.steps.map((step) => ({ ...step }))
    });
    expect(completeDeterministicDemoSwarmRun(duplicateVerifier).blockingInvariants).toContain("globalVerifier");
  });

  it.each([
    ["swarm identity", (fixture: ReturnType<typeof validFixture>) => { fixture.verifier.swarmId = "swarm-forged"; }],
    ["workspace identity", (fixture: ReturnType<typeof validFixture>) => { fixture.verifier.workspaceId = "workspace-forged"; }],
    ["policy identity", (fixture: ReturnType<typeof validFixture>) => { fixture.verifier.parentPolicyVersion = "swarm-policy/forged"; }],
    ["command identity", (fixture: ReturnType<typeof validFixture>) => { fixture.verifier.commands = ["echo forged"]; }],
    ["verifier identity", (fixture: ReturnType<typeof validFixture>) => { fixture.verifier.verifierId = "forged-verifier"; }],
    ["launch state", (fixture: ReturnType<typeof validFixture>) => { fixture.verifier.launched = false; }],
    ["completion state", (fixture: ReturnType<typeof validFixture>) => { fixture.verifier.completed = false; }],
    ["crash state", (fixture: ReturnType<typeof validFixture>) => { fixture.verifier.crashed = true; }],
    ["timeout state", (fixture: ReturnType<typeof validFixture>) => { fixture.verifier.timedOut = true; }],
    ["exit code", (fixture: ReturnType<typeof validFixture>) => { fixture.verifier.exitCode = 1; }]
  ] as const)("rejects mismatched parent verifier %s", (_name, mutate) => {
    const fixture = validFixture();
    mutate(fixture);

    const result = completeDeterministicDemoSwarmRun(fixture);

    expect(result.outcome.state).not.toBe("verified");
    expect(result.event).toBeUndefined();
    expect(result.blockingInvariants).toContain("globalVerifier");
  });

  it.each([
    ["swarm", (evidence: SwarmDeterministicDemoReceiptEvidence) => { evidence.swarmId = "swarm-forged"; }],
    ["agent", (evidence: SwarmDeterministicDemoReceiptEvidence) => { evidence.agentId = "agent-forged"; }],
    ["task set", (evidence: SwarmDeterministicDemoReceiptEvidence) => { evidence.taskIds = ["task-forged"]; }],
    ["child run", (evidence: SwarmDeterministicDemoReceiptEvidence) => { evidence.childRunId = "loop-forged"; }],
    ["binding state", (evidence: SwarmDeterministicDemoReceiptEvidence) => { evidence.referentialBinding = "failed"; }]
  ] as const)("rejects a wrong deterministic demo %s binding", (_name, mutate) => {
    const fixture = validFixture();
    mutate(fixture.receiptEvidence[0]!);

    const result = completeDeterministicDemoSwarmRun(fixture);

    expect(result.outcome.state).not.toBe("verified");
    expect(result.blockingInvariants).toContain("receiptBinding");
    expect(result.receiptEvidence[0]?.signedIntegrity).toBe("not_evaluated");
  });

  it("rejects missing and replayed evidence instead of counting links twice", () => {
    const missing = validFixture();
    missing.receiptEvidence.pop();
    expect(completeDeterministicDemoSwarmRun(missing).blockingInvariants).toContain("receiptBinding");

    const replayed = validFixture();
    replayed.receiptEvidence[14] = { ...replayed.receiptEvidence[0]!, taskIds: [...replayed.receiptEvidence[0]!.taskIds] };
    expect(completeDeterministicDemoSwarmRun(replayed).blockingInvariants).toContain("receiptBinding");
  });

  it("allows parent verification after stopped Agent 06 work is reassigned and accepted by Agent 10", () => {
    const fixture = validFixture();

    const result = completeDeterministicDemoSwarmRun(fixture);

    expect(fixture.record.agents.find((agent) => agent.agentId === "agent-06")?.status).toBe("stopped");
    expect(fixture.record.tasks.find((item) => item.taskId === "task-06")).toMatchObject({
      status: "accepted",
      assignedAgentId: "agent-10"
    });
    expect(result.blockingInvariants).not.toContain("blockingFailures");
    expect(result.outcome.state).toBe("verified");
  });

  it("keeps stopped work blocking when reassignment evidence is missing", () => {
    const fixture = validFixture();
    fixture.record.events = fixture.record.events.filter((event) => event.type !== "TASK_REASSIGNED");

    const result = completeDeterministicDemoSwarmRun(fixture);

    expect(result.outcome.state).not.toBe("verified");
    expect(result.blockingInvariants).toContain("blockingFailures");
  });

  it.each([
    ["requiredTasks", (record: SwarmRunRecord) => { record.tasks[0]!.status = "queued"; }],
    ["admittedScope", (record: SwarmRunRecord) => { record.events = record.events.filter((event) => event.type !== "CHILD_PATCH_ADMITTED"); }],
    ["budget", (record: SwarmRunRecord) => { record.budgetLedger.leases[0]!.status = "reserved"; delete record.budgetLedger.leases[0]!.actualUsage; record.budgetLedger.settledUsd = 0; record.budgetLedger.settledTokens = 0; }],
    ["blockingFailures", (record: SwarmRunRecord) => { record.conflicts.push({ conflictId: "conflict-1", taskIds: ["task-01"], paths: ["packages/demo/01/**"], state: "blocking" }); }],
    ["integration", (record: SwarmRunRecord) => { record.events = record.events.filter((event) => event.type !== "INTEGRATION_COMPLETED"); }],
    ["globalVerifier", (record: SwarmRunRecord) => { record.verification[0]!.state = "failed"; }]
  ] as const)("blocks completion when record-backed %s does not pass", (invariant, mutate) => {
    const fixture = validFixture();
    mutate(fixture.record);

    const result = completeDeterministicDemoSwarmRun(fixture);

    expect(result.outcome.state).not.toBe("verified");
    expect(result.event).toBeUndefined();
    expect(result.blockingInvariants).toContain(invariant);
  });

  it("returns a deeply isolated verified record and receipt snapshot", () => {
    const fixture = validFixture();
    const result = completeDeterministicDemoSwarmRun(fixture);
    expect(result.outcome.state).toBe("verified");

    fixture.record.tasks[0]!.writeScope[0] = "mutated/task";
    const admitted = fixture.record.events.find((event) => event.type === "CHILD_PATCH_ADMITTED" && event.taskId === "task-01")!;
    (admitted.payload.paths as string[])[0] = "mutated/event";
    fixture.record.agents[0]!.contract.taskIds[0] = "mutated-contract";
    fixture.record.budgetLedger.leases[0]!.actualUsage!.usd = 999;
    fixture.record.verification[0]!.steps[0]!.command = "mutated command";
    fixture.record.conflicts.push({
      conflictId: "mutated-conflict",
      taskIds: ["task-01"],
      paths: ["mutated/path"],
      state: "blocking"
    });
    fixture.receiptEvidence[0]!.taskIds[0] = "mutated-receipt";

    expect(result.record.tasks[0]!.writeScope[0]).toBe("packages/demo/01/**");
    expect((result.record.events.find((event) => event.type === "CHILD_PATCH_ADMITTED" && event.taskId === "task-01")!.payload.paths as string[])[0]).toBe("packages/demo/01/output.ts");
    expect(result.record.agents[0]!.contract.taskIds[0]).toBe("task-01");
    expect(result.record.budgetLedger.leases[0]!.actualUsage!.usd).toBe(1);
    expect(result.record.verification[0]!.steps[0]!.command).toBe("pnpm test");
    expect(result.record.conflicts).toEqual([]);
    expect(result.receiptEvidence[0]!.taskIds[0]).toBe("task-01");
  });

  it("emits SWARM_VERIFIED only from a valid record, bound verifier, and bound demo evidence", () => {
    const fixture = validFixture();
    const result = completeDeterministicDemoSwarmRun(fixture);

    expect(result.outcome).toEqual({
      state: "verified",
      reason: "All parent swarm verification invariants passed.",
      verifiedAt: "2026-10-02T13:00:00.000Z"
    });
    expect(result.blockingInvariants).toEqual([]);
    expect(result.event).toMatchObject({
      type: "SWARM_VERIFIED",
      swarmId: "swarm-001",
      timestamp: "2026-10-02T13:00:00.000Z",
      parentPolicyVersion: "swarm-policy/1"
    });
    expect(result.record.outcome).toEqual(result.outcome);
    expect(result.record.events.at(-1)).toEqual(result.event);
    expect(result.receiptEvidence).toEqual(fixture.receiptEvidence);
    expect(result.receiptEvidence[0]).toMatchObject({
      referentialBinding: "passed",
      signedIntegrity: "not_evaluated"
    });
  });
});
