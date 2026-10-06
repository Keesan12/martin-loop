import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  SWARM_SCHEMA_VERSION,
  createLoopRecord,
  type LoopRecord,
  type SwarmCleanupRecord,
  type SwarmPatchAdmission,
  type SwarmRunRecord
} from "@martin/contracts";
import { afterEach, describe, expect, it } from "vitest";

import {
  captureAndAdmitSwarmCandidate,
  inventorySwarmCandidatePaths,
  type CaptureSwarmCandidateInput,
  type PersistedSwarmCandidateArtifact,
  type SwarmProcessClosureEvidence,
  type SwarmCandidateArtifactWriter,
  type SwarmCandidateGitCommand,
  type SwarmCandidateGitResult
} from "../src/swarm/candidates.js";
import { writeReceiptIntegrityMaterial } from "../src/persistence/integrity.js";
import {
  integrateSwarmCandidates,
  type SwarmIntegrationCandidate,
  type SwarmIntegrationEvidenceBundle,
  type SwarmIntegrationEvidenceStore,
  type SwarmIntegrationGitCommand,
  type SwarmIntegrationGitResult
} from "../src/swarm/integration.js";
import {
  createSwarmWorkspaceManager,
  type SwarmWorkspaceManager,
  type SwarmWorkspaceRuntimeHandle
} from "../src/swarm/workspaces.js";

interface CandidateFixture {
  scratchRoot: string;
  canonicalRoot: string;
  child: SwarmWorkspaceRuntimeHandle;
  input: CaptureSwarmCandidateInput;
  writer: MemoryCandidateWriter;
  gitCalls: string[][];
  loopRecordPath: string;
}

const scratchRoots: string[] = [];
const previousIntegrityKeyDir = process.env["MARTIN_INTEGRITY_KEY_DIR"];

afterEach(async () => {
  if (previousIntegrityKeyDir === undefined) delete process.env["MARTIN_INTEGRITY_KEY_DIR"];
  else process.env["MARTIN_INTEGRITY_KEY_DIR"] = previousIntegrityKeyDir;
  await Promise.all(scratchRoots.splice(0).map((root) => rm(root, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 50
  })));
});

