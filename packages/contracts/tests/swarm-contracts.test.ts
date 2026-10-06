import { describe, expect, it } from "vitest";

import {
  FAILURE_CLASSES,
  SWARM_EVENT_TYPES,
  SWARM_SCHEMA_VERSION,
  computeSwarmLivePlanHash,
  createSwarmLivePlan,
  createSwarmRunRecord,
  normalizeSwarmPathPattern,
  swarmConcretePathMatchesPattern,
  swarmPathPatternContains,
  swarmPathPatternsOverlap,
  validateSwarmConcretePath,
  validateSwarmChildReceiptLink,
  validateSwarmDeterministicDemoReceiptEvidence,
  validateSwarmChildContract,
  validateSwarmLiveEvent,
  validateSwarmLivePlan,
  validateSwarmLiveRevision,
  validateSwarmParentContract,
  validateSwarmRunRecord
} from "../src/index.js";
import type {
  SwarmChildContract,
  SwarmCandidate,
  SwarmCleanupRecord,
  SwarmConflictRecord,
  SwarmDeterministicDemoReceiptEvidence,
  SwarmGlobalVerification,
  SwarmLivePlanDraft,
  SwarmParentContract,
  SwarmPatchAdmission,
  SwarmRunDraft,
  SwarmWorkspaceRecord
} from "../src/index.js";

const parent: SwarmParentContract = {
  policyVersion: "swarm-policy/1",
  objective: "Deliver one integrated result from bounded workers.",
  definitionOfDone: ["All required tasks accepted", "Global verifier passes"],
  budget: {
    maxUsd: 12,
    softLimitUsd: 9,
    maxIterations: 30,
    maxTokens: 120_000
  },
  maxWallClockMs: 900_000,
  maxConcurrency: 5,
  scope: {
    allowedPaths: ["packages/**", "docs/**"],
    deniedPaths: ["packages/private/**", "**/.env"]
  },
  permissions: {
    networkDomains: ["api.github.com", "registry.npmjs.org"],
    commands: ["pnpm test", "pnpm lint"]
  },
  integrationStrategy: "parent_fan_in",
  globalVerifierStack: [
    { command: "pnpm test", type: "test_full" },
    { command: "pnpm lint", type: "lint" }
  ],
  stopPolicy: {
    budgetExhausted: "stop",
    blockingFailure: "needs_review",
    verifierFailure: "stop"
  },
  recoveryPolicy: {
    maxReassignmentsPerTask: 1,
    dependencyWaiversAllowed: true
  },
  approvalPolicy: {
    dependencyAdds: false,
    migrations: false,
    configChanges: true,
    externalWrites: false
  },
  orchestrationStrategy: "hierarchical_dag"
};

describe("swarm child receipt linkage", () => {
  it("accepts exact non-empty lineage with unique task IDs", () => {
    expect(validateSwarmChildReceiptLink({
      parentSwarmId: "swarm-live-001",
      agentId: "agent-builder",
      attemptId: "attempt-task-a-001",
      taskIds: ["task-a", "task-b"]
    })).toEqual({ ok: true, errors: [] });
  });

  it.each([
    [{ parentSwarmId: "", agentId: "agent-a", attemptId: "attempt-a", taskIds: ["task-a"] }, "parentSwarmId"],
    [{ parentSwarmId: "swarm-a", agentId: "", attemptId: "attempt-a", taskIds: ["task-a"] }, "agentId"],
    [{ parentSwarmId: "swarm-a", agentId: "agent-a", attemptId: "", taskIds: ["task-a"] }, "attemptId"],
    [{ parentSwarmId: "swarm-a", agentId: "agent-a", attemptId: "attempt-a", taskIds: [] }, "taskIds"],
    [{ parentSwarmId: "swarm-a", agentId: "agent-a", attemptId: "attempt-a", taskIds: ["task-a", ""] }, "taskIds[1]"],
    [{ parentSwarmId: "swarm-a", agentId: "agent-a", attemptId: "attempt-a", taskIds: ["task-a", "task-a"] }, "taskIds"]
  ])("rejects malformed lineage at %s", (link, path) => {
    expect(validateSwarmChildReceiptLink(link)).toMatchObject({
      ok: false,
      errors: expect.arrayContaining([expect.objectContaining({ path })])
    });
  });
});

