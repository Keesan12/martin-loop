import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  SWARM_SCHEMA_VERSION,
  type ReceiptIntegritySummary,
  type SwarmCleanupRecord,
  type SwarmGlobalVerification,
  type SwarmPatchAdmission,
  type SwarmRunRecord,
  type VerificationStep
} from "@martin/contracts";
import { afterEach, describe, expect, it } from "vitest";

import type { PersistedSwarmCandidateArtifact } from "../src/swarm/candidates.js";
import {
  createSwarmLifecycleController,
  type ActiveSwarmChildRegistration,
  type SwarmLifecyclePreCleanupEvidence
} from "../src/swarm/lifecycle.js";
import type {
  SwarmIntegrationEvidenceBundle,
  SwarmIntegrationReconstruction
} from "../src/swarm/integration.js";
import * as publicCoreApi from "../src/index.js";
import {
  runParentSwarmPipeline,
  type ParentSwarmPipelineEvidenceStore,
  type PersistedSwarmChildCompletionEvidence,
  type SwarmPipelineWorkspaceFailureEvidence
} from "../src/index.js";
import { isAuthorizedParentSwarmPipelineResult } from "../src/swarm/index.js";
import {
  verifyIntegratedSwarmResult,
  type SwarmGlobalVerificationEvidenceStore,
  type SwarmVerifierExecutionRequest,
  type SwarmVerifierExecutionResult
} from "../src/swarm/verification.js";
import {
  createSwarmWorkspaceManager,
  type SwarmWorkspaceManager,
  type SwarmWorkspaceRuntimeHandle
} from "../src/swarm/workspaces.js";

const scratchRoots: string[] = [];

afterEach(async () => {
  await Promise.all(scratchRoots.splice(0).map((root) => rm(root, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 50
  })));
});

describe("fresh swarm global verification", () => {
  it("reconstructs admitted artifacts in recorded order and persists exact tree-bound evidence", async () => {
    const fixture = await createFixture();
    const result = await verifyIntegratedSwarmResult(fixture.input());

    expect(result.passed).toBe(true);
    expect(result.replayedCandidateIds).toEqual(["candidate-a", "candidate-b"]);
    expect(result.reconstructedTreeHash).toBe(fixture.integratedTreeHash);
    expect(result.evidence).toMatchObject({
      commandState: "passed",
      mutationState: "clean",
      integratedTreeHash: fixture.integratedTreeHash,
      baselineCommit: fixture.manager.baselineCommit,
      workspaceId: "verifier-primary"
    });
    expect(result.cleanupAuthorized).toBe(true);
    expect(fixture.store.verifications).toEqual([result.evidence]);
    expect(fixture.executorRequests).toHaveLength(1);
    expect(fixture.executorRequests[0]).toMatchObject({
      swarmId: "swarm-verify",
      workspaceId: "verifier-primary",
      parentPolicyVersion: "swarm-policy-v1",
      baselineCommit: fixture.manager.baselineCommit,
      integratedTreeHash: fixture.integratedTreeHash,
      commands: fixture.commands
    });
    expect(fixture.executorRequests[0]?.cwd).toBe(result.workspace.path);
  }, 60_000);

  it.each([
    ["wrong candidate order", (fixture: VerificationFixture) => fixture.input({ admittedCandidateIds: ["candidate-b", "candidate-a"] })],
    ["patch hash mismatch", (fixture: VerificationFixture) => {
      const artifact = fixture.store.candidates.get("candidate-a")!;
      fixture.store.candidates.set("candidate-a", { ...artifact, patch: Buffer.concat([artifact.patch, Buffer.from("tamper")]) });
      return fixture.input();
    }],
    ["integration tree mismatch", (fixture: VerificationFixture) => fixture.input({ integratedTreeHash: "f".repeat(40) })]
  ])("rejects reconstruct %s before launching commands", async (_label, mutate) => {
    const fixture = await createFixture();
    const result = await verifyIntegratedSwarmResult(mutate(fixture));

    expect(result.passed).toBe(false);
    expect(result.evidence.commandState).toBe("unknown");
    expect(fixture.executorRequests).toHaveLength(0);
    expect(fixture.store.verifications).toEqual([result.evidence]);
    expect(result.cleanupAuthorized).toBe(true);
  }, 60_000);

  it("rejects a stale verifier binding even when the executor claims PASS", async () => {
    const fixture = await createFixture();
    const result = await verifyIntegratedSwarmResult(fixture.input({
      executor: async (request) => passingExecution({ ...request, integratedTreeHash: "0".repeat(40) })
    }));

    expect(result.passed).toBe(false);
    expect(result.evidence.commandState).toBe("failed");
    expect(result.evidence.mutationState).toBe("clean");
  }, 60_000);

  it.each([
    ["not launched", { launched: false, completed: false, timedOut: false, exitCode: null }],
    ["failed exit", { launched: true, completed: true, timedOut: false, exitCode: 1 }],
    ["timed out", { launched: true, completed: true, timedOut: true, exitCode: null }]
  ])("rejects binding command facts when a command is %s", async (_label, facts) => {
    const fixture = await createFixture();
    const result = await verifyIntegratedSwarmResult(fixture.input({
      executor: async (request) => {
        const passing = passingExecution(request);
        return {
          ...passing,
          passed: true,
          subprocessResults: passing.subprocessResults.map((step, index) => (
            index === 0 ? { ...step, ...facts } : step
          ))
        };
      }
    }));

    expect(result.passed).toBe(false);
    expect(result.evidence.commandState).toBe("failed");
  }, 60_000);

  it.each([
    ["tracked admitted-file edit", async (cwd: string) => writeFile(join(cwd, "a.txt"), "verifier mutation\n", "utf8")],
    ["staged edit", async (cwd: string) => {
      await writeFile(join(cwd, "a.txt"), "staged verifier mutation\n", "utf8");
      git(cwd, ["add", "a.txt"]);
    }],
    ["tracked deletion", async (cwd: string) => unlink(join(cwd, "a.txt"))],
    ["untracked implementation", async (cwd: string) => writeFile(join(cwd, "new-implementation.ts"), "export {};\n", "utf8")]
  ])("detects mutation: %s even when the executor claims PASS", async (_label, mutate) => {
    const fixture = await createFixture();
    const result = await verifyIntegratedSwarmResult(fixture.input({
      executor: async (request) => {
        await mutate(request.cwd);
        return passingExecution(request);
      }
    }));

    expect(result.passed).toBe(false);
    expect(result.evidence.commandState).toBe("passed");
    expect(result.evidence.mutationState).toBe("mutated");
    expect(fixture.store.verifications).toEqual([result.evidence]);
  }, 60_000);

  it("records an aborted verifier as unknown and forwards the same AbortSignal", async () => {
    const fixture = await createFixture();
    const controller = new AbortController();
    controller.abort(new Error("user cancelled"));
    let observed: AbortSignal | undefined;
    const result = await verifyIntegratedSwarmResult(fixture.input({
      signal: controller.signal,
      executor: async (request) => {
        observed = request.signal;
        throw new DOMException("Aborted", "AbortError");
      }
    }));

    expect(observed).toBe(controller.signal);
    expect(result.passed).toBe(false);
    expect(result.evidence.commandState).toBe("unknown");
    expect(result.evidence.mutationState).toBe("clean");
    expect(fixture.store.verifications).toEqual([result.evidence]);
  }, 60_000);

  it("does not grant cleanup authority when verification evidence persistence fails", async () => {
    const fixture = await createFixture();
    fixture.store.failPersistence = true;
    const result = await verifyIntegratedSwarmResult(fixture.input());

    expect(result.passed).toBe(false);
    expect(result.cleanupAuthorized).toBe(false);
    expect(fixture.store.verifications).toHaveLength(0);
  }, 60_000);
});