describe("candidate admission", () => {
  it("reports exact concrete changed paths through the shared NUL-safe inventory", async () => {
    const fixture = await createCandidateFixture();
    await mkdir(join(fixture.child.path, "src"), { recursive: true });
    await writeFile(join(fixture.child.path, "src", "a.ts"), "export const a = 1;\n", "utf8");

    const paths = await inventorySwarmCandidatePaths(fixture.child.path, fixture.input.gitRunner);

    expect(paths).toEqual(["src/a.ts"]);
    expect(paths).not.toContain("src/**");
    expect(fixture.gitCalls).toContainEqual([
      "status", "--porcelain=v1", "-z", "--untracked-files=all", "--no-renames"
    ]);
  });

  it("admits a verified live child while parent task state remains pre-admission running", async () => {
    const fixture = await createCandidateFixture();
    await writeFile(join(fixture.child.path, "tracked.txt"), "live child change\n", "utf8");
    const swarmRecord: SwarmRunRecord = {
      ...fixture.input.swarmRecord,
      tasks: fixture.input.swarmRecord.tasks.map((item) => ({ ...item, status: "running" })),
      agents: fixture.input.swarmRecord.agents.map((item) => ({ ...item, status: "running" }))
    };

    const result = await captureAndAdmitSwarmCandidate({
      ...fixture.input,
      swarmRecord,
      childState: "verified",
      declaredPaths: ["tracked.txt"]
    });

    expect(result.admission.reasonCode).toBe("admitted");
    expect(result.cleanupAuthorized).toBe(true);
  });

  it("admits a verified candidate from an independent clone with canonical origin provenance", async () => {
    const fixture = await createCandidateFixture({ isolationMode: "independent_clone" });
    await writeFile(join(fixture.child.path, "tracked.txt"), "independent clone change\n", "utf8");
    const swarmRecord: SwarmRunRecord = {
      ...fixture.input.swarmRecord,
      tasks: fixture.input.swarmRecord.tasks.map((item) => ({ ...item, status: "running" })),
      agents: fixture.input.swarmRecord.agents.map((item) => ({ ...item, status: "running" }))
    };

    const result = await captureAndAdmitSwarmCandidate({
      ...fixture.input,
      swarmRecord,
      childState: "verified",
      declaredPaths: ["tracked.txt"]
    });

    expect(fixture.child.isolationMode).toBe("independent_clone");
    expect(result.admission.reasonCode).toBe("admitted");
    expect(result.cleanupAuthorized).toBe(true);
  });

  it("captures one immutable text/binary/add/delete candidate with NUL-safe Unicode paths", async () => {
    const fixture = await createCandidateFixture();
    const unicodePath = "src/space ü.txt";
    await mkdir(join(fixture.child.path, "src"), { recursive: true });
    await writeFile(join(fixture.child.path, "tracked.txt"), "changed\n", "utf8");
    await unlink(join(fixture.child.path, "deleted.txt"));
    await writeFile(join(fixture.child.path, unicodePath), "unicode\n", "utf8");
    await writeFile(join(fixture.child.path, "src", "asset.bin"), Buffer.from([0, 1, 2, 255]));
    const declaredPaths = ["deleted.txt", "src/asset.bin", unicodePath, "tracked.txt"];

    const result = await captureAndAdmitSwarmCandidate({ ...fixture.input, declaredPaths });

    expect(result.admission).toMatchObject({
      state: "admitted",
      reasonCode: "admitted",
      receiptIntegrity: "verified",
      changedPaths: declaredPaths
    });
    expect(result.cleanupAuthorized).toBe(true);
    expect(fixture.writer.candidates).toHaveLength(1);
    expect(fixture.writer.decisions).toEqual([result.admission]);
    const artifact = fixture.writer.candidates[0];
    expect(artifact?.candidate.patchSha256).toBe(sha256(artifact?.patch ?? Buffer.alloc(0)));
    expect(artifact?.manifestSha256).toBe(sha256(artifact?.manifest ?? Buffer.alloc(0)));
    expect(artifact?.manifest.toString("utf8")).toContain(unicodePath);
    expect(artifact?.patch.includes(Buffer.from("GIT binary patch", "utf8"))).toBe(true);
    expect(fixture.gitCalls).toContainEqual([
      "status", "--porcelain=v1", "-z", "--untracked-files=all", "--no-renames"
    ]);
    expect(fixture.gitCalls).toContainEqual([
      "diff", "--binary", "--full-index", "--no-ext-diff", "--no-renames",
      fixture.child.record.baselineCommit, artifact?.candidateTreeHash, "--"
    ]);
    expect(fixture.gitCalls.filter((args) => args[0] === "diff" && args.includes("--raw"))).toHaveLength(1);
    expect(fixture.gitCalls.filter((args) => args[0] === "diff" && args.includes("--binary"))).toHaveLength(1);
    expect(fixture.gitCalls.filter((args) => args[0] === "write-tree")).toHaveLength(2);
    expect(gitText(fixture.canonicalRoot, ["status", "--porcelain=v1"])).toBe("");
  }, 60_000);

  it.each([
    ["stopped", true, "child_not_terminal"],
    ["verified", false, "process_active"]
  ] as const)("rejects child state %s with processClosed=%s", async (childState, processTreeClosed, reasonCode) => {
    const fixture = await createCandidateFixture();
    await writeFile(join(fixture.child.path, "tracked.txt"), "changed\n", "utf8");
    const swarmRecord = childState === "verified"
      ? fixture.input.swarmRecord
      : { ...fixture.input.swarmRecord, agents: fixture.input.swarmRecord.agents.map((agent) => ({
          ...agent,
          status: childState
        })) } as SwarmRunRecord;
    if (!processTreeClosed) fixture.writer.processClosures.delete(fixture.input.childRunId);
    const result = await captureAndAdmitSwarmCandidate({
      ...fixture.input,
      swarmRecord,
      childState,
      declaredPaths: ["tracked.txt"]
    });
    expect(result.admission.reasonCode).toBe(reasonCode);
    expect(result.cleanupAuthorized).toBe(true);
    expect(fixture.writer.candidates).toHaveLength(0);
  });

  it("rejects missing and tampered canonical receipt material", async () => {
    const missing = await createCandidateFixture({ receipt: false });
    await writeFile(join(missing.child.path, "tracked.txt"), "changed\n", "utf8");
    const missingResult = await captureAndAdmitSwarmCandidate({
      ...missing.input,
      declaredPaths: ["tracked.txt"]
    });
    expect(missingResult.admission).toMatchObject({
      reasonCode: "receipt_not_verified",
      receiptIntegrity: "material_missing"
    });

    const tampered = await createCandidateFixture();
    await writeFile(join(tampered.child.path, "tracked.txt"), "changed\n", "utf8");
    const loop = JSON.parse(await readFile(tampered.loopRecordPath, "utf8")) as LoopRecord;
    loop.metadata["swarm.agentId"] = "attacker";
    await writeFile(tampered.loopRecordPath, `${JSON.stringify(loop, null, 2)}\n`, "utf8");
    const tamperedResult = await captureAndAdmitSwarmCandidate({
      ...tampered.input,
      declaredPaths: ["tracked.txt"]
    });
    expect(tamperedResult.admission).toMatchObject({
      reasonCode: "receipt_not_verified",
      receiptIntegrity: "tamper_detected"
    });
  });

  it("rejects a stale candidate baseline", async () => {
    const stale = await createCandidateFixture();
    const staleResult = await captureAndAdmitSwarmCandidate({
      ...stale.input,
      expectedBaselineCommit: "f".repeat(40)
    });
    expect(staleResult.admission.reasonCode).toBe("stale_baseline");
  });

  it.each([
    ["swarm", { swarmId: "swarm-other" }],
    ["agent", { agentId: "agent-other" }],
    ["child run", { childRunId: "run-other" }],
    ["task", { taskIds: ["task-other"] }]
  ] satisfies Array<[string, Partial<CaptureSwarmCandidateInput>]>) (
    "rejects %s identity replay",
    async (_label, mutation) => {
      const fixture = await createCandidateFixture();
      const result = await captureAndAdmitSwarmCandidate({ ...fixture.input, ...mutation });
      expect(result.admission.reasonCode).toBe("identity_mismatch");
      expect(result.cleanupAuthorized).toBe(true);
    }
  );

  it("rejects Git inventory failure, invalid declarations, omissions, denied paths, and empty candidates", async () => {
    const gitFailure = await createCandidateFixture();
    const failingRunner = async (command: SwarmCandidateGitCommand): Promise<SwarmCandidateGitResult> => {
      if (command.args[0] === "status" && command.cwd === gitFailure.child.path) {
        throw new Error("simulated inventory failure");
      }
      return runGitBuffer(command);
    };
    const gitFailureResult = await captureAndAdmitSwarmCandidate({
      ...gitFailure.input,
      gitRunner: failingRunner
    });
    expect(gitFailureResult.admission.reasonCode).toBe("git_inventory_failed");

    const invalid = await createCandidateFixture();
    await writeFile(join(invalid.child.path, "tracked.txt"), "changed\n", "utf8");
    for (const declaredPath of ["../escape", "C:/escape", ".git/config"]) {
      const result = await captureAndAdmitSwarmCandidate({ ...invalid.input, declaredPaths: [declaredPath] });
      expect(result.admission.reasonCode).toBe("invalid_concrete_path");
    }

    const omitted = await createCandidateFixture();
    await writeFile(join(omitted.child.path, "tracked.txt"), "changed\n", "utf8");
    await writeFile(join(omitted.child.path, "undeclared.txt"), "new\n", "utf8");
    const omittedResult = await captureAndAdmitSwarmCandidate({
      ...omitted.input,
      declaredPaths: ["tracked.txt"]
    });
    expect(omittedResult.admission.reasonCode).toBe("undeclared_path");

    const denied = await createCandidateFixture();
    await mkdir(join(denied.child.path, "secrets"), { recursive: true });
    await writeFile(join(denied.child.path, "secrets", "token.txt"), "redacted\n", "utf8");
    const deniedResult = await captureAndAdmitSwarmCandidate({
      ...denied.input,
      declaredPaths: ["secrets/token.txt"]
    });
    expect(deniedResult.admission.reasonCode).toBe("path_denied");

    const empty = await createCandidateFixture();
    const emptyResult = await captureAndAdmitSwarmCandidate(empty.input);
    expect(emptyResult.admission.reasonCode).toBe("empty_candidate");
  }, 60_000);

  it("rejects junction escape and staged nested-repository gitlinks", async () => {
    const junction = await createCandidateFixture();
    const outside = join(junction.scratchRoot, "outside");
    await mkdir(outside, { recursive: true });
    await symlink(outside, join(junction.child.path, "escape"), "junction");
    await writeFile(join(outside, "outside.txt"), "escape\n", "utf8");
    const junctionResult = await captureAndAdmitSwarmCandidate({
      ...junction.input,
      declaredPaths: ["escape/outside.txt"]
    });
    expect(junctionResult.admission.reasonCode).toBe("unsafe_path");

    const gitlink = await createCandidateFixture();
    const nested = join(gitlink.child.path, "nested");
    await mkdir(nested, { recursive: true });
    git(nested, ["init"]);
    git(nested, ["config", "user.email", "nested@test.invalid"]);
    git(nested, ["config", "user.name", "Nested"]);
    await writeFile(join(nested, "file.txt"), "nested\n", "utf8");
    git(nested, ["add", "file.txt"]);
    git(nested, ["commit", "-m", "nested"]);
    git(gitlink.child.path, ["add", "nested"]);
    const gitlinkResult = await captureAndAdmitSwarmCandidate({
      ...gitlink.input,
      declaredPaths: ["nested"]
    });
    expect(gitlinkResult.admission.reasonCode).toBe("unsafe_path");
  });

  it("rejects same-path and new-path writes between validation and staging", async () => {
    for (const beforeStage of [
      async (fixture: CandidateFixture) => writeFile(join(fixture.child.path, "tracked.txt"), "raced\n", "utf8"),
      async (fixture: CandidateFixture) => writeFile(join(fixture.child.path, "late.txt"), "late\n", "utf8")
    ]) {
      const fixture = await createCandidateFixture();
      await writeFile(join(fixture.child.path, "tracked.txt"), "changed\n", "utf8");
      const result = await captureAndAdmitSwarmCandidate({
        ...fixture.input,
        declaredPaths: ["tracked.txt"],
        beforeStage: async () => beforeStage(fixture)
      });
      expect(result.admission.reasonCode).toBe("candidate_changed_during_capture");
      expect(fixture.writer.candidates).toHaveLength(0);
    }
  });

  it("withholds cleanup authority when durable candidate and decision persistence fail", async () => {
    const fixture = await createCandidateFixture();
    await writeFile(join(fixture.child.path, "tracked.txt"), "changed\n", "utf8");
    const failingWriter: SwarmCandidateArtifactWriter = {
      async loadProcessClosure(childRunId) {
        return fixture.writer.processClosures.get(childRunId);
      },
      async persistCandidate() { throw new Error("durable store unavailable"); },
      async persistDecision() { throw new Error("durable store unavailable"); }
    };
    const result = await captureAndAdmitSwarmCandidate({
      ...fixture.input,
      artifactWriter: failingWriter,
      declaredPaths: ["tracked.txt"]
    });
    expect(result.admission.reasonCode).toBe("artifact_persistence_failed");
    expect(result.cleanupAuthorized).toBe(false);
  });
});