const child: SwarmChildContract = {
  agentId: "agent-01",
  taskIds: ["task-contracts"],
  scope: {
    allowedPaths: ["packages/contracts/**"],
    deniedPaths: ["packages/private/**", "**/.env"]
  },
  budget: {
    maxUsd: 1.5,
    softLimitUsd: 1,
    maxIterations: 4,
    maxTokens: 12_000
  },
  maxWallClockMs: 120_000,
  permissions: {
    networkDomains: ["api.github.com"],
    commands: ["pnpm test"]
  },
  approvalPolicy: {
    dependencyAdds: false,
    migrations: false,
    configChanges: false,
    externalWrites: false
  },
  verifierAuthority: "child_only"
};

const draft = (): SwarmRunDraft => ({
  swarmId: "swarm-001",
  workspaceId: "ws-001",
  projectId: "project-001",
  parentContract: parent,
  tasks: [
    {
      taskId: "task-contracts",
      title: "Build contracts",
      objective: "Implement swarm contracts.",
      required: true,
      dependsOn: [],
      assignedAgentId: "agent-01",
      status: "queued",
      mutationMode: "write",
      writeScope: ["packages/contracts/**"]
    }
  ],
  agents: [
    {
      agentId: "agent-01",
      role: "Contracts",
      status: "queued",
      childRunId: "loop-child-001",
      contract: child
    }
  ]
});

const livePlanDraft = (): SwarmLivePlanDraft => ({
  planId: "plan-001",
  swarmId: "swarm-live-001",
  workspaceId: "ws-live-001",
  projectId: "project-live-001",
  baselineCommit: "0123456789abcdef0123456789abcdef01234567",
  parentContract: parent,
  tasks: draft().tasks,
  agents: draft().agents,
  engine: {
    engine: "codex",
    model: "gpt-5-codex"
  },
  childMaxIterations: 4,
  createdAt: "2026-10-03T12:00:00.000Z"
});

describe("live swarm plan authority", () => {
  it("binds one concrete engine and every pre-spend authority surface to a canonical hash", () => {
    const plan = createSwarmLivePlan(livePlanDraft());

    expect(validateSwarmLivePlan(plan)).toEqual({ ok: true, errors: [] });
    expect(plan.schemaVersion).toBe(SWARM_SCHEMA_VERSION);
    expect(plan.planHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(computeSwarmLivePlanHash(plan)).toBe(plan.planHash);

    for (const mutate of [
      (value: typeof plan) => ({ ...value, baselineCommit: "1123456789abcdef0123456789abcdef01234567" }),
      (value: typeof plan) => ({ ...value, engine: { ...value.engine, model: "gpt-5.1-codex" } }),
      (value: typeof plan) => ({ ...value, childMaxIterations: value.childMaxIterations + 1 }),
      (value: typeof plan) => ({
        ...value,
        parentContract: { ...value.parentContract, maxConcurrency: value.parentContract.maxConcurrency + 1 }
      }),
      (value: typeof plan) => ({
        ...value,
        parentContract: {
          ...value.parentContract,
          scope: { ...value.parentContract.scope, allowedPaths: ["packages/core/**"] }
        }
      }),
      (value: typeof plan) => ({
        ...value,
        parentContract: {
          ...value.parentContract,
          globalVerifierStack: [{ command: "pnpm test --changed", type: "test_targeted" as const }]
        }
      }),
      (value: typeof plan) => ({
        ...value,
        parentContract: {
          ...value.parentContract,
          budget: { ...value.parentContract.budget, maxUsd: value.parentContract.budget.maxUsd + 1 }
        }
      }),
      (value: typeof plan) => ({
        ...value,
        tasks: value.tasks.map((task, index) => index === 0 ? { ...task, dependsOn: ["new-dependency"] } : task)
      })
    ]) {
      const changed = mutate(plan);
      const result = validateSwarmLivePlan(changed);
      expect(result.ok).toBe(false);
      expect(result.errors).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: "LIVE_PLAN_HASH_MISMATCH" })
      ]));
    }
  });

  it.each(["claude", "codex", "gemini", "openai"] as const)(
    "accepts %s as one concrete live engine without changing plan authority",
    (engine) => {
      const plan = createSwarmLivePlan({
        ...livePlanDraft(),
        engine: { engine, model: `${engine}-model` },
      });
      expect(validateSwarmLivePlan(plan)).toEqual({ ok: true, errors: [] });
    },
  );

  it("rejects auto, proof, stub, fallback, and multiple-engine live profiles", () => {
    for (const engine of ["auto", "proof", "stub", "fallback", "codex,claude"]) {
      const result = validateSwarmLivePlan(createSwarmLivePlan({
        ...livePlanDraft(),
        engine: { engine: engine as never, model: "test-model" }
      }));
      expect(result.ok).toBe(false);
      expect(result.errors).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: "INVALID_LIVE_ENGINE" })
      ]));
    }
  });

  it("validates monotonic revisions and rejects invented failure classes in live events", () => {
    expect(validateSwarmLiveRevision(0)).toBe(true);
    expect(validateSwarmLiveRevision(42)).toBe(true);
    expect(validateSwarmLiveRevision(-1)).toBe(false);
    expect(validateSwarmLiveRevision(1.5)).toBe(false);
    expect(validateSwarmLiveRevision(Number.POSITIVE_INFINITY)).toBe(false);

    const plan = createSwarmLivePlan(livePlanDraft());
    const event = {
      schemaVersion: SWARM_SCHEMA_VERSION,
      sequence: 1,
      idempotencyKey: "attempt-001:terminal",
      type: "CHILD_STOPPED" as const,
      swarmId: plan.swarmId,
      timestamp: "2026-10-03T12:01:00.000Z",
      parentPolicyVersion: plan.parentContract.policyVersion,
      planHash: plan.planHash,
      agentId: "agent-01",
      taskId: "task-contracts",
      childRunId: "loop-child-001",
      failureClass: "verification_failure" as const,
      payload: {}
    };
    expect(validateSwarmLiveEvent(event, plan)).toEqual({ ok: true, errors: [] });
    expect(validateSwarmLiveEvent({ ...event, failureClass: "dependency_blocked" as never }, plan).ok).toBe(false);
    expect(FAILURE_CLASSES).not.toContain("dependency_blocked");
  });
});