describe("parent swarm lifecycle and final authority", () => {
  it("closes the scheduling gate, aborts five children, awaits every closure, persists all intent, then removes exact handles", async () => {
    const record = createLifecycleRecord(5);
    const calls: string[] = [];
    const deferred = Array.from({ length: 5 }, () => deferredClosure());
    const registrations = createLifecycleRegistrations(record, deferred, calls);
    const removed: SwarmWorkspaceRuntimeHandle[] = [];
    const manager = fakeLifecycleManager(record.swarmId, async (handle) => {
      calls.push(`remove:${handle.record.workspaceId}`);
      removed.push(handle);
      return completedCleanup(record.swarmId, handle);
    });
    const controller = createSwarmLifecycleController({
      record,
      workspaceManager: manager,
      evidenceStore: {
        async persistCleanupEvidence(cleanup) { calls.push(`cleanup:${cleanup.workspaceId}`); },
        async persistTerminalRecord() { calls.push("parent-record"); }
      },
      now: sequenceClock()
    });
    registrations.forEach((registration) => controller.registerActiveChild(registration));

    const cancellation = controller.cancel("cancelled");
    expect(() => controller.assertAcceptingWork()).toThrow(/no longer accepting/iu);
    expect(registrations.every((registration) => registration.abortController.signal.aborted)).toBe(true);
    deferred.slice(0, 4).forEach((entry) => entry.resolve({ state: "closed", completedAt: "2026-10-03T00:00:10.000Z" }));
    await Promise.resolve();
    expect(calls).toEqual([]);
    deferred[4]!.resolve({ state: "closed", completedAt: "2026-10-03T00:00:10.000Z" });
    const result = await cancellation;

    expect(result.state).toBe("stopped");
    expect(result.record.budgetLedger.leases.every((lease) => lease.status === "released")).toBe(true);
    expect(removed).toEqual(registrations.map((registration) => registration.workspace));
    const firstRemoval = calls.findIndex((entry) => entry.startsWith("remove:"));
    expect(firstRemoval).toBe(5);
    expect(calls.slice(0, firstRemoval).every((entry) => entry.startsWith("persist:"))).toBe(true);
    expect(result.record.events.at(-1)?.type).toBe("SWARM_STOPPED");
  });

  it("retains worktrees and needs review for process, persistence, and cleanup failures", async () => {
    const record = createLifecycleRecord(3);
    const calls: string[] = [];
    const deferred = Array.from({ length: 3 }, () => deferredClosure());
    const registrations = createLifecycleRegistrations(record, deferred, calls, 1);
    const removed: string[] = [];
    const manager = fakeLifecycleManager(record.swarmId, async (handle) => {
      removed.push(handle.record.workspaceId);
      const cleanup = completedCleanup(record.swarmId, handle);
      return handle.record.workspaceId === "workspace-3"
        ? { ...cleanup, state: "cleanup_pending", removalState: "failed", errorCode: "EBUSY", completedAt: undefined }
        : cleanup;
    });
    const controller = createSwarmLifecycleController({
      record,
      workspaceManager: manager,
      evidenceStore: {
        async persistCleanupEvidence() {},
        async persistTerminalRecord() {}
      },
      now: sequenceClock()
    });
    registrations.forEach((registration) => controller.registerActiveChild(registration));
    const cancellation = controller.cancel("child_terminal_failure");
    deferred[0]!.resolve({ state: "failed", completedAt: "2026-10-03T00:00:10.000Z", errorCode: "PROCESS_CLOSE_FAILED" });
    deferred[1]!.resolve({ state: "closed", completedAt: "2026-10-03T00:00:10.000Z" });
    deferred[2]!.resolve({ state: "closed", completedAt: "2026-10-03T00:00:10.000Z" });
    const result = await cancellation;

    expect(result.state).toBe("needs_review");
    expect(removed).toEqual(["workspace-3"]);
    expect(result.cleanupEvidence).toMatchObject([{ state: "cleanup_pending", errorCode: "EBUSY" }]);
    expect(result.unresolvedChildRunIds).toEqual(["run-1", "run-2", "run-3"]);
    expect(result.record.events.at(-1)?.type).toBe("SWARM_NEEDS_REVIEW");
  });

  it("runs integration, fresh verification, cleanup, and private finalization before one SWARM_VERIFIED", async () => {
    const fixture = await createFixture();
    const executor = { execute: async (request: SwarmVerifierExecutionRequest) => passingExecution(request) };
    const result = await runParentSwarmPipeline({
      record: fixture.swarmRecord,
      candidateIds: ["candidate-a", "candidate-b"],
      workspaceManager: fixture.manager,
      evidenceStore: fixture.store,
      integrationWorkspaceId: "pipeline-integration",
      verifierWorkspaceId: "pipeline-verifier",
      verifierExecutor: executor,
      signal: new AbortController().signal,
      now: sequenceClock(),
      createId: (prefix) => `${prefix}-pipeline`
    });

    expect(result.outcome.state).toBe("verified");
    expect(result.blockingInvariants).toEqual([]);
    expect(result.integration).toMatchObject({ completed: true, admittedCandidateIds: ["candidate-a", "candidate-b"] });
    expect(result.verification).toMatchObject({ commandState: "passed", mutationState: "clean" });
    expect(result.cleanup).toHaveLength(2);
    expect(result.cleanup.every((entry) => entry.state === "completed")).toBe(true);
    expect(result.record.events.filter((event) => event.type === "SWARM_VERIFIED")).toHaveLength(1);
    expect(result).not.toHaveProperty("workspace");

    const admittedIndex = result.record.events.findIndex((event) => event.type === "CHILD_PATCH_ADMITTED");
    const originalBytes = JSON.stringify(result);
    expect(isAuthorizedParentSwarmPipelineResult(result)).toBe(true);
    expect(Object.isFrozen(result.record)).toBe(true);
    expect(Object.isFrozen(result.record.events)).toBe(true);
    expect(Object.isFrozen(result.record.events[admittedIndex]!.payload)).toBe(true);
    expect(() => {
      result.record.events[admittedIndex]!.payload.patchSha256 = "f".repeat(64);
    }).toThrow(TypeError);
    expect(() => Object.defineProperty(result.record, "toJSON", {
      enumerable: false,
      value: () => ({})
    })).toThrow(TypeError);
    expect(() => Object.setPrototypeOf(result.record.events[admittedIndex]!.payload, {
      candidateId: "candidate-forged"
    })).toThrow(TypeError);
    expect(JSON.stringify(result)).toBe(originalBytes);
    expect(isAuthorizedParentSwarmPipelineResult(result)).toBe(true);
    expect(isAuthorizedParentSwarmPipelineResult(structuredClone(result))).toBe(false);
  }, 60_000);

  it("refuses parent verification when a required accepted write task has no candidate", async () => {
    const fixture = await createFixture();
    const result = await runParentSwarmPipeline({
      record: fixture.swarmRecord,
      candidateIds: ["candidate-a"],
      workspaceManager: fixture.manager,
      evidenceStore: fixture.store,
      integrationWorkspaceId: "partial-integration",
      verifierWorkspaceId: "partial-verifier",
      verifierExecutor: { execute: async (request) => passingExecution(request) },
      signal: new AbortController().signal,
      now: sequenceClock(),
      createId: (prefix) => `${prefix}-partial`
    });

    expect(result.outcome.state).not.toBe("verified");
    expect(result.blockingInvariants).toContain("integration");
    expect(result.record.events.some((event) => event.type === "SWARM_VERIFIED")).toBe(false);
  }, 60_000);

  it("refuses parent verification when a child completion or cleanup record is missing", async () => {
    const fixture = await createFixture();
    fixture.store.childCompletions.delete("run-b");
    const result = await runParentSwarmPipeline({
      record: fixture.swarmRecord,
      candidateIds: ["candidate-a", "candidate-b"],
      workspaceManager: fixture.manager,
      evidenceStore: fixture.store,
      integrationWorkspaceId: "missing-child-integration",
      verifierWorkspaceId: "missing-child-verifier",
      verifierExecutor: { execute: async (request) => passingExecution(request) },
      signal: new AbortController().signal,
      now: sequenceClock(),
      createId: (prefix) => `${prefix}-missing-child`
    });

    expect(result.outcome.state).not.toBe("verified");
    expect(result.blockingInvariants).toContain("cleanup");
    expect(result.record.events.some((event) => event.type === "SWARM_VERIFIED")).toBe(false);
  }, 60_000);

  it("refuses parent verification when terminal attempt identity differs from its bound receipt", async () => {
    const fixture = await createFixture();
    const original = fixture.store.childCompletions.get("run-a")!;
    fixture.store.childCompletions.set("run-a", {
      ...original,
      attemptId: "attempt-tampered"
    });

    const result = await runParentSwarmPipeline({
      record: fixture.swarmRecord,
      candidateIds: ["candidate-a", "candidate-b"],
      workspaceManager: fixture.manager,
      evidenceStore: fixture.store,
      integrationWorkspaceId: "attempt-tamper-integration",
      verifierWorkspaceId: "attempt-tamper-verifier",
      verifierExecutor: { execute: async (request) => passingExecution(request) },
      signal: new AbortController().signal,
      now: sequenceClock(),
      createId: (prefix) => `${prefix}-attempt-tamper`
    });

    expect(result.outcome.state).not.toBe("verified");
    expect(result.record.events.some((event) => event.type === "SWARM_VERIFIED")).toBe(false);
  }, 60_000);

  it("refuses parent verification when cancellation arrives after verifier execution", async () => {
    const fixture = await createFixture();
    const abort = new AbortController();
    const result = await runParentSwarmPipeline({
      record: fixture.swarmRecord,
      candidateIds: ["candidate-a", "candidate-b"],
      workspaceManager: fixture.manager,
      evidenceStore: fixture.store,
      integrationWorkspaceId: "abort-race-integration",
      verifierWorkspaceId: "abort-race-verifier",
      verifierExecutor: {
        execute: async (request) => {
          const execution = passingExecution(request);
          abort.abort("cancelled");
          return execution;
        }
      },
      signal: abort.signal,
      now: sequenceClock(),
      createId: (prefix) => `${prefix}-abort-race`
    });

    expect(result.outcome.state).not.toBe("verified");
    expect(result.blockingInvariants).toContain("parentState");
    expect(result.record.events.some((event) => event.type === "SWARM_VERIFIED")).toBe(false);
  }, 60_000);

  it("exports only the high-level Phase 3 pipeline from Core root", () => {
    expect(publicCoreApi).toHaveProperty("runParentSwarmPipeline");
    for (const forbidden of [
      "finalizeParentSwarmOutcome",
      "assessSwarmOutcomeEvidence",
      "createSwarmLifecycleController",
      "verifyIntegratedSwarmResult",
      "createSwarmWorkspaceManager",
      "cancelSwarmChildren"
    ]) expect(publicCoreApi).not.toHaveProperty(forbidden);
    expect(publicCoreApi).toHaveProperty("completeDeterministicDemoSwarmRun");
  });
});