describe("deterministic parent integration", () => {
  it("orders out-of-order candidates by the task DAG and applies only the safe Git sequence", async () => {
    const fixture = await createIntegrationFixture([
      { taskId: "task-a", agentId: "agent-a", runId: "run-a", candidateId: "candidate-a", file: "a.txt", content: "A\n", dependsOn: [] },
      { taskId: "task-b", agentId: "agent-b", runId: "run-b", candidateId: "candidate-b", file: "b.txt", content: "B\n", dependsOn: ["task-a"] }
    ]);

    const result = await integrateSwarmCandidates({
      swarmRecord: fixture.swarmRecord,
      workspaceManager: fixture.manager,
      integrationWorkspaceId: fixture.integrationWorkspaceId,
      candidates: [fixture.candidates[1]!, fixture.candidates[0]!],
      evidenceStore: fixture.store,
      gitRunner: fixture.gitRunner,
      now: fixture.now,
      createId: fixture.createId
    });

    expect(result.completed).toBe(true);
    expect(result.admittedCandidateIds).toEqual(["candidate-a", "candidate-b"]);
    expect(await readFile(join(result.workspace.path, "a.txt"), "utf8")).toBe("A\n");
    expect(await readFile(join(result.workspace.path, "b.txt"), "utf8")).toBe("B\n");
    expect(result.events.map((event) => event.type)).toEqual([
      "CHILD_PATCH_ADMITTED",
      "CHILD_PATCH_ADMITTED"
    ]);
    const applyCalls = fixture.gitCalls.filter((args) => args[2] === "apply");
    expect(applyCalls).toEqual([
      ["-c", "core.autocrlf=false", "apply", "--check", "--index", "-"],
      ["-c", "core.autocrlf=false", "apply", "--index", "-"],
      ["-c", "core.autocrlf=false", "apply", "--check", "--index", "-"],
      ["-c", "core.autocrlf=false", "apply", "--index", "-"]
    ]);
    expect(fixture.gitCalls.flat().some((arg) => [
      "--3way", "--ours", "--theirs", "--union", "--reject", "--unsafe-paths",
      "merge", "reset", "checkout", "force", "prune"
    ].includes(arg))).toBe(false);
    expect(gitText(fixture.canonicalRoot, ["status", "--porcelain=v1"])).toBe("");
  }, 60_000);

  it("records a blocking conflict and leaves the last admitted tree unchanged", async () => {
    const fixture = await createIntegrationFixture([
      { taskId: "task-a", agentId: "agent-a", runId: "run-a", candidateId: "candidate-a", file: "shared.txt", content: "first\n", dependsOn: [] },
      { taskId: "task-b", agentId: "agent-b", runId: "run-b", candidateId: "candidate-b", file: "shared.txt", content: "second\n", dependsOn: ["task-a"] }
    ]);
    const result = await integrateSwarmCandidates({
      swarmRecord: fixture.swarmRecord,
      workspaceManager: fixture.manager,
      integrationWorkspaceId: fixture.integrationWorkspaceId,
      candidates: fixture.candidates,
      evidenceStore: fixture.store,
      gitRunner: fixture.gitRunner,
      now: fixture.now,
      createId: fixture.createId
    });

    expect(result.completed).toBe(false);
    expect(result.admittedCandidateIds).toEqual(["candidate-a"]);
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0]).toMatchObject({
      candidateId: "candidate-b",
      state: "blocking",
      paths: ["shared.txt"]
    });
    expect(await readFile(join(result.workspace.path, "shared.txt"), "utf8")).toBe("first\n");
    expect(result.finalTreeHash).toBe(result.decisions[0]?.postIntegrationTreeHash);
  }, 60_000);

  it("rejects tampered bytes, stale pre-tree evidence, duplicates, and aliases before mutation", async () => {
    const tamperedFixture = await createIntegrationFixture([
      { taskId: "task-a", agentId: "agent-a", runId: "run-a", candidateId: "candidate-a", file: "a.txt", content: "A\n", dependsOn: [] }
    ]);
    const source = tamperedFixture.store.candidates.get("candidate-a")!;
    tamperedFixture.store.candidates.set("candidate-a", {
      ...source,
      patch: Buffer.concat([source.patch, Buffer.from("tamper")])
    });
    const tamperedResult = await integrateSwarmCandidates({
      swarmRecord: tamperedFixture.swarmRecord,
      workspaceManager: tamperedFixture.manager,
      integrationWorkspaceId: tamperedFixture.integrationWorkspaceId,
      candidates: tamperedFixture.candidates,
      evidenceStore: tamperedFixture.store,
      gitRunner: tamperedFixture.gitRunner,
      now: tamperedFixture.now,
      createId: tamperedFixture.createId
    });
    expect(tamperedResult.decisions[0]?.reasonCode).toBe("patch_hash_mismatch");
    expect(tamperedFixture.gitCalls.some((args) => args.includes("apply"))).toBe(false);

    const staleFixture = await createIntegrationFixture([
      { taskId: "task-a", agentId: "agent-a", runId: "run-a", candidateId: "candidate-a", file: "a.txt", content: "A\n", dependsOn: [] }
    ]);
    const admission = staleFixture.store.admissions.get("candidate-a")!;
    staleFixture.store.admissions.set("candidate-a", { ...admission, preIntegrationTreeHash: "f".repeat(40) });
    const staleResult = await integrateSwarmCandidates({
      swarmRecord: staleFixture.swarmRecord,
      workspaceManager: staleFixture.manager,
      integrationWorkspaceId: staleFixture.integrationWorkspaceId,
      candidates: staleFixture.candidates,
      evidenceStore: staleFixture.store,
      gitRunner: staleFixture.gitRunner,
      now: staleFixture.now,
      createId: staleFixture.createId
    });
    expect(staleResult.decisions[0]?.reasonCode).toBe("integration_precondition_failed");

    const duplicateFixture = await createIntegrationFixture([
      { taskId: "task-a", agentId: "agent-a", runId: "run-a", candidateId: "candidate-a", file: "a.txt", content: "A\n", dependsOn: [] }
    ]);
    await expect(integrateSwarmCandidates({
      swarmRecord: duplicateFixture.swarmRecord,
      workspaceManager: duplicateFixture.manager,
      integrationWorkspaceId: duplicateFixture.integrationWorkspaceId,
      candidates: [duplicateFixture.candidates[0]!, duplicateFixture.candidates[0]!],
      evidenceStore: duplicateFixture.store,
      gitRunner: duplicateFixture.gitRunner
    })).rejects.toThrow(/duplicate|aliased/iu);
  }, 60_000);

  it("reconstructs from baseline plus prior admitted patches after apply fails post-check", async () => {
    const fixture = await createIntegrationFixture([
      { taskId: "task-a", agentId: "agent-a", runId: "run-a", candidateId: "candidate-a", file: "a.txt", content: "A\n", dependsOn: [] },
      { taskId: "task-b", agentId: "agent-b", runId: "run-b", candidateId: "candidate-b", file: "b.txt", content: "B\n", dependsOn: ["task-a"] }
    ]);
    let applyCount = 0;
    let injected = false;
    const failingRunner = async (command: SwarmIntegrationGitCommand): Promise<SwarmIntegrationGitResult> => {
      if (command.args[2] === "apply" && command.args[3] === "--index") {
        applyCount += 1;
        if (applyCount === 2 && !injected) {
          injected = true;
          throw new Error("simulated apply-after-check failure");
        }
      }
      return fixture.gitRunner(command);
    };
    const result = await integrateSwarmCandidates({
      swarmRecord: fixture.swarmRecord,
      workspaceManager: fixture.manager,
      integrationWorkspaceId: fixture.integrationWorkspaceId,
      candidates: fixture.candidates,
      evidenceStore: fixture.store,
      gitRunner: failingRunner,
      now: fixture.now,
      createId: fixture.createId,
      createReconstructionWorkspaceId: () => "integration-recovery-1"
    });

    expect(result.completed).toBe(false);
    expect(result.admittedCandidateIds).toEqual(["candidate-a"]);
    expect(result.decisions.at(-1)?.reasonCode).toBe("integration_apply_failed");
    expect(result.reconstructions).toMatchObject([{ state: "completed", replayedCandidateIds: ["candidate-a"] }]);
    expect(await readFile(join(result.workspace.path, "a.txt"), "utf8")).toBe("A\n");
    expect(await readFile(join(result.workspace.path, "b.txt"), "utf8")).toBe("baseline\n");
    expect(result.finalTreeHash).toBe(result.reconstructions[0]?.actualTreeHash);
  }, 60_000);

  it("rejects a durable candidate replay across separate integration invocations", async () => {
    const fixture = await createIntegrationFixture([
      { taskId: "task-a", agentId: "agent-a", runId: "run-a", candidateId: "candidate-a", file: "a.txt", content: "A\n", dependsOn: [] }
    ]);
    const first = await integrateSwarmCandidates({
      swarmRecord: fixture.swarmRecord,
      workspaceManager: fixture.manager,
      integrationWorkspaceId: fixture.integrationWorkspaceId,
      candidates: fixture.candidates,
      evidenceStore: fixture.store,
      gitRunner: fixture.gitRunner
    });
    expect(first.completed).toBe(true);

    const second = await integrateSwarmCandidates({
      swarmRecord: fixture.swarmRecord,
      workspaceManager: fixture.manager,
      integrationWorkspaceId: "integration-replay-attempt",
      candidates: fixture.candidates,
      evidenceStore: fixture.store,
      gitRunner: fixture.gitRunner
    });
    expect(second.completed).toBe(false);
    expect(second.decisions).toMatchObject([{ reasonCode: "integration_precondition_failed" }]);
    expect(second.admittedCandidateIds).toEqual([]);
  }, 60_000);

  it("stops reconstruction when the failed integration workspace cannot be removed", async () => {
    const fixture = await createIntegrationFixture([
      { taskId: "task-a", agentId: "agent-a", runId: "run-a", candidateId: "candidate-a", file: "a.txt", content: "A\n", dependsOn: [] }
    ]);
    let applyFailed = false;
    const failingRunner = async (command: SwarmIntegrationGitCommand): Promise<SwarmIntegrationGitResult> => {
      if (command.args[2] === "apply" && command.args[3] === "--index" && !applyFailed) {
        applyFailed = true;
        throw new Error("simulated apply failure");
      }
      return fixture.gitRunner(command);
    };
    const cleanupPendingManager: SwarmWorkspaceManager = {
      ...fixture.manager,
      async removeWorkspace(handle): Promise<SwarmCleanupRecord> {
        return {
          schemaVersion: SWARM_SCHEMA_VERSION,
          cleanupId: "cleanup-pending",
          swarmId: fixture.swarmRecord.swarmId,
          workspaceId: handle.record.workspaceId,
          workspaceKind: handle.record.kind,
          evidencePersisted: true,
          processCloseState: "closed",
          removalState: "failed",
          state: "cleanup_pending",
          attemptedAt: "2026-10-03T00:00:05.000Z",
          errorCode: "EBUSY"
        };
      }
    };
    const result = await integrateSwarmCandidates({
      swarmRecord: fixture.swarmRecord,
      workspaceManager: cleanupPendingManager,
      integrationWorkspaceId: fixture.integrationWorkspaceId,
      candidates: fixture.candidates,
      evidenceStore: fixture.store,
      gitRunner: failingRunner
    });
    expect(result.completed).toBe(false);
    expect(result.reconstructions).toMatchObject([{
      state: "failed",
      replacementWorkspaceId: fixture.integrationWorkspaceId,
      cleanup: { state: "cleanup_pending" }
    }]);
    expect(result.workspace.record.workspaceId).toBe(fixture.integrationWorkspaceId);
  }, 60_000);

  it("does not emit an admitted event when its atomic evidence write fails", async () => {
    const fixture = await createIntegrationFixture([
      { taskId: "task-a", agentId: "agent-a", runId: "run-a", candidateId: "candidate-a", file: "a.txt", content: "A\n", dependsOn: [] }
    ]);
    fixture.store.failNextOutcome = true;
    const result = await integrateSwarmCandidates({
      swarmRecord: fixture.swarmRecord,
      workspaceManager: fixture.manager,
      integrationWorkspaceId: fixture.integrationWorkspaceId,
      candidates: fixture.candidates,
      evidenceStore: fixture.store,
      gitRunner: fixture.gitRunner,
      now: fixture.now,
      createId: fixture.createId,
      createReconstructionWorkspaceId: () => "integration-recovery-persist"
    });

    expect(result.completed).toBe(false);
    expect(result.admittedCandidateIds).toEqual([]);
    expect(result.events.some((event) => event.type === "CHILD_PATCH_ADMITTED")).toBe(false);
    expect(result.decisions.at(-1)?.reasonCode).toBe("artifact_persistence_failed");
    expect(result.reconstructions[0]?.state).toBe("completed");
    expect(result.finalTreeHash).toBe(gitText(fixture.canonicalRoot, [
      "rev-parse", `${fixture.manager.baselineCommit}^{tree}`
    ]));
  }, 60_000);
});