describe("swarm parent and child authority", () => {
  it("models the LaunchBoard demo as one canonical hybrid orchestration strategy", () => {
    const hybridParent: SwarmParentContract = {
      ...parent,
      orchestrationStrategy: "hybrid"
    };

    expect(validateSwarmParentContract(hybridParent)).toEqual({ ok: true, errors: [] });
    expect(hybridParent.orchestrationStrategy).toBe("hybrid");
    expect(validateSwarmParentContract({
      ...hybridParent,
      orchestrationStrategy: "invented" as never
    })).toMatchObject({
      ok: false,
      errors: [expect.objectContaining({ code: "INVALID_ORCHESTRATION_STRATEGY" })]
    });
  });

  it("keeps deterministic demo binding separate from unevaluated signed integrity", () => {
    const evidence: SwarmDeterministicDemoReceiptEvidence = {
      evidenceKind: "deterministic_demo",
      swarmId: "swarm-001",
      agentId: "agent-01",
      taskIds: ["task-contracts"],
      childRunId: "loop-child-001",
      referentialBinding: "passed",
      signedIntegrity: "not_evaluated"
    };

    expect(evidence).toMatchObject({
      referentialBinding: "passed",
      signedIntegrity: "not_evaluated"
    });
    expect(evidence.referentialBinding).not.toBe(evidence.signedIntegrity);
    expect(validateSwarmDeterministicDemoReceiptEvidence(evidence)).toEqual({
      ok: true,
      errors: []
    });
    expect(validateSwarmDeterministicDemoReceiptEvidence({
      ...evidence,
      signedIntegrity: "passed" as never
    })).toMatchObject({
      ok: false,
      errors: [expect.objectContaining({ code: "DEMO_SIGNED_INTEGRITY_FORBIDDEN" })]
    });
    expect(validateSwarmDeterministicDemoReceiptEvidence({
      ...evidence,
      taskIds: ["task-contracts", "task-contracts"]
    })).toMatchObject({
      ok: false,
      errors: [expect.objectContaining({ code: "INVALID_DEMO_TASK_BINDING" })]
    });
  });

  it("accepts the complete bounded parent contract", () => {
    expect(validateSwarmParentContract(parent)).toEqual({ ok: true, errors: [] });
  });

  it("accepts a child contract that is a strict authority subset", () => {
    expect(validateSwarmChildContract(parent, child)).toEqual({ ok: true, errors: [] });
  });

  it.each([
    ["path scope", { scope: { ...child.scope, allowedPaths: ["scripts/**"] } }, "CHILD_SCOPE_WIDENED"],
    ["denied paths", { scope: { ...child.scope, deniedPaths: ["**/.env"] } }, "CHILD_DENIAL_DROPPED"],
    ["cost budget", { budget: { ...child.budget, maxUsd: 13 } }, "CHILD_BUDGET_WIDENED"],
    ["token budget", { budget: { ...child.budget, maxTokens: 120_001 } }, "CHILD_BUDGET_WIDENED"],
    ["iteration budget", { budget: { ...child.budget, maxIterations: 31 } }, "CHILD_BUDGET_WIDENED"],
    ["wall clock", { maxWallClockMs: 900_001 }, "CHILD_WALL_CLOCK_WIDENED"],
    ["network permission", { permissions: { ...child.permissions, networkDomains: ["example.com"] } }, "CHILD_NETWORK_WIDENED"],
    ["command permission", { permissions: { ...child.permissions, commands: ["git push"] } }, "CHILD_COMMAND_WIDENED"],
    ["approval authority", { approvalPolicy: { ...child.approvalPolicy, dependencyAdds: true } }, "CHILD_APPROVAL_WIDENED"],
    ["verifier authority", { verifierAuthority: "parent_global" }, "CHILD_GLOBAL_VERIFIER_FORBIDDEN"]
  ] as const)("rejects child %s widening with a structured error", (_name, override, code) => {
    const result = validateSwarmChildContract(parent, {
      ...child,
      ...override
    } as SwarmChildContract);

    expect(result.ok).toBe(false);
    expect(result.errors).toEqual(expect.arrayContaining([expect.objectContaining({ code })]));
  });

  it("rejects invalid parent concurrency and budget values", () => {
    const result = validateSwarmParentContract({
      ...parent,
      maxConcurrency: 0,
      budget: { ...parent.budget, maxUsd: Number.NaN }
    });

    expect(result.ok).toBe(false);
    expect(result.errors.map((error) => error.code)).toEqual(
      expect.arrayContaining(["INVALID_CONCURRENCY", "INVALID_BUDGET"])
    );
  });

  it("treats a finite child token cap as narrowing an uncapped parent", () => {
    const uncappedParent: SwarmParentContract = {
      ...parent,
      budget: {
        maxUsd: parent.budget.maxUsd,
        softLimitUsd: parent.budget.softLimitUsd,
        maxIterations: parent.budget.maxIterations
      }
    };

    expect(validateSwarmChildContract(uncappedParent, child)).toEqual({ ok: true, errors: [] });
  });

  it("rejects an uncapped child token budget under a finite parent cap", () => {
    const uncappedChild: SwarmChildContract = {
      ...child,
      budget: {
        maxUsd: child.budget.maxUsd,
        softLimitUsd: child.budget.softLimitUsd,
        maxIterations: child.budget.maxIterations
      }
    };

    expect(validateSwarmChildContract(parent, uncappedChild)).toMatchObject({
      ok: false,
      errors: [expect.objectContaining({ code: "CHILD_BUDGET_WIDENED" })]
    });
  });
});