class MemoryVerificationStore implements SwarmGlobalVerificationEvidenceStore, ParentSwarmPipelineEvidenceStore {
  readonly candidates = new Map<string, PersistedSwarmCandidateArtifact>();
  readonly admissions = new Map<string, SwarmPatchAdmission>();
  readonly verifications: SwarmGlobalVerification[] = [];
  readonly outcomes: SwarmIntegrationEvidenceBundle[] = [];
  readonly reconstructions: SwarmIntegrationReconstruction[] = [];
  readonly cleanups: SwarmCleanupRecord[] = [];
  readonly childCompletions = new Map<string, PersistedSwarmChildCompletionEvidence>();
  readonly workspaceFailures: SwarmPipelineWorkspaceFailureEvidence[] = [];
  readonly claims = new Set<string>();
  failPersistence = false;

  async loadPersistedCandidate(candidateId: string): Promise<PersistedSwarmCandidateArtifact | undefined> {
    return this.candidates.get(candidateId);
  }

  async loadPersistedAdmission(candidateId: string): Promise<SwarmPatchAdmission | undefined> {
    return this.admissions.get(candidateId);
  }

  async loadPersistedChildCompletion(childRunId: string): Promise<PersistedSwarmChildCompletionEvidence | undefined> {
    return this.childCompletions.get(childRunId);
  }