class MemoryCandidateWriter implements SwarmCandidateArtifactWriter {
  readonly candidates: PersistedSwarmCandidateArtifact[] = [];
  readonly decisions: SwarmPatchAdmission[] = [];
  readonly candidateIds = new Set<string>();
  readonly processClosures = new Map<string, SwarmProcessClosureEvidence>();

  async loadProcessClosure(childRunId: string): Promise<SwarmProcessClosureEvidence | undefined> {
    return this.processClosures.get(childRunId);
  }

  async persistCandidate(artifact: PersistedSwarmCandidateArtifact): Promise<void> {
    if (this.candidateIds.has(artifact.candidate.candidateId)) throw new Error("duplicate candidate");
    this.candidateIds.add(artifact.candidate.candidateId);
    this.candidates.push({ ...artifact, patch: Buffer.from(artifact.patch), manifest: Buffer.from(artifact.manifest) });
  }

  async persistDecision(decision: SwarmPatchAdmission): Promise<void> {
    this.decisions.push(decision);
  }
}

class MemoryIntegrationStore implements SwarmIntegrationEvidenceStore {
  readonly admissions = new Map<string, SwarmPatchAdmission>();
  readonly candidates = new Map<string, PersistedSwarmCandidateArtifact>();
  readonly claims = new Set<string>();
  readonly outcomes: SwarmIntegrationEvidenceBundle[] = [];
  readonly reconstructions: import("../src/swarm/integration.js").SwarmIntegrationReconstruction[] = [];
  failNextOutcome = false;