describe("canonical swarm path patterns", () => {
  it("canonicalizes portable relative patterns before matching", () => {
    expect(normalizeSwarmPathPattern("packages\\contracts\\**")).toEqual({
      ok: true,
      value: "packages/contracts/**"
    });
    expect(swarmPathPatternContains("packages/**", "packages\\contracts\\src\\**")).toBe(true);
    expect(swarmPathPatternsOverlap("packages/contracts/**", "packages\\contracts\\src\\**")).toBe(true);
  });

  it.each([
    "",
    "/packages/**",
    "C:/packages/**",
    "C:\\packages\\**",
    "../packages/**",
    "packages/../private/**",
    "./packages/**",
    "packages//core/**",
    "packages/co**re/**",
    "packages/[core]/**",
    "packages/core/"
  ])("rejects unsafe or malformed pattern %j", (pattern) => {
    expect(normalizeSwarmPathPattern(pattern)).toMatchObject({ ok: false });
  });

  it("fails parent and child contract validation closed on invalid path patterns", () => {
    expect(validateSwarmParentContract({
      ...parent,
      scope: { ...parent.scope, allowedPaths: ["../packages/**"] }
    })).toMatchObject({
      ok: false,
      errors: [expect.objectContaining({ code: "INVALID_SCOPE_PATTERN" })]
    });

    expect(validateSwarmChildContract(parent, {
      ...child,
      scope: { ...child.scope, allowedPaths: ["C:/packages/**"] }
    })).toMatchObject({
      ok: false,
      errors: expect.arrayContaining([expect.objectContaining({ code: "INVALID_SCOPE_PATTERN" })])
    });
  });
});