  async persistGlobalVerification(evidence: SwarmGlobalVerification): Promise<void> {
    if (this.failPersistence) throw new Error("simulated persistence failure");
    this.verifications.push(evidence);
  }

  async claimCandidateIntegration(input: { swarmId: string; candidateId: string; identitySha256: string }): Promise<"claimed" | "already_claimed"> {
    const key = `${input.swarmId}:${input.candidateId}`;
    if (this.claims.has(key)) return "already_claimed";
    this.claims.add(key);
    return "claimed";
  }

  async persistOutcome(bundle: SwarmIntegrationEvidenceBundle): Promise<void> {
    this.outcomes.push(bundle);
  }

  async persistReconstruction(record: SwarmIntegrationReconstruction): Promise<void> {
    this.reconstructions.push(record);
  }

  async persistCleanupEvidence(cleanup: SwarmCleanupRecord): Promise<void> {
    this.cleanups.push(cleanup);
  }

  async persistWorkspaceFailureEvidence(evidence: SwarmPipelineWorkspaceFailureEvidence): Promise<void> {
    this.workspaceFailures.push(evidence);
  }
}

interface VerificationFixture {
  manager: SwarmWorkspaceManager;
  store: MemoryVerificationStore;
  swarmRecord: SwarmRunRecord;
  commands: readonly VerificationStep[];
  integratedTreeHash: string;
  executorRequests: SwarmVerifierExecutionRequest[];
  input(overrides?: Partial<Parameters<typeof verifyIntegratedSwarmResult>[0]>): Parameters<typeof verifyIntegratedSwarmResult>[0];
}