  async loadPersistedCandidate(candidateId: string): Promise<PersistedSwarmCandidateArtifact | undefined> {
    return this.candidates.get(candidateId);
  }

  async loadPersistedAdmission(candidateId: string): Promise<SwarmPatchAdmission | undefined> {
    return this.admissions.get(candidateId);
  }

  async claimCandidateIntegration(input: {
    swarmId: string;
    candidateId: string;
    identitySha256: string;
  }): Promise<"claimed" | "already_claimed"> {
    const key = `${input.swarmId}:${input.candidateId}`;
    if (this.claims.has(key)) return "already_claimed";
    this.claims.add(key);
    return "claimed";
  }

  async persistOutcome(bundle: SwarmIntegrationEvidenceBundle): Promise<void> {
    if (this.failNextOutcome) {
      this.failNextOutcome = false;
      throw new Error("simulated atomic evidence failure");
    }
    this.outcomes.push(bundle);
  }

  async persistReconstruction(
    record: import("../src/swarm/integration.js").SwarmIntegrationReconstruction
  ): Promise<void> {
    this.reconstructions.push(record);
  }
}

interface IntegrationCandidateSpec {
  taskId: string;
  agentId: string;
  runId: string;
  candidateId: string;
  file: string;
  content: string;
  dependsOn: string[];
}