describe("Phase 3 isolation and integration evidence", () => {
  it("keeps workspace, candidate, admission, verification, conflict, and cleanup evidence versioned and distinct", () => {
    const workspace = {
      schemaVersion: SWARM_SCHEMA_VERSION,
      workspaceId: "workspace-child-01",
      swarmId: "swarm-001",
      kind: "child",
      baselineCommit: "a".repeat(40),
      state: "active",
      createdAt: "2026-10-02T12:00:00.000Z",
      childRunId: "loop-child-001",
      agentId: "agent-01",
      taskIds: ["task-contracts"]
    } satisfies SwarmWorkspaceRecord;
    const candidate = {
      schemaVersion: SWARM_SCHEMA_VERSION,
      candidateId: "candidate-001",
      swarmId: workspace.swarmId,
      workspaceId: workspace.workspaceId,
      childRunId: workspace.childRunId,
      agentId: workspace.agentId,
      taskIds: workspace.taskIds,
      baselineCommit: workspace.baselineCommit,
      patchSha256: "b".repeat(64),
      changedPaths: ["packages/contracts/src/swarm.ts"],
      createdAt: "2026-10-02T12:01:00.000Z"
    } satisfies SwarmCandidate;
    const admission = {
      schemaVersion: SWARM_SCHEMA_VERSION,
      admissionId: "admission-001",
      candidateId: candidate.candidateId,
      swarmId: candidate.swarmId,
      workspaceId: candidate.workspaceId,
      childRunId: candidate.childRunId,
      agentId: candidate.agentId,
      taskIds: candidate.taskIds,
      baselineCommit: candidate.baselineCommit,
      changedPaths: candidate.changedPaths,
      state: "admitted",
      reasonCode: "admitted",
      receiptIntegrity: "verified",
      decidedAt: "2026-10-02T12:02:00.000Z",
      preIntegrationTreeHash: "c".repeat(40),
      postIntegrationTreeHash: "d".repeat(40)
    } satisfies SwarmPatchAdmission;
    const verification = {
      schemaVersion: SWARM_SCHEMA_VERSION,
      verificationId: "global-verification-001",
      swarmId: candidate.swarmId,
      workspaceId: "workspace-verifier-01",
      parentPolicyVersion: parent.policyVersion,
      baselineCommit: candidate.baselineCommit,
      integratedTreeHash: admission.postIntegrationTreeHash,
      commands: ["pnpm test", "pnpm lint"],
      commandState: "failed",
      mutationState: "clean",
      startedAt: "2026-10-02T12:03:00.000Z",
      completedAt: "2026-10-02T12:04:00.000Z",
      subprocessResults: [{
        command: "pnpm test",
        launched: true,
        completed: true,
        timedOut: false,
        exitCode: 1,
        startedAt: "2026-10-02T12:03:00.000Z",
        completedAt: "2026-10-02T12:04:00.000Z"
      }]
    } satisfies SwarmGlobalVerification;
    const conflict = {
      schemaVersion: SWARM_SCHEMA_VERSION,
      conflictId: "conflict-001",
      taskIds: candidate.taskIds,
      paths: candidate.changedPaths,
      state: "blocking",
      candidateId: candidate.candidateId,
      childRunId: candidate.childRunId,
      agentId: candidate.agentId,
      preIntegrationTreeHash: admission.preIntegrationTreeHash,
      recordedAt: "2026-10-02T12:02:00.000Z",
      diagnostic: "patch does not apply"
    } satisfies SwarmConflictRecord;
    const cleanup = {
      schemaVersion: SWARM_SCHEMA_VERSION,
      cleanupId: "cleanup-001",
      swarmId: candidate.swarmId,
      workspaceId: workspace.workspaceId,
      workspaceKind: workspace.kind,
      ownedProcessId: 321,
      evidencePersisted: true,
      processCloseState: "closed",
      removalState: "removed",
      state: "completed",
      attemptedAt: "2026-10-02T12:05:00.000Z",
      completedAt: "2026-10-02T12:05:01.000Z"
    } satisfies SwarmCleanupRecord;

    expect(candidate).toMatchObject({
      candidateId: "candidate-001",
      baselineCommit: "a".repeat(40),
      patchSha256: "b".repeat(64),
      changedPaths: ["packages/contracts/src/swarm.ts"]
    });
    expect(admission).toMatchObject({
      state: "admitted",
      receiptIntegrity: "verified"
    });
    expect(admission).not.toHaveProperty("taskVerification");
    expect(admission).not.toHaveProperty("globalVerification");
    expect(verification).toMatchObject({ commandState: "failed", mutationState: "clean" });
    expect(admission.receiptIntegrity).toBe("verified");
    expect(verification.commandState).toBe("failed");
    expect(conflict).toMatchObject({ state: "blocking", candidateId: candidate.candidateId });
    expect(cleanup).toMatchObject({
      evidencePersisted: true,
      processCloseState: "closed",
      removalState: "removed",
      state: "completed"
    });
    expect(cleanup).not.toHaveProperty("path");
  });

  it.each([
    "packages/contracts/src/swarm.ts",
    "docs/Release Notes/na\u00efve file.md",
    "src/\u6570\u636e/\u03b4elta.ts"
  ])("accepts normalized concrete repository path %j", (path) => {
    expect(validateSwarmConcretePath(path)).toEqual({ ok: true, value: path });
  });

  it.each([
    "",
    "\u0000",
    "src/has\u0000nul.ts",
    "../outside",
    "src/../outside",
    "./src/index.ts",
    "/outside",
    "C:/outside",
    "C:\\outside",
    "//server/share",
    "\\\\server\\share",
    ".git/config",
    "src/.GIT/config",
    "src//index.ts",
    "src/index.ts/",
    "src\\index.ts",
    "src/e\u0301.ts"
  ])("rejects unsafe or non-normalized concrete path %j", (path) => {
    expect(validateSwarmConcretePath(path)).toMatchObject({ ok: false });
  });

  it.each([
    ["packages/contracts/src/swarm.ts", "packages/contracts/src/swarm.ts", true],
    ["packages/contracts/src/swarm.ts", "packages/*/src/*", true],
    ["packages/contracts/src/swarm.ts", "packages/**", true],
    ["packages/contracts/src/swarm.ts", "**/swarm.ts", true],
    ["packages/contracts/src/swarm.ts", "packages/core/**", false],
    ["packages/contracts/src/swarm.ts", "packages/**/test/*.ts", false],
    ["packages/contracts/src/swarm.ts", "packages/[contracts]/**", false],
    ["../outside", "**", false]
  ])("matches concrete path %j against pattern %j as %j", (path, pattern, expected) => {
    expect(swarmConcretePathMatchesPattern(path, pattern)).toBe(expected);
  });

  it("supports explicit deny-wins evaluation", () => {
    const path = "packages/contracts/private/key.ts";
    const allowed = ["packages/**"];
    const denied = ["packages/**/private/**", "**/.env"];
    const admitted = allowed.some((pattern) => swarmConcretePathMatchesPattern(path, pattern))
      && !denied.some((pattern) => swarmConcretePathMatchesPattern(path, pattern));

    expect(admitted).toBe(false);
  });
});