async function createFixture(): Promise<VerificationFixture> {
  const scratchRoot = await mkdtemp(join(tmpdir(), "martin-swarm-verification-"));
  scratchRoots.push(scratchRoot);
  const canonicalRoot = join(scratchRoot, "canonical");
  await mkdir(canonicalRoot, { recursive: true });
  git(canonicalRoot, ["init"]);
  git(canonicalRoot, ["config", "user.email", "swarm-verification@test.invalid"]);
  git(canonicalRoot, ["config", "user.name", "Swarm Verification Test"]);
  git(canonicalRoot, ["config", "core.autocrlf", "false"]);
  await writeFile(join(canonicalRoot, ".gitignore"), ".martin/\n", "utf8");
  await writeFile(join(canonicalRoot, "a.txt"), "baseline a\n", "utf8");
  await writeFile(join(canonicalRoot, "b.txt"), "baseline b\n", "utf8");
  git(canonicalRoot, ["add", "."]);
  git(canonicalRoot, ["commit", "-m", "verification baseline"]);

  const manager = await createSwarmWorkspaceManager({
    canonicalRoot,
    ownedRoot: join(canonicalRoot, ".martin", "swarms", "swarm-verify", "worktrees"),
    swarmId: "swarm-verify"
  });
  const store = new MemoryVerificationStore();
  const specs = [
    { candidateId: "candidate-a", workspaceId: "child-a", childRunId: "run-a", agentId: "agent-a", taskId: "task-a", file: "a.txt", content: "candidate a\n" },
    { candidateId: "candidate-b", workspaceId: "child-b", childRunId: "run-b", agentId: "agent-b", taskId: "task-b", file: "b.txt", content: "candidate b\n" }
  ] as const;
  const artifacts: PersistedSwarmCandidateArtifact[] = [];
  for (const spec of specs) {
    const child = await manager.createWorkspace({
      kind: "child",
      workspaceId: spec.workspaceId,
      childRunId: spec.childRunId,
      agentId: spec.agentId,
      taskIds: [spec.taskId]
    });
    await writeFile(join(child.path, spec.file), spec.content, "utf8");
    git(child.path, ["add", "--", spec.file]);
    const candidateTreeHash = gitText(child.path, ["write-tree"]);
    const patch = gitBuffer(child.path, [
      "diff", "--binary", "--full-index", "--no-ext-diff", "--no-renames",
      manager.baselineCommit, candidateTreeHash, "--"
    ]);
    const artifact = createArtifact({ ...spec, baselineCommit: manager.baselineCommit, candidateTreeHash, patch });
    store.candidates.set(spec.candidateId, artifact);
    artifacts.push(artifact);
    const cleanup = await manager.removeWorkspace(child, {
      evidencePersisted: true,
      processTreeClosed: true,
      force: true
    });
    store.childCompletions.set(spec.childRunId, {
      swarmId: "swarm-verify",
      childRunId: spec.childRunId,
      agentId: spec.agentId,
      attemptId: `attempt-${spec.childRunId}`,
      taskIds: [spec.taskId],
      workspaceId: spec.workspaceId,
      processCloseState: "closed",
      leaseState: "released",
      receipt: createCompletionReceipt(
        spec.childRunId,
        spec.agentId,
        `attempt-${spec.childRunId}`,
        [spec.taskId]
      ),
      evidencePersisted: true,
      workspaceCleanupState: "completed",
      cleanup
    });
  }

  const replay = await manager.createWorkspace({ kind: "integration", workspaceId: "expected-integration" });
  let preTreeHash = gitText(replay.path, ["write-tree"]);
  for (const artifact of artifacts) {
    gitBuffer(replay.path, ["-c", "core.autocrlf=false", "apply", "--check", "--index", "-"], artifact.patch);
    gitBuffer(replay.path, ["-c", "core.autocrlf=false", "apply", "--index", "-"], artifact.patch);
    const postTreeHash = gitText(replay.path, ["write-tree"]);
    store.admissions.set(artifact.candidate.candidateId, createAdmission(artifact, preTreeHash, postTreeHash));
    preTreeHash = postTreeHash;
  }
  const integratedTreeHash = preTreeHash;
  const swarmRecord = createSwarmRecord(manager.baselineCommit);
  const commands = swarmRecord.parentContract.globalVerifierStack;
  const executorRequests: SwarmVerifierExecutionRequest[] = [];
  const executor = async (request: SwarmVerifierExecutionRequest): Promise<SwarmVerifierExecutionResult> => {
    executorRequests.push(request);
    return passingExecution(request);
  };
  const input = (
    overrides: Partial<Parameters<typeof verifyIntegratedSwarmResult>[0]> = {}
  ): Parameters<typeof verifyIntegratedSwarmResult>[0] => ({
    swarmRecord,
    workspaceManager: manager,
    verifierWorkspaceId: "verifier-primary",
    admittedCandidateIds: ["candidate-a", "candidate-b"],
    integratedTreeHash,
    evidenceStore: store,
    executor,
    signal: new AbortController().signal,
    now: sequenceClock(),
    createVerificationId: () => "verification-001",
    ...overrides
  });
  return { manager, store, swarmRecord, commands, integratedTreeHash, executorRequests, input };
}

