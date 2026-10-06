import { createHash } from "node:crypto";

import { createSwarmLivePlan, type SwarmLiveEvent } from "@martin/contracts";
import { describe, expect, it } from "vitest";

import type { ReadAndSealSwarmEvidenceResult } from "../src/swarm/evidence.js";
import {
  buildParentSwarmReceipt,
  verifyParentSwarmReceipt
} from "../src/swarm/parent-receipt.js";

describe("parent swarm receipt build and binding", () => {
  it("builds one stable canonical receipt with projections derived from persisted events", () => {
    const sealed = sealedFixture();
    const first = buildParentSwarmReceipt(sealed);
    const second = buildParentSwarmReceipt(sealed);

    expect(first).toEqual(second);
    expect(first.schemaVersion).toBe("martin.swarm-receipt.v1");
    expect(first.parentOutcome.state).toBe("verified");
    expect(first.blockedActions.map((item) => item.sequence)).toEqual([6, 8]);
    expect(first.reassignments).toEqual([expect.objectContaining({
      sequence: 7,
      taskId: "task-a",
      fromAgentId: "agent-a",
      toAgentId: "agent-b",
      fromAttemptId: "attempt-a",
      toAttemptId: "attempt-b"
    })]);
    expect(first.childReceipts).toEqual([expect.objectContaining({
      childRunId: "child-a",
      agentId: "agent-a",
      attemptId: "attempt-a",
      taskIds: ["task-a"]
    })]);
    expect(first.tasks).toEqual([expect.objectContaining({ taskId: "task-a", status: "accepted" })]);
    expect(first.agents).toEqual([expect.objectContaining({ agentId: "agent-a", status: "verified", childRunId: "child-a" })]);
    expect(first.budgetLedger).toMatchObject({
      capUsd: 2,
      capTokens: 2000,
      settledUsd: 0.25,
      settledTokens: 30,
      leases: [expect.objectContaining({ leaseId: "lease-a", status: "settled" })]
    });
    expect(first.evidenceBindings).toMatchObject({
      admissions: ["evidence/decisions/opaque-a.json"],
      rejections: ["evidence/decisions/opaque-b.json", "evidence/integration-outcomes/opaque-c.json"],
      conflicts: ["evidence/integration-outcomes/opaque-c.json"]
    });
    expect(verifyParentSwarmReceipt(first)).toEqual({ ok: true });
  });

  it("classifies evidence by validated content instead of filenames", () => {
    const sealed = sealedFixture();
    sealed.model.events = sealed.model.events.map((item) => item.sequence >= 9 ? { ...item, sequence: item.sequence + 1 } : item);
    const renamedIntegrationEvent = event(sealed.model.plan, 9, "CHILD_PATCH_ADMITTED", {
      candidateId: "candidate-z",
      patchSha256: "e".repeat(64)
    }, { taskId: "task-a", agentId: "agent-a", childRunId: "child-a" });
    sealed.model.events.push(renamedIntegrationEvent);
    const childCompletion = sealed.model.artifacts.find((artifact) => artifact.path.includes("child-completions"))!;
    childCompletion.value.cleanup = {
      schemaVersion: "martin.swarm.v1",
      swarmId: sealed.model.plan.swarmId,
      cleanupId: "cleanup-renamed",
      workspaceId: "workspace-renamed",
      workspaceKind: "child",
      state: "completed",
      evidencePersisted: true,
      processCloseState: "closed",
      removalState: "removed",
      attemptedAt: "2026-10-03T12:05:00.000Z",
      completedAt: "2026-10-03T12:05:01.000Z"
    };
    sealed.model.artifacts.push(
      {
        path: "evidence/misc/integration-renamed.json",
        value: {
          swarmId: sealed.model.plan.swarmId,
          decision: admission(sealed.model.plan, "candidate-z", "admitted", "admitted"),
          event: persistedEvent(renamedIntegrationEvent)
        }
      },
      {
        path: "evidence/misc/verifier-renamed.json",
        value: {
          swarmId: sealed.model.plan.swarmId,
          schemaVersion: "martin.swarm.v1",
          verificationId: "verify-a",
          commandState: "passed",
          mutationState: "clean",
          integratedTreeHash: "b".repeat(64),
          parentPolicyVersion: sealed.model.plan.parentContract.policyVersion,
          baselineCommit: sealed.model.plan.baselineCommit,
          workspaceId: "workspace-verifier",
          commands: ["pnpm test"],
          startedAt: "2026-10-03T12:05:00.000Z",
          completedAt: "2026-10-03T12:05:01.000Z",
          subprocessResults: []
        }
      },
      {
        path: "evidence/misc/cleanup-renamed.json",
        value: structuredClone(childCompletion.value.cleanup as Record<string, unknown>)
      },
      {
        path: "evidence/misc/forged-verifier.json",
        value: {
          schemaVersion: "forged",
          swarmId: "other-swarm",
          verificationId: "forged",
          commandState: "passed",
          mutationState: "clean",
          integratedTreeHash: "b".repeat(64),
          parentPolicyVersion: sealed.model.plan.parentContract.policyVersion,
          baselineCommit: sealed.model.plan.baselineCommit
        }
      },
      {
        path: "evidence/misc/forged-cleanup.json",
        value: { schemaVersion: "forged", swarmId: "other-swarm", cleanupId: "forged", workspaceId: "forged", state: "completed" }
      },
      {
        path: "evidence/misc/partial-decision.json",
        value: {
          schemaVersion: "martin.swarm.v1",
          swarmId: sealed.model.plan.swarmId,
          baselineCommit: sealed.model.plan.baselineCommit,
          candidateId: "candidate-z",
          state: "admitted"
        }
      },
      {
        path: "evidence/misc/partial-verifier.json",
        value: {
          schemaVersion: "martin.swarm.v1",
          swarmId: sealed.model.plan.swarmId,
          verificationId: "verify-a",
          commandState: "passed",
          mutationState: "clean",
          integratedTreeHash: "b".repeat(64),
          parentPolicyVersion: sealed.model.plan.parentContract.policyVersion,
          baselineCommit: sealed.model.plan.baselineCommit
        }
      }
    );

    const receipt = buildParentSwarmReceipt(sealed);
    expect(receipt.evidenceBindings.integration).toContain("evidence/misc/integration-renamed.json");
    expect(receipt.evidenceBindings.admissions).not.toContain("evidence/misc/partial-decision.json");
    expect(receipt.evidenceBindings.globalVerification).toEqual(["evidence/misc/verifier-renamed.json"]);
    expect(receipt.evidenceBindings.cleanup).toEqual(["evidence/misc/cleanup-renamed.json"]);
  });

  it("includes leases released before CHILD_STARTED in the settled parent ledger", () => {
    const sealed = sealedFixture();
    sealed.model.events = sealed.model.events.map((item) => ({ ...item, sequence: item.sequence + 1 }));
    sealed.model.events.unshift(event(sealed.model.plan, 1, "ACTION_BLOCKED", {
      attemptId: "attempt-prestart",
      action: "workspace_creation",
      reason: "workspace_failed",
      leaseId: "lease-prestart",
      reservedUsd: 0.5,
      reservedTokens: 500,
      leaseState: "released",
      actualUsd: 0,
      actualTokens: 0
    }, { taskId: "task-a", agentId: "agent-a", childRunId: "child-prestart" }));

    const receipt = buildParentSwarmReceipt(sealed);
    expect(receipt.budgetLedger.leases).toEqual(expect.arrayContaining([
      expect.objectContaining({ leaseId: "lease-prestart", status: "released", reservedUsd: 0.5, reservedTokens: 500 })
    ]));
  });

  it("binds mutation-failed verifier evidence and rejects non-verified admissions", () => {
    const sealed = sealedFixture();
    sealed.model.events = sealed.model.events.map((item) => item.type === "GLOBAL_VERIFIER_PASSED"
      ? { ...item, type: "GLOBAL_VERIFIER_FAILED" as const }
      : item);
    const forgedAdmission = admission(sealed.model.plan, "candidate-a", "admitted", "admitted");
    forgedAdmission.receiptIntegrity = "tamper_detected";
    sealed.model.artifacts.push(
      { path: "evidence/misc/forged-admission.json", value: forgedAdmission },
      {
        path: "evidence/misc/mutation-failed-verifier.json",
        value: {
          schemaVersion: "martin.swarm.v1",
          swarmId: sealed.model.plan.swarmId,
          verificationId: "verify-a",
          commandState: "passed",
          mutationState: "mutated",
          integratedTreeHash: "b".repeat(64),
          parentPolicyVersion: sealed.model.plan.parentContract.policyVersion,
          baselineCommit: sealed.model.plan.baselineCommit,
          workspaceId: "workspace-verifier",
          commands: ["pnpm test"],
          startedAt: "2026-10-03T12:05:00.000Z",
          completedAt: "2026-10-03T12:05:01.000Z",
          subprocessResults: []
        }
      }
    );

    const receipt = buildParentSwarmReceipt(sealed);
    expect(receipt.evidenceBindings.admissions).not.toContain("evidence/misc/forged-admission.json");
    expect(receipt.evidenceBindings.globalVerification).toContain("evidence/misc/mutation-failed-verifier.json");
  });

  it.each([
    ["blocked field", (receipt: any) => { receipt.blockedActions[0].reason = "forged"; }],
    ["blocked order", (receipt: any) => { receipt.blockedActions.reverse(); }],
    ["reassignment field", (receipt: any) => { receipt.reassignments[0].toAgentId = "agent-c"; }],
    ["reassignment omission", (receipt: any) => { receipt.reassignments = []; }]
    ,["terminal task state", (receipt: any) => { receipt.tasks[0].status = "queued"; }]
    ,["terminal agent state", (receipt: any) => { receipt.agents[0].status = "queued"; }]
    ,["settled budget ledger", (receipt: any) => { receipt.budgetLedger.settledUsd = 0; }]
  ])("rejects %s mutation", (_name, mutate) => {
    const receipt = structuredClone(buildParentSwarmReceipt(sealedFixture()));
    mutate(receipt);
    expect(verifyParentSwarmReceipt(receipt)).toMatchObject({ ok: false });
  });

  it("fails closed when a terminal child completion is absent or unverified", () => {
    const missing = sealedFixture();
    missing.model.artifacts = missing.model.artifacts.filter((item) => !item.path.includes("child-completions"));
    expect(() => buildParentSwarmReceipt(missing)).toThrowError(expect.objectContaining({ code: "MISSING_CHILD_EVIDENCE" }));

    const unverified = sealedFixture();
    const completion = unverified.model.artifacts.find((item) => item.path.includes("child-completions"))!;
    (completion.value.receipt as any).integrity.state = "tamper_detected";
    expect(() => buildParentSwarmReceipt(unverified)).toThrowError(expect.objectContaining({ code: "UNVERIFIED_CHILD_EVIDENCE" }));
  });

  it.each(["stopped", "needs_review"] as const)("serializes canonical %s truth without promoting it", (state) => {
    const sealed = sealedFixture();
    sealed.index.outcome = { state, reason: `${state}-reason` };
    sealed.model.snapshot.outcome = structuredClone(sealed.index.outcome);
    sealed.model.events = sealed.model.events.filter((event) => !event.type.startsWith("GLOBAL_VERIFIER_"));
    const receipt = buildParentSwarmReceipt(sealed);
    expect(receipt.parentOutcome).toEqual({ state, reason: `${state}-reason` });
    expect(receipt.taskVerificationState).toBe("unknown");
    expect(verifyParentSwarmReceipt(receipt)).toEqual({ ok: true });
  });
});