interface IntegrationFixture {
  canonicalRoot: string;
  manager: SwarmWorkspaceManager;
  integrationWorkspaceId: string;
  swarmRecord: SwarmRunRecord;
  candidates: SwarmIntegrationCandidate[];
  store: MemoryIntegrationStore;
  gitCalls: string[][];
  gitRunner: (command: SwarmIntegrationGitCommand) => Promise<SwarmIntegrationGitResult>;
  now: () => string;
  createId: (prefix: string) => string;
}

async function createIntegrationFixture(specs: readonly IntegrationCandidateSpec[]): Promise<IntegrationFixture> {
  const scratchRoot = await mkdtemp(join(tmpdir(), "martin-swarm-integration-"));
  scratchRoots.push(scratchRoot);
  process.env["MARTIN_INTEGRITY_KEY_DIR"] = join(scratchRoot, "integrity-keys");
  const canonicalRoot = join(scratchRoot, "canonical");
  await mkdir(canonicalRoot, { recursive: true });
  git(canonicalRoot, ["init"]);
  git(canonicalRoot, ["config", "user.email", "swarm-integration@test.invalid"]);
  git(canonicalRoot, ["config", "user.name", "Swarm Integration Test"]);
  git(canonicalRoot, ["config", "core.autocrlf", "false"]);
  await writeFile(join(canonicalRoot, ".gitignore"), ".martin/\n", "utf8");
  for (const file of new Set(specs.map((spec) => spec.file))) {
    await mkdir(join(canonicalRoot, ...file.split("/").slice(0, -1)), { recursive: true });
    await writeFile(join(canonicalRoot, file), "baseline\n", "utf8");
  }
  git(canonicalRoot, ["add", "."]);
  git(canonicalRoot, ["commit", "-m", "integration baseline"]);
  const manager = await createSwarmWorkspaceManager({
    canonicalRoot,
    ownedRoot: join(canonicalRoot, ".martin", "swarms", "swarm-001", "worktrees"),
    swarmId: "swarm-001"
  });
  const swarmRecord = createMultiAgentSwarmRecord(manager.baselineCommit, specs);
  const store = new MemoryIntegrationStore();
  const candidates: SwarmIntegrationCandidate[] = [];
  const runsRoot = join(scratchRoot, "runs");

  for (const spec of specs) {
    const child = await manager.createWorkspace({
      kind: "child",
      workspaceId: `workspace-${spec.agentId}`,
      childRunId: spec.runId,
      agentId: spec.agentId,
      taskIds: [spec.taskId]
    });
    await mkdir(join(child.path, ...spec.file.split("/").slice(0, -1)), { recursive: true });
    await writeFile(join(child.path, spec.file), spec.content, "utf8");
    const runDir = join(runsRoot, spec.runId);
    const loopRecordPath = join(runDir, "loop-record.json");
    const ledgerPath = join(runDir, "ledger.jsonl");
    const loop = createLoopRecord({
      loopId: spec.runId,
      workspaceId: child.record.workspaceId,
      projectId: "project-swarm",
      task: { title: spec.taskId, objective: "Produce an integration candidate.", verificationPlan: [] },
      metadata: {
        "swarm.parentId": "swarm-001",
        "swarm.agentId": spec.agentId,
        "swarm.taskIds": JSON.stringify([spec.taskId]),
        "swarm.attemptId": `attempt-${spec.taskId}`,
        "swarm.proposalId": `proposal-${spec.taskId}`,
        "swarm.baselineCommit": manager.baselineCommit
      },
      receiptScope: { repoRoot: child.path, workingDirectory: child.path }
    }, { now: "2026-10-03T00:00:00.000Z", idFactory: (prefix) => `${prefix}-${spec.taskId}` });
    loop.status = "completed";
    loop.lifecycleState = "completed";
    const ledgerEntries = [{
      eventId: `evt-${spec.taskId}`,
      kind: "run.completed",
      runId: spec.runId,
      timestamp: "2026-10-03T00:00:01.000Z",
      payload: { status: "completed" }
    }];
    await mkdir(runDir, { recursive: true });
    await writeFile(loopRecordPath, `${JSON.stringify(loop, null, 2)}\n`, "utf8");
    await writeFile(ledgerPath, `${JSON.stringify(ledgerEntries[0])}\n`, "utf8");
    await writeReceiptIntegrityMaterial({
      runId: spec.runId,
      runsRoot,
      loopRecord: loop,
      ledgerEntries,
      scope: loop.receiptScope,
      signedAt: "2026-10-03T00:00:02.000Z"
    });
    const writer = new MemoryCandidateWriter();
    writer.processClosures.set(spec.runId, {
      swarmId: "swarm-001",
      workspaceId: child.record.workspaceId,
      childRunId: spec.runId,
      agentId: spec.agentId,
      state: "closed",
      completedAt: "2026-10-03T00:00:02.500Z"
    });
    const captured = await captureAndAdmitSwarmCandidate({
      swarmRecord,
      canonicalRoot,
      swarmId: "swarm-001",
      candidateId: spec.candidateId,
      admissionId: `admission-${spec.candidateId}`,
      attemptId: `attempt-${spec.taskId}`,
      proposalId: `proposal-${spec.taskId}`,
      childRunId: spec.runId,
      agentId: spec.agentId,
      taskIds: [spec.taskId],
      expectedBaselineCommit: manager.baselineCommit,
      workspace: child,
      childState: "verified",
      declaredPaths: [spec.file],
      childAllowedPaths: [spec.file],
      inheritedDeniedPaths: ["secrets/**"],
      taskWriteScope: [spec.file],
      runsRoot,
      loopRecordPath,
      ledgerPath,
      artifactWriter: writer,
      now: () => "2026-10-03T00:00:03.000Z"
    });
    expect(captured.admission.reasonCode).toBe("admitted");
    expect(captured.artifact).toBeDefined();
    store.admissions.set(spec.candidateId, captured.admission);
    store.candidates.set(spec.candidateId, captured.artifact!);
    candidates.push({ candidateId: spec.candidateId });
  }

  const gitCalls: string[][] = [];
  const gitRunner = async (command: SwarmIntegrationGitCommand): Promise<SwarmIntegrationGitResult> => {
    gitCalls.push([...command.args]);
    return runIntegrationGitBuffer(command);
  };
  let idCounter = 0;
  return {
    canonicalRoot,
    manager,
    integrationWorkspaceId: "integration-primary",
    swarmRecord,
    candidates,
    store,
    gitCalls,
    gitRunner,
    now: () => "2026-10-03T00:00:04.000Z",
    createId: (prefix) => `${prefix}-${String(++idCounter)}`
  };
}