function createArtifact(input: {
  candidateId: string;
  workspaceId: string;
  childRunId: string;
  agentId: string;
  taskId: string;
  file: string;
  baselineCommit: string;
  candidateTreeHash: string;
  patch: Buffer;
}): PersistedSwarmCandidateArtifact {
  const patchSha256 = sha256(input.patch);
  const manifest = Buffer.from([" M", "100644", input.file, ""].join("\0"), "utf8");
  const manifestSha256 = sha256(manifest);
  const receiptIntegrity: ReceiptIntegritySummary = {
    state: "verified",
    keyId: "test-key",
    loopRecordSha256: "1".repeat(64),
    ledgerSha256: "2".repeat(64),
    ledgerHeadHash: "3".repeat(64)
  };
  const candidate = {
    schemaVersion: SWARM_SCHEMA_VERSION,
    candidateId: input.candidateId,
    swarmId: "swarm-verify",
    workspaceId: input.workspaceId,
    childRunId: input.childRunId,
    agentId: input.agentId,
    taskIds: [input.taskId],
    baselineCommit: input.baselineCommit,
    patchSha256,
    changedPaths: [input.file],
    createdAt: "2026-10-03T00:00:01.000Z"
  } as const;
  const attemptId = `attempt-${input.taskId}`;
  const proposalId = `proposal-${input.taskId}`;
  const identitySha256 = sha256(Buffer.from(JSON.stringify({
    swarmId: candidate.swarmId,
    candidateId: candidate.candidateId,
    attemptId,
    proposalId,
    workspaceId: candidate.workspaceId,
    childRunId: candidate.childRunId,
    agentId: candidate.agentId,
    taskIds: [...candidate.taskIds].sort(),
    baselineCommit: candidate.baselineCommit,
    patchSha256,
    manifestSha256,
    candidateTreeHash: input.candidateTreeHash,
    receipt: {
      keyId: receiptIntegrity.keyId,
      loopRecordSha256: receiptIntegrity.loopRecordSha256,
      ledgerSha256: receiptIntegrity.ledgerSha256,
      ledgerHeadHash: receiptIntegrity.ledgerHeadHash
    }
  }), "utf8"));
  return {
    candidate,
    attemptId,
    proposalId,
    identitySha256,
    candidateTreeHash: input.candidateTreeHash,
    patch: Buffer.from(input.patch),
    manifest,
    manifestSha256,
    receiptIntegrity
  };
}

function createAdmission(
  artifact: PersistedSwarmCandidateArtifact,
  preIntegrationTreeHash: string,
  postIntegrationTreeHash: string
): SwarmPatchAdmission {
  return {
    schemaVersion: SWARM_SCHEMA_VERSION,
    admissionId: `integrated-${artifact.candidate.candidateId}`,
    candidateId: artifact.candidate.candidateId,
    swarmId: artifact.candidate.swarmId,
    workspaceId: artifact.candidate.workspaceId,
    childRunId: artifact.candidate.childRunId,
    agentId: artifact.candidate.agentId,
    taskIds: [...artifact.candidate.taskIds],
    baselineCommit: artifact.candidate.baselineCommit,
    changedPaths: [...artifact.candidate.changedPaths],
    state: "admitted",
    reasonCode: "admitted",
    receiptIntegrity: "verified",
    decidedAt: "2026-10-03T00:00:02.000Z",
    preIntegrationTreeHash,
    postIntegrationTreeHash
  };
}