describe("swarm records and events", () => {
  it("creates a versioned record linked to ordinary child LoopRecord identifiers", () => {
    const record = createSwarmRunRecord(draft(), {
      now: "2026-10-02T12:00:00.000Z"
    });

    expect(record.schemaVersion).toBe(SWARM_SCHEMA_VERSION);
    expect(record.agents[0]?.childRunId).toBe("loop-child-001");
    expect(record.outcome.state).toBe("running");
    expect(record.budgetLedger.leases).toEqual([]);
  });

  it("preserves an uncapped parent token budget without inventing a zero cap", () => {
    const value = draft();
    value.parentContract = {
      ...value.parentContract,
      budget: {
        maxUsd: value.parentContract.budget.maxUsd,
        softLimitUsd: value.parentContract.budget.softLimitUsd,
        maxIterations: value.parentContract.budget.maxIterations
      }
    };

    const record = createSwarmRunRecord(value);

    expect(record.budgetLedger.capTokens).toBeUndefined();
  });

  it("stores parent-issued dependency waivers as policy-bound records", () => {
    const value = draft();
    value.tasks.unshift({
      taskId: "task-planning",
      title: "Planning",
      objective: "Produce the approved plan.",
      required: true,
      dependsOn: [],
      status: "rejected",
      mutationMode: "read_only",
      writeScope: []
    });
    value.tasks[1]!.dependsOn = ["task-planning"];
    value.dependencyWaivers = [{
      taskId: "task-contracts",
      dependencyTaskId: "task-planning",
      parentPolicyVersion: "swarm-policy/1",
      approvedBy: "owner-001",
      approvedAt: "2026-10-02T12:00:00.000Z"
    }];

    const record = createSwarmRunRecord(value);

    expect(record.dependencyWaivers).toEqual(value.dependencyWaivers);
  });

  it("rejects duplicate task and agent identifiers", () => {
    const value = draft();
    value.tasks.push({ ...value.tasks[0]! });
    value.agents.push({ ...value.agents[0]! });
    const result = validateSwarmRunRecord(createSwarmRunRecord(value));

    expect(result.ok).toBe(false);
    expect(result.errors.map((error) => error.code)).toEqual(
      expect.arrayContaining(["DUPLICATE_TASK_ID", "DUPLICATE_AGENT_ID"])
    );
  });

  it("rejects blank workspace and project identities on a swarm record", () => {
    const record = createSwarmRunRecord({
      ...draft(),
      workspaceId: " ",
      projectId: ""
    });

    const result = validateSwarmRunRecord(record);

    expect(result.ok).toBe(false);
    expect(result.errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "workspaceId" }),
      expect.objectContaining({ path: "projectId" })
    ]));
  });

  it("defines the complete v1 orchestration event vocabulary", () => {
    expect(SWARM_EVENT_TYPES).toEqual([
      "SWARM_CREATED",
      "SWARM_PLAN_CREATED",
      "SWARM_PLAN_APPROVED",
      "TASK_READY",
      "TASK_ASSIGNED",
      "CHILD_STARTED",
      "CHILD_PROGRESS",
      "CHILD_VERIFIER_STARTED",
      "CHILD_VERIFIED",
      "CHILD_STOPPED",
      "CHILD_NEEDS_REVIEW",
      "CHILD_PATCH_PROPOSED",
      "CHILD_PATCH_REJECTED",
      "CHILD_PATCH_ADMITTED",
      "ACTION_BLOCKED",
      "TASK_REASSIGNED",
      "DEPENDENCY_SATISFIED",
      "INTEGRATION_STARTED",
      "INTEGRATION_CONFLICT",
      "INTEGRATION_COMPLETED",
      "GLOBAL_VERIFIER_STARTED",
      "GLOBAL_VERIFIER_PASSED",
      "GLOBAL_VERIFIER_FAILED",
      "SWARM_CANCEL_REQUESTED",
      "SWARM_STOPPED",
      "SWARM_NEEDS_REVIEW",
      "SWARM_VERIFIED"
    ]);
  });

  it("requires parent event identity while retaining optional task, agent, and child links", () => {
    const record = createSwarmRunRecord(draft(), {
      now: "2026-10-02T12:00:00.000Z"
    });
    const event = record.events[0]!;

    expect(event).toMatchObject({
      type: "SWARM_CREATED",
      swarmId: "swarm-001",
      timestamp: "2026-10-02T12:00:00.000Z",
      parentPolicyVersion: "swarm-policy/1"
    });
    expect(event.taskId).toBeUndefined();
    expect(event.agentId).toBeUndefined();
    expect(event.childRunId).toBeUndefined();
  });
});