function sealedFixture(): ReadAndSealSwarmEvidenceResult {
  const plan = createSwarmLivePlan({
    planId: "plan-parent-receipt", swarmId: "swarm-parent-receipt",
    workspaceId: "workspace-parent", projectId: "project-parent", baselineCommit: "a".repeat(40),
    parentContract: {
      policyVersion: "swarm-policy-v1", objective: "Ship one governed swarm",
      definitionOfDone: ["Global verification passes"],
      budget: { maxUsd: 2, softLimitUsd: 1.5, maxIterations: 4, maxTokens: 2000 },
      maxWallClockMs: 60_000, maxConcurrency: 2,
      scope: { allowedPaths: ["src/**"], deniedPaths: [".git/**"] },
      permissions: { networkDomains: [], commands: ["pnpm test"] },
      integrationStrategy: "parent_fan_in", globalVerifierStack: [{ command: "pnpm test", type: "test_full" }],
      stopPolicy: { budgetExhausted: "stop", blockingFailure: "needs_review", verifierFailure: "stop" },
      recoveryPolicy: { maxReassignmentsPerTask: 1, dependencyWaiversAllowed: false },
      approvalPolicy: {}, orchestrationStrategy: "hierarchical_dag"
    },
    tasks: [{
      taskId: "task-a", title: "Task A", objective: "Implement A", required: true,
      dependsOn: [], assignedAgentId: "agent-a", status: "accepted", mutationMode: "write", writeScope: ["src/a.ts"]
    }],
    agents: [{
      agentId: "agent-a", role: "worker", status: "verified",
      contract: {
        agentId: "agent-a", taskIds: ["task-a"],
        scope: { allowedPaths: ["src/**"], deniedPaths: [".git/**"] },
        budget: { maxUsd: 1, softLimitUsd: 0.8, maxIterations: 2, maxTokens: 1000 },
        maxWallClockMs: 30_000, permissions: { networkDomains: [], commands: ["pnpm test"] },
        approvalPolicy: {}, verifierAuthority: "child_only"
      }
    }],
    engine: { engine: "codex", model: "gpt-test" }, childMaxIterations: 2,
    createdAt: "2026-10-03T12:00:00.000Z"
  });
  const events: SwarmLiveEvent[] = [
    event(plan, 1, "CHILD_STARTED", { attemptId: "attempt-a", leaseId: "lease-a", reservedUsd: 1, reservedTokens: 1000 }, { taskId: "task-a", agentId: "agent-a", childRunId: "child-a" }),
    event(plan, 2, "CHILD_VERIFIED", { reason: "passed", leaseState: "settled", actualUsd: 0.25, actualTokens: 30 }, { taskId: "task-a", agentId: "agent-a", childRunId: "child-a" }),
    event(plan, 3, "CHILD_PATCH_ADMITTED", { candidateId: "candidate-a" }, { taskId: "task-a", agentId: "agent-a", childRunId: "child-a" }),
    event(plan, 4, "CHILD_PATCH_REJECTED", { candidateId: "candidate-b" }, { taskId: "task-a", agentId: "agent-a", childRunId: "child-a" }),
    event(plan, 5, "INTEGRATION_CONFLICT", { candidateId: "candidate-c" }, { taskId: "task-a", agentId: "agent-a", childRunId: "child-a" }),
    event(plan, 6, "ACTION_BLOCKED" as SwarmLiveEvent["type"], { attemptId: "attempt-a", action: "write:secret", reason: "scope_denied" }, { taskId: "task-a", agentId: "agent-a", childRunId: "child-a" }),
    event(plan, 7, "TASK_REASSIGNED", {
      fromAgentId: "agent-a", toAgentId: "agent-b", fromAttemptId: "attempt-a", toAttemptId: "attempt-b", reason: "scope_denied"
    }, { taskId: "task-a" }),
    event(plan, 8, "ACTION_BLOCKED" as SwarmLiveEvent["type"], { attemptId: "attempt-b", action: "integrate", reason: "conflict" }, { taskId: "task-a", agentId: "agent-b" }),
    event(plan, 9, "GLOBAL_VERIFIER_PASSED", { verificationId: "verify-a", integratedTreeHash: "b".repeat(64) }),
    event(plan, 10, "SWARM_VERIFIED", { reason: "verified", parentPipelineAuthority: "runParentSwarmPipeline:v1", parentPipelineResultSha256: "c".repeat(64) })
  ];
  const files = [
    file("evidence/child-completions/child.json", "1"),
    file("child-a/receipt-integrity.json", "2"),
    file("evidence/decisions/opaque-a.json", "3"),
    file("evidence/decisions/opaque-b.json", "3b"),
    file("evidence/integration-outcomes/opaque-c.json", "4"),
    file("evidence/global-verification/verify.json", "5"),
    file("evidence/cleanup/cleanup.json", "6"),
    file("events.jsonl", "7"), file("snapshot.json", "8")
  ];
  const index = {
    schemaVersion: "martin.swarm-evidence-index.v1" as const,
    swarmId: plan.swarmId, planHash: plan.planHash, revision: 10,
    outcome: { state: "verified" as const, reason: "verified", verifiedAt: "2026-10-03T12:07:00.000Z" },
    sealedAt: "2026-10-03T12:07:00.000Z", files
  };
  return {
    index,
    indexPath: "C:/runs/_swarms/swarm-parent-receipt/evidence/evidence-index.json",
    indexBytes: `${JSON.stringify(index, null, 2)}\n`,
    model: {
      plan,
      events,
      snapshot: { ...index, schemaVersion: "martin.swarm.v1", lastSequence: 10, eventCount: 10, updatedAt: index.sealedAt },
      artifacts: [{
        path: "evidence/child-completions/child.json",
        value: {
          swarmId: plan.swarmId, childRunId: "child-a", agentId: "agent-a", attemptId: "attempt-a", taskIds: ["task-a"],
          receipt: { integrity: { state: "verified" }, bindingSha256: "d".repeat(64) }
        }
      }, {
        path: "evidence/decisions/opaque-a.json",
        value: admission(plan, "candidate-a", "admitted", "admitted")
      }, {
        path: "evidence/decisions/opaque-b.json",
        value: admission(plan, "candidate-b", "rejected", "path_denied")
      }, {
        path: "evidence/integration-outcomes/opaque-c.json",
        value: {
          swarmId: plan.swarmId,
          decision: admission(plan, "candidate-c", "rejected", "integration_conflict"),
          event: persistedEvent(events.find((item) => item.payload.candidateId === "candidate-c")!),
          conflict: { conflictId: "conflict-a" }
        }
      }]
    }
  } as unknown as ReadAndSealSwarmEvidenceResult;
}