function createCompletionReceipt(
  childRunId: string,
  agentId: string,
  attemptId: string,
  taskIds: readonly string[]
): PersistedSwarmChildCompletionEvidence["receipt"] {
  const receipt = {
    receiptId: `receipt-${childRunId}`,
    swarmId: "swarm-verify",
    childRunId,
    agentId,
    attemptId,
    taskIds: [...taskIds],
    integrity: {
      state: "verified" as const,
      keyId: "test-key",
      loopRecordSha256: "1".repeat(64),
      ledgerSha256: "2".repeat(64),
      ledgerHeadHash: "3".repeat(64)
    }
  };
  const canonical = JSON.stringify({
    receiptId: receipt.receiptId,
    swarmId: receipt.swarmId,
    childRunId: receipt.childRunId,
    agentId: receipt.agentId,
    attemptId: receipt.attemptId,
    taskIds: [...receipt.taskIds].sort(),
    integrity: { ...receipt.integrity }
  });
  return { ...receipt, bindingSha256: sha256(Buffer.from(canonical, "utf8")) };
}

function passingExecution(request: SwarmVerifierExecutionRequest): SwarmVerifierExecutionResult {
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
      commands: request.commands.map((step) => step.command)
    },
    subprocessResults: request.commands.map((step, index) => ({
      command: step.command,
      launched: true,
      completed: true,
      timedOut: false,
      exitCode: 0,
      startedAt: `2026-10-03T00:00:1${String(index)}.000Z`,
      completedAt: `2026-10-03T00:00:1${String(index + 1)}.000Z`
    }))
  };
}

function createSwarmRecord(baselineCommit: string): SwarmRunRecord {
  const budget = { maxUsd: 1, softLimitUsd: 0.8, maxIterations: 2, maxTokens: 1000 };
  return {
    schemaVersion: SWARM_SCHEMA_VERSION,
    swarmId: "swarm-verify",
    workspaceId: "parent-workspace",
    projectId: "project-swarm",
    parentContract: {
      policyVersion: "swarm-policy-v1",
      objective: "Verify the integrated swarm result.",
      definitionOfDone: ["Global verification passes without mutation."],
      budget,
      maxWallClockMs: 60_000,
      maxConcurrency: 2,
      scope: { allowedPaths: ["**"], deniedPaths: ["secrets/**"] },
      permissions: { networkDomains: [], commands: ["pnpm"] },
      integrationStrategy: "parent_fan_in",
      globalVerifierStack: [
        { command: "pnpm lint", type: "lint" },
        { command: "pnpm test", type: "test_full" }
      ],
      stopPolicy: { budgetExhausted: "stop", blockingFailure: "stop", verifierFailure: "needs_review" },
      recoveryPolicy: { maxReassignmentsPerTask: 1, dependencyWaiversAllowed: false },
      approvalPolicy: {},
      orchestrationStrategy: "hierarchical_dag"
    },
    tasks: [
      { taskId: "task-a", title: "A", objective: "Change A.", required: true, dependsOn: [], assignedAgentId: "agent-a", status: "accepted", mutationMode: "write", writeScope: ["a.txt"] },
      { taskId: "task-b", title: "B", objective: "Change B.", required: true, dependsOn: ["task-a"], assignedAgentId: "agent-b", status: "accepted", mutationMode: "write", writeScope: ["b.txt"] }
    ],
    agents: [
      {
        agentId: "agent-a",
        role: "implementer",
        status: "verified",
        childRunId: "run-a",
        contract: {
          agentId: "agent-a",
          taskIds: ["task-a"],
          scope: { allowedPaths: ["a.txt"], deniedPaths: ["secrets/**"] },
          budget,
          maxWallClockMs: 60_000,
          permissions: { networkDomains: [], commands: ["pnpm"] },
          approvalPolicy: {},
          verifierAuthority: "child_only"
        }
      },
      {
        agentId: "agent-b",
        role: "implementer",
        status: "verified",
        childRunId: "run-b",
        contract: {
          agentId: "agent-b",
          taskIds: ["task-b"],
          scope: { allowedPaths: ["b.txt"], deniedPaths: ["secrets/**"] },
          budget,
          maxWallClockMs: 60_000,
          permissions: { networkDomains: [], commands: ["pnpm"] },
          approvalPolicy: {},
          verifierAuthority: "child_only"
        }
      }
    ],
    dependencyWaivers: [],
    budgetLedger: { capUsd: 1, capTokens: 1000, settledUsd: 0, settledTokens: 0, leases: [] },
    conflicts: [],
    verification: [],
    outcome: { state: "running", reason: "Global verification pending." },
    events: [],
    createdAt: "2026-10-03T00:00:00.000Z",
    updatedAt: "2026-10-03T00:00:00.000Z"
  };
}

function sequenceClock(): () => string {
  let tick = 0;
  return () => `2026-10-03T00:00:${String(tick++).padStart(2, "0")}.000Z`;
}