function createMultiAgentSwarmRecord(
  baselineCommit: string,
  specs: readonly IntegrationCandidateSpec[]
): SwarmRunRecord {
  const record = createSwarmRecord(baselineCommit);
  return {
    ...record,
    tasks: specs.map((spec) => ({
      taskId: spec.taskId,
      title: spec.taskId,
      objective: `Apply ${spec.file}.`,
      required: true,
      dependsOn: [...spec.dependsOn],
      assignedAgentId: spec.agentId,
      status: "accepted",
      mutationMode: "write",
      writeScope: [spec.file]
    })),
    agents: specs.map((spec) => ({
      agentId: spec.agentId,
      role: "implementer",
      status: "verified",
      childRunId: spec.runId,
      contract: {
        agentId: spec.agentId,
        taskIds: [spec.taskId],
        scope: { allowedPaths: [spec.file], deniedPaths: ["secrets/**"] },
        budget: { maxUsd: 1, softLimitUsd: 0.8, maxIterations: 2, maxTokens: 1000 },
        maxWallClockMs: 60_000,
        permissions: { networkDomains: [], commands: ["git"] },
        approvalPolicy: {},
        verifierAuthority: "child_only"
      }
    }))
  };
}

async function createCandidateFixture(options: {
  receipt?: boolean;
  isolationMode?: "worktree" | "independent_clone";
} = {}): Promise<CandidateFixture> {
  const scratchRoot = await mkdtemp(join(tmpdir(), "martin-swarm-candidate-"));
  scratchRoots.push(scratchRoot);
  process.env["MARTIN_INTEGRITY_KEY_DIR"] = join(scratchRoot, "integrity-keys");
  const canonicalRoot = join(scratchRoot, "canonical");
  await mkdir(canonicalRoot, { recursive: true });
  git(canonicalRoot, ["init"]);
  git(canonicalRoot, ["config", "user.email", "swarm@test.invalid"]);
  git(canonicalRoot, ["config", "user.name", "Swarm Test"]);
  git(canonicalRoot, ["config", "core.autocrlf", "false"]);
  await writeFile(join(canonicalRoot, ".gitignore"), ".martin/\n", "utf8");
  await writeFile(join(canonicalRoot, "tracked.txt"), "baseline\n", "utf8");
  await writeFile(join(canonicalRoot, "deleted.txt"), "delete me\n", "utf8");
  git(canonicalRoot, ["add", ".gitignore", "tracked.txt", "deleted.txt"]);
  git(canonicalRoot, ["commit", "-m", "baseline"]);

  const manager = await createSwarmWorkspaceManager({
    canonicalRoot,
    ownedRoot: join(canonicalRoot, ".martin", "swarms", "swarm-001", "worktrees"),
    swarmId: "swarm-001",
    ...(options.isolationMode ? { isolationMode: options.isolationMode } : {})
  });
  const child = await manager.createWorkspace({
    kind: "child",
    workspaceId: "workspace-agent-01",
    childRunId: "loop-child-01",
    agentId: "agent-01",
    taskIds: ["task-01"]
  });
  const swarmRecord = createSwarmRecord(child.record.baselineCommit);
  const runsRoot = join(scratchRoot, "runs");
  const runDir = join(runsRoot, "loop-child-01");
  const loopRecordPath = join(runDir, "loop-record.json");
  const ledgerPath = join(runDir, "ledger.jsonl");
  const loop = createLoopRecord({
    loopId: "loop-child-01",
    workspaceId: child.record.workspaceId,
    projectId: "project-swarm",
    task: { title: "Swarm child", objective: "Produce one isolated candidate.", verificationPlan: [] },
    metadata: {
      "swarm.parentId": "swarm-001",
      "swarm.agentId": "agent-01",
      "swarm.taskIds": JSON.stringify(["task-01"]),
      "swarm.attemptId": "attempt-01",
      "swarm.proposalId": "proposal-01",
      "swarm.baselineCommit": child.record.baselineCommit
    },
    receiptScope: { repoRoot: child.path, workingDirectory: child.path }
  }, { now: "2026-10-03T00:00:00.000Z", idFactory: (prefix) => `${prefix}-fixture` });
  loop.status = "completed";
  loop.lifecycleState = "completed";
  const ledgerEntries = [{
    eventId: "evt-child-completed",
    kind: "run.completed",
    runId: loop.loopId,
    timestamp: "2026-10-03T00:00:01.000Z",
    payload: { status: "completed" }
  }];
  await mkdir(runDir, { recursive: true });
  await writeFile(loopRecordPath, `${JSON.stringify(loop, null, 2)}\n`, "utf8");
  await writeFile(ledgerPath, `${ledgerEntries.map((entry) => JSON.stringify(entry)).join("\n")}\n`, "utf8");
  if (options.receipt !== false) {
    await writeReceiptIntegrityMaterial({
      runId: loop.loopId,
      runsRoot,
      loopRecord: loop,
      ledgerEntries,
      scope: loop.receiptScope,
      signedAt: "2026-10-03T00:00:02.000Z"
    });
  }

  const writer = new MemoryCandidateWriter();
  writer.processClosures.set(loop.loopId, {
    swarmId: "swarm-001",
    workspaceId: child.record.workspaceId,
    childRunId: loop.loopId,
    agentId: "agent-01",
    state: "closed",
    completedAt: "2026-10-03T00:00:02.500Z"
  });
  const gitCalls: string[][] = [];
  const gitRunner = async (command: SwarmCandidateGitCommand): Promise<SwarmCandidateGitResult> => {
    gitCalls.push([...command.args]);
    return runGitBuffer(command);
  };
  const input: CaptureSwarmCandidateInput = {
    swarmRecord,
    canonicalRoot,
    swarmId: "swarm-001",
    candidateId: "candidate-01",
    admissionId: "admission-01",
    attemptId: "attempt-01",
    proposalId: "proposal-01",
    childRunId: "loop-child-01",
    agentId: "agent-01",
    taskIds: ["task-01"],
    expectedBaselineCommit: child.record.baselineCommit,
    workspace: child,
    childState: "verified",
    declaredPaths: [],
    childAllowedPaths: ["**"],
    inheritedDeniedPaths: ["secrets/**"],
    taskWriteScope: ["**"],
    runsRoot,
    loopRecordPath,
    ledgerPath,
    artifactWriter: writer,
    gitRunner,
    now: () => "2026-10-03T00:00:03.000Z"
  };
  return { scratchRoot, canonicalRoot, child, input, writer, gitCalls, loopRecordPath };
}