function event(
  plan: ReturnType<typeof createSwarmLivePlan>, sequence: number, type: SwarmLiveEvent["type"],
  payload: Record<string, unknown>, ids: Partial<Pick<SwarmLiveEvent, "taskId" | "agentId" | "childRunId">> = {}
): SwarmLiveEvent {
  return {
    schemaVersion: "martin.swarm.v1", sequence, idempotencyKey: `event-${sequence}`, type,
    swarmId: plan.swarmId, timestamp: `2026-10-03T12:0${sequence}:00.000Z`,
    parentPolicyVersion: plan.parentContract.policyVersion, planHash: plan.planHash,
    ...ids, payload
  };
}

function file(path: string, seed: string) {
  return { kind: "artifact" as const, path, sha256: createHash("sha256").update(seed).digest("hex"), bytes: 1 };
}

function admission(
  plan: ReturnType<typeof createSwarmLivePlan>,
  candidateId: string,
  state: "admitted" | "rejected",
  reasonCode: string
) {
  return {
    schemaVersion: "martin.swarm.v1",
    admissionId: `admission-${candidateId}`,
    candidateId,
    swarmId: plan.swarmId,
    workspaceId: "workspace-child-a",
    childRunId: "child-a",
    agentId: "agent-a",
    taskIds: ["task-a"],
    baselineCommit: plan.baselineCommit,
    changedPaths: ["src/a.ts"],
    state,
    reasonCode,
    receiptIntegrity: "verified",
    decidedAt: "2026-10-03T12:02:00.000Z"
  };
}

function persistedEvent(value: SwarmLiveEvent) {
  return {
    type: value.type,
    swarmId: value.swarmId,
    timestamp: value.timestamp,
    parentPolicyVersion: value.parentPolicyVersion,
    ...(value.taskId ? { taskId: value.taskId } : {}),
    ...(value.agentId ? { agentId: value.agentId } : {}),
    ...(value.childRunId ? { childRunId: value.childRunId } : {}),
    ...(value.failureClass ? { failureClass: value.failureClass } : {}),
    payload: structuredClone(value.payload)
  };
}