function sha256(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function git(cwd: string, args: readonly string[]): void {
  const result = spawnSync("git", [...args], { cwd, encoding: "utf8", windowsHide: true });
  if (result.status !== 0) throw new Error(result.stderr || `git ${args.join(" ")} failed`);
}

function gitText(cwd: string, args: readonly string[]): string {
  return gitBuffer(cwd, args).toString("utf8").trim();
}

function gitBuffer(cwd: string, args: readonly string[], stdin?: Buffer): Buffer {
  const result = spawnSync("git", [...args], {
    cwd,
    input: stdin,
    encoding: null,
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024
  });
  if (result.status !== 0) {
    throw new Error(result.stderr?.toString("utf8") || `git ${args.join(" ")} failed`);
  }
  return result.stdout ?? Buffer.alloc(0);
}

function createLifecycleRecord(count: number): SwarmRunRecord {
  const template = createSwarmRecord("a".repeat(40));
  const tasks = Array.from({ length: count }, (_, index) => ({
    taskId: `task-${String(index + 1)}`,
    title: `Task ${String(index + 1)}`,
    objective: "Stop safely.",
    required: true,
    dependsOn: [],
    assignedAgentId: `agent-${String(index + 1)}`,
    status: "running" as const,
    mutationMode: "write" as const,
    writeScope: [`file-${String(index + 1)}.txt`]
  }));
  const agents = tasks.map((task, index) => ({
    agentId: task.assignedAgentId,
    role: "implementer",
    status: "running" as const,
    childRunId: `run-${String(index + 1)}`,
    contract: {
      agentId: task.assignedAgentId,
      taskIds: [task.taskId],
      scope: { allowedPaths: [...task.writeScope], deniedPaths: ["secrets/**"] },
      budget: { ...template.parentContract.budget },
      maxWallClockMs: 60_000,
      permissions: { networkDomains: [], commands: ["pnpm"] },
      approvalPolicy: {},
      verifierAuthority: "child_only" as const
    }
  }));
  return {
    ...template,
    swarmId: "swarm-lifecycle",
    tasks,
    agents,
    budgetLedger: {
      capUsd: count,
      capTokens: count * 100,
      settledUsd: 0,
      settledTokens: 0,
      leases: tasks.map((task, index) => ({
        leaseId: `lease-${String(index + 1)}`,
        agentId: task.assignedAgentId,
        taskId: task.taskId,
        reservedUsd: 1,
        reservedTokens: 100,
        status: "reserved" as const
      }))
    }
  };
}

function createLifecycleRegistrations(
  record: SwarmRunRecord,
  deferred: Array<ReturnType<typeof deferredClosure>>,
  calls: string[],
  failingWriterIndex = -1
): ActiveSwarmChildRegistration[] {
  return record.agents.map((agent, index) => {
    const taskId = agent.contract.taskIds[0]!;
    const childRunId = agent.childRunId!;
    const workspace: SwarmWorkspaceRuntimeHandle = Object.freeze({
      path: `C:\\swarm-fixture\\workspace-${String(index + 1)}`,
      record: Object.freeze({
        schemaVersion: SWARM_SCHEMA_VERSION,
        workspaceId: `workspace-${String(index + 1)}`,
        swarmId: record.swarmId,
        kind: "child" as const,
        childRunId,
        agentId: agent.agentId,
        taskIds: [taskId],
        baselineCommit: "a".repeat(40),
        state: "active" as const,
        createdAt: "2026-10-03T00:00:00.000Z"
      })
    });
    return {
      swarmId: record.swarmId,
      agentId: agent.agentId,
      childRunId,
      taskId,
      leaseId: `lease-${String(index + 1)}`,
      workspace,
      abortController: new AbortController(),
      processClosed: deferred[index]!.promise,
      evidenceWriter: {
        async persistBeforeCleanup(evidence: SwarmLifecyclePreCleanupEvidence) {
          if (index === failingWriterIndex) throw new Error("simulated evidence failure");
          calls.push(`persist:${evidence.terminal.workspaceId}`);
        }
      }
    };
  });
}

function fakeLifecycleManager(
  swarmId: string,
  removeWorkspace: SwarmWorkspaceManager["removeWorkspace"]
): SwarmWorkspaceManager {
  return {
    baselineCommit: "a".repeat(40),
    canonicalRoot: "C:\\swarm-fixture\\canonical",
    ownedRoot: `C:\\swarm-fixture\\${swarmId}`,
    async createWorkspace() { throw new Error("not used"); },
    removeWorkspace
  };
}

function completedCleanup(swarmId: string, handle: SwarmWorkspaceRuntimeHandle): SwarmCleanupRecord {
  return {
    schemaVersion: SWARM_SCHEMA_VERSION,
    cleanupId: `cleanup-${handle.record.workspaceId}`,
    swarmId,
    workspaceId: handle.record.workspaceId,
    workspaceKind: handle.record.kind,
    evidencePersisted: true,
    processCloseState: "closed",
    removalState: "removed",
    state: "completed",
    attemptedAt: "2026-10-03T00:00:20.000Z",
    completedAt: "2026-10-03T00:00:21.000Z"
  };
}

function deferredClosure(): {
  promise: Promise<{ state: "closed" | "failed"; completedAt: string; errorCode?: string }>;
  resolve(value: { state: "closed" | "failed"; completedAt: string; errorCode?: string }): void;
} {
  let resolvePromise!: (value: { state: "closed" | "failed"; completedAt: string; errorCode?: string }) => void;
  const promise = new Promise<{ state: "closed" | "failed"; completedAt: string; errorCode?: string }>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: resolvePromise };
}