function createSwarmRecord(baselineCommit: string): SwarmRunRecord {
  const budget = { maxUsd: 1, softLimitUsd: 0.8, maxIterations: 2, maxTokens: 1000 };
  return {
    schemaVersion: SWARM_SCHEMA_VERSION,
    swarmId: "swarm-001",
    workspaceId: "parent-workspace",
    projectId: "project-swarm",
    parentContract: {
      policyVersion: "swarm-policy-v1",
      objective: "Integrate one governed candidate.",
      definitionOfDone: ["Candidate is verified."],
      budget,
      maxWallClockMs: 60_000,
      maxConcurrency: 1,
      scope: { allowedPaths: ["**"], deniedPaths: ["secrets/**"] },
      permissions: { networkDomains: [], commands: ["git"] },
      integrationStrategy: "parent_fan_in",
      globalVerifierStack: [{ command: "node --test", type: "test_full" }],
      stopPolicy: {
        budgetExhausted: "stop",
        blockingFailure: "stop",
        verifierFailure: "needs_review"
      },
      recoveryPolicy: { maxReassignmentsPerTask: 1, dependencyWaiversAllowed: false },
      approvalPolicy: {},
      orchestrationStrategy: "hierarchical_dag"
    },
    tasks: [{
      taskId: "task-01",
      title: "Candidate task",
      objective: "Change governed files.",
      required: true,
      dependsOn: [],
      assignedAgentId: "agent-01",
      status: "accepted",
      mutationMode: "write",
      writeScope: ["**"]
    }],
    agents: [{
      agentId: "agent-01",
      role: "implementer",
      status: "verified",
      childRunId: "loop-child-01",
      contract: {
        agentId: "agent-01",
        taskIds: ["task-01"],
        scope: { allowedPaths: ["**"], deniedPaths: ["secrets/**"] },
        budget,
        maxWallClockMs: 60_000,
        permissions: { networkDomains: [], commands: ["git"] },
        approvalPolicy: {},
        verifierAuthority: "child_only"
      }
    }],
    dependencyWaivers: [],
    budgetLedger: {
      capUsd: budget.maxUsd,
      capTokens: budget.maxTokens,
      settledUsd: 0,
      settledTokens: 0,
      leases: []
    },
    conflicts: [],
    verification: [],
    outcome: { state: "running", reason: "Candidate admission is active." },
    events: [],
    createdAt: "2026-10-03T00:00:00.000Z",
    updatedAt: "2026-10-03T00:00:00.000Z"
  };
}

function git(cwd: string, args: readonly string[]): void {
  const result = spawnSync("git", [...args], { cwd, encoding: "utf8", windowsHide: true });
  if (result.status !== 0) throw new Error(result.stderr || `git ${args.join(" ")} failed`);
}

function gitText(cwd: string, args: readonly string[]): string {
  const result = spawnSync("git", [...args], { cwd, encoding: "utf8", windowsHide: true });
  if (result.status !== 0) throw new Error(result.stderr || `git ${args.join(" ")} failed`);
  return result.stdout.trim();
}

function runGitBuffer(command: SwarmCandidateGitCommand): SwarmCandidateGitResult {
  const result = spawnSync("git", [...command.args], {
    cwd: command.cwd,
    encoding: null,
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024
  });
  if (result.status !== 0) {
    throw Object.assign(
      new Error(result.stderr?.toString("utf8") || `git ${command.args.join(" ")} failed`),
      { stderr: result.stderr }
    );
  }
  return { stdout: result.stdout ?? Buffer.alloc(0), stderr: result.stderr ?? Buffer.alloc(0) };
}

function runIntegrationGitBuffer(command: SwarmIntegrationGitCommand): SwarmIntegrationGitResult {
  const result = spawnSync("git", [...command.args], {
    cwd: command.cwd,
    encoding: null,
    input: command.stdin,
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024
  });
  if (result.status !== 0) {
    throw Object.assign(
      new Error(result.stderr?.toString("utf8") || `git ${command.args.join(" ")} failed`),
      { stderr: result.stderr }
    );
  }
  return { stdout: result.stdout ?? Buffer.alloc(0), stderr: result.stderr ?? Buffer.alloc(0) };
}

function sha256(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}
