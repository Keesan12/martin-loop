import { spawnSync } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  createSwarmWorkspaceManager,
  SwarmWorkspaceCreationError,
  type SwarmGitCommand,
  type SwarmGitResult,
  type SwarmGitRunner,
  type SwarmWorkspaceFs,
  type SwarmWorkspaceRuntimeHandle
} from "../src/swarm/workspaces.js";

interface GitCall {
  cwd: string;
  args: readonly string[];
}

interface RepoFixture {
  scratchRoot: string;
  canonicalRoot: string;
  ownedRoot: string;
  baselineCommit: string;
}

const scratchRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    scratchRoots.splice(0).map((root) => rm(root, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 50
    }))
  );
});

describe("swarm detached worktree lifecycle", () => {
  it("reserves identities atomically while independent workspace operations run concurrently", async () => {
    const canonicalRoot = resolve("virtual-canonical");
    const ownedRoot = join(canonicalRoot, ".martin", "swarms", "swarm-concurrent", "worktrees");
    const baselineCommit = "a".repeat(40);
    const existing = new Set<string>([canonicalRoot]);
    let createCalls = 0;
    let removeCalls = 0;
    let releaseCreates!: () => void;
    let releaseRemoves!: () => void;
    let notifyCreateEntered!: () => void;
    let notifyRemoveEntered!: () => void;
    const createGate = new Promise<void>((resolveGate) => { releaseCreates = resolveGate; });
    const removeGate = new Promise<void>((resolveGate) => { releaseRemoves = resolveGate; });
    const createEntered = new Promise<void>((resolveEntered) => { notifyCreateEntered = resolveEntered; });
    const removeEntered = new Promise<void>((resolveEntered) => { notifyRemoveEntered = resolveEntered; });
    const fs: SwarmWorkspaceFs = {
      async mkdir(path) { existing.add(resolve(path)); },
      async realpath(path) {
        const canonical = resolve(path);
        if (!existing.has(canonical)) throw Object.assign(new Error("missing virtual path"), { code: "ENOENT" });
        return canonical;
      },
      async pathExists(path) { return existing.has(resolve(path)); },
      async rm(path) {
        removeCalls += 1;
        notifyRemoveEntered();
        await removeGate;
        const target = resolve(path);
        for (const candidate of [...existing]) {
          if (candidate === target || candidate.startsWith(`${target}\\`) || candidate.startsWith(`${target}/`)) {
            existing.delete(candidate);
          }
        }
      }
    };
    const runner: SwarmGitRunner = async (command) => {
      if (command.args[0] === "clone") {
        createCalls += 1;
        notifyCreateEntered();
        await createGate;
        const workspacePath = resolve(command.args.at(-1)!);
        existing.add(workspacePath);
        existing.add(join(workspacePath, ".git"));
      }
      if (command.args[0] === "rev-parse" && command.args[1] === "--show-toplevel") {
        return { stdout: `${resolve(command.cwd)}\n`, stderr: "" };
      }
      if (command.args[0] === "rev-parse" && command.args.includes("HEAD^{commit}")) {
        return { stdout: `${baselineCommit}\n`, stderr: "" };
      }
      if (command.args[0] === "rev-parse" && command.args[1] === "--git-dir") {
        return { stdout: ".git\n", stderr: "" };
      }
      return { stdout: "", stderr: "" };
    };
    const manager = await createSwarmWorkspaceManager({
      canonicalRoot,
      ownedRoot,
      swarmId: "swarm-concurrent-operations",
      isolationMode: "independent_clone",
      gitRunner: runner,
      fs
    });
    const firstCreate = manager.createWorkspace({ kind: "integration", workspaceId: "integration-concurrent" });
    const secondCreate = manager.createWorkspace({ kind: "verifier", workspaceId: "verifier-concurrent" });
    await createEntered;
    await expect(manager.createWorkspace({
      kind: "integration",
      workspaceId: "integration-concurrent"
    })).rejects.toMatchObject({ code: "DUPLICATE_WORKSPACE_ID" });
    await new Promise((resolveTick) => setImmediate(resolveTick));
    const overlappingCreates = createCalls;
    releaseCreates();
    const [integration, verifier] = await Promise.all([firstCreate, secondCreate]);

    const firstRemove = manager.removeWorkspace(integration, {
      evidencePersisted: true,
      processTreeClosed: true,
      force: true
    });
    const secondRemove = manager.removeWorkspace(verifier, {
      evidencePersisted: true,
      processTreeClosed: true,
      force: true
    });
    await removeEntered;
    await new Promise((resolveTick) => setImmediate(resolveTick));
    const overlappingRemoves = removeCalls;
    releaseRemoves();
    await expect(Promise.all([firstRemove, secondRemove])).resolves.toEqual([
      expect.objectContaining({ state: "completed" }),
      expect.objectContaining({ state: "completed" })
    ]);
    expect(overlappingCreates).toBe(2);
    expect(overlappingRemoves).toBe(2);
  });

  it("materializes canonical repository bytes independently of host autocrlf policy", async () => {
    const fixture = await createRepoFixture();
    runGit(fixture.canonicalRoot, ["config", "core.autocrlf", "true"]);
    const manager = await createSwarmWorkspaceManager({
      canonicalRoot: fixture.canonicalRoot,
      ownedRoot: fixture.ownedRoot,
      swarmId: "swarm-canonical-bytes"
    });

    const verifier = await manager.createWorkspace({
      kind: "verifier",
      workspaceId: "canonical-byte-verifier"
    });

    expect(await readFile(join(verifier.path, "tracked.txt"))).toEqual(Buffer.from("baseline\n"));
    runGitWithInput(verifier.path, ["-c", "core.autocrlf=false", "apply", "--index", "-"], Buffer.from([
      "diff --git a/replayed.txt b/replayed.txt",
      "new file mode 100644",
      "index 0000000..df967b9",
      "--- /dev/null",
      "+++ b/replayed.txt",
      "@@ -0,0 +1 @@",
      "+replayed",
      ""
    ].join("\n")));
    expect(await readFile(join(verifier.path, "replayed.txt"))).toEqual(Buffer.from("replayed\n"));

    await manager.removeWorkspace(verifier, {
      evidencePersisted: true,
      processTreeClosed: true,
      force: true
    });
  }, 60_000);

  it("creates child, integration, and verifier worktrees at one exact baseline without touching canonical state", async () => {
    const fixture = await createRepoFixture();
    const calls: GitCall[] = [];
    const manager = await createSwarmWorkspaceManager({
      canonicalRoot: fixture.canonicalRoot,
      ownedRoot: fixture.ownedRoot,
      swarmId: "swarm-001",
      gitRunner: recordingGitRunner(calls)
    });

    const child = await manager.createWorkspace({
      kind: "child",
      workspaceId: "agent-01",
      childRunId: "loop-child-01",
      agentId: "agent-01",
      taskIds: ["task-data"]
    });
    const integration = await manager.createWorkspace({
      kind: "integration",
      workspaceId: "integration"
    });
    const verifier = await manager.createWorkspace({
      kind: "verifier",
      workspaceId: "final-verifier"
    });

    expect(manager.baselineCommit).toBe(fixture.baselineCommit);
    expect(new Set([child.path, integration.path, verifier.path]).size).toBe(3);
    for (const handle of [child, integration, verifier]) {
      expect(resolve(handle.path)).not.toBe(resolve(fixture.canonicalRoot));
      expect(gitScalar(handle.path, ["rev-parse", "--verify", "HEAD^{commit}"])).toBe(fixture.baselineCommit);
      expect(handle.record.baselineCommit).toBe(fixture.baselineCommit);
      expect(handle.record).not.toHaveProperty("path");
    }
    expect(gitScalar(fixture.canonicalRoot, ["status", "--porcelain=v1", "-z", "--untracked-files=all"])).toBe("");

    const addCalls = calls.filter(({ args }) => args[0] === "-c" && args[2] === "worktree" && args[3] === "add");
    expect(addCalls).toHaveLength(3);
    expect(addCalls.map(({ args }) => args.slice(0, 5))).toEqual([
      ["-c", "core.autocrlf=false", "worktree", "add", "--detach"],
      ["-c", "core.autocrlf=false", "worktree", "add", "--detach"],
      ["-c", "core.autocrlf=false", "worktree", "add", "--detach"]
    ]);
    expect(addCalls.every(({ args }) => args.at(-1) === fixture.baselineCommit)).toBe(true);
    expect(calls.some(({ args }) => args.includes("prune") || args.includes("branch"))).toBe(false);

    for (const handle of [child, integration, verifier]) {
      const cleanup = await manager.removeWorkspace(handle, {
        evidencePersisted: true,
        processTreeClosed: true,
        force: true
      });
      expect(cleanup).toMatchObject({
        workspaceId: handle.record.workspaceId,
        evidencePersisted: true,
        processCloseState: "closed",
        removalState: "removed",
        state: "completed"
      });
      expect(cleanup).not.toHaveProperty("path");
    }

    const removeCalls = calls.filter(({ args }) => args[0] === "worktree" && args[1] === "remove");
    expect(removeCalls).toHaveLength(3);
    expect(removeCalls.every(({ args }) => args[2] === "--force" && args.length === 4)).toBe(true);
  }, 60_000);

  it("creates an independent clone with self-contained Git metadata and exact cleanup", async () => {
    const fixture = await createRepoFixture();
    const calls: GitCall[] = [];
    const manager = await createSwarmWorkspaceManager({
      canonicalRoot: fixture.canonicalRoot,
      ownedRoot: fixture.ownedRoot,
      swarmId: "swarm-clone",
      isolationMode: "independent_clone",
      gitRunner: recordingGitRunner(calls)
    });

    const child = await manager.createWorkspace({
      kind: "child",
      workspaceId: "clone-agent-01",
      childRunId: "clone-child-01",
      agentId: "agent-01",
      taskIds: ["task-data"]
    });

    expect(gitScalar(child.path, ["rev-parse", "--verify", "HEAD^{commit}"])).toBe(fixture.baselineCommit);
    expect(gitScalar(child.path, ["rev-parse", "--git-dir"])).toBe(".git");
    await access(join(child.path, ".git"));
    await writeFile(join(child.path, "clone-write-probe.txt"), "writable\n", "utf8");
    expect(gitScalar(fixture.canonicalRoot, ["status", "--porcelain=v1", "-z", "--untracked-files=all"])).toBe("");

    const cloneCalls = calls.filter(({ args }) => args[0] === "clone");
    expect(cloneCalls).toHaveLength(1);
    expect(cloneCalls[0]?.args.slice(0, 3)).toEqual(["clone", "--no-hardlinks", "--no-checkout"]);
    expect(calls).toContainEqual({
      cwd: resolve(child.path),
      args: ["-c", "core.autocrlf=false", "checkout", "--detach", fixture.baselineCommit]
    });
    expect(calls.some(({ args }) => args.includes("worktree") && args.includes("add"))).toBe(false);

    const cleanup = await manager.removeWorkspace(child, {
      evidencePersisted: true,
      processTreeClosed: true,
      force: true
    });
    expect(cleanup).toMatchObject({
      workspaceId: child.record.workspaceId,
      removalState: "removed",
      state: "completed"
    });
    await expect(access(child.path)).rejects.toThrow();
    expect(calls.some(({ args }) => args[0] === "worktree" && args[1] === "remove")).toBe(false);
  }, 60_000);

  it("rolls back a clone whose checkout fails and permits the same workspace ID to retry", async () => {
    const fixture = await createRepoFixture();
    const calls: GitCall[] = [];
    const realRunner = recordingGitRunner(calls);
    let failCheckout = true;
    const runner: SwarmGitRunner = async (command) => {
      if (command.args.includes("checkout") && failCheckout) {
        failCheckout = false;
        throw Object.assign(new Error("simulated checkout failure"), { code: "CHECKOUT_FAILED" });
      }
      return realRunner(command);
    };
    const manager = await createSwarmWorkspaceManager({
      canonicalRoot: fixture.canonicalRoot,
      ownedRoot: fixture.ownedRoot,
      swarmId: "swarm-clone-checkout-rollback",
      isolationMode: "independent_clone",
      gitRunner: runner
    });
    const workspaceId = "clone-checkout-retry";
    const workspacePath = join(fixture.ownedRoot, workspaceId);

    await expect(manager.createWorkspace({ kind: "integration", workspaceId }))
      .rejects.toMatchObject({ code: "CLONE_CHECKOUT_FAILED" });
    await expect(access(workspacePath)).rejects.toThrow();

    const retried = await manager.createWorkspace({ kind: "integration", workspaceId });
    expect(retried.record.workspaceId).toBe(workspaceId);
    await expect(manager.removeWorkspace(retried, {
      evidencePersisted: true,
      processTreeClosed: true,
      force: true
    })).resolves.toMatchObject({ state: "completed" });
  }, 60_000);

  it("rolls back a partially added worktree and permits the same workspace ID to retry", async () => {
    const fixture = await createRepoFixture();
    const calls: GitCall[] = [];
    const realRunner = recordingGitRunner(calls);
    let failAfterAdd = true;
    const runner: SwarmGitRunner = async (command) => {
      const result = await realRunner(command);
      if (command.args[0] === "-c" && command.args.includes("add") && failAfterAdd) {
        failAfterAdd = false;
        throw Object.assign(new Error("simulated post-add failure"), { code: "ADD_FAILED" });
      }
      return result;
    };
    const manager = await createSwarmWorkspaceManager({
      canonicalRoot: fixture.canonicalRoot,
      ownedRoot: fixture.ownedRoot,
      swarmId: "swarm-partial-add-rollback",
      gitRunner: runner
    });
    const workspaceId = "partial-add-retry";
    const workspacePath = join(fixture.ownedRoot, workspaceId);

    await expect(manager.createWorkspace({ kind: "verifier", workspaceId }))
      .rejects.toMatchObject({ code: "WORKTREE_CREATE_FAILED" });
    await expect(access(workspacePath)).rejects.toThrow();
    expect(gitScalar(fixture.canonicalRoot, ["worktree", "list", "--porcelain"]))
      .not.toContain(resolve(workspacePath));

    const retried = await manager.createWorkspace({ kind: "verifier", workspaceId });
    expect(retried.record.workspaceId).toBe(workspaceId);
    await expect(manager.removeWorkspace(retried, {
      evidencePersisted: true,
      processTreeClosed: true,
      force: true
    })).resolves.toMatchObject({ state: "completed" });
  }, 60_000);

  it("fails before worktree add for dirty or non-Git canonical inputs", async () => {
    const dirty = await createRepoFixture();
    await writeFile(join(dirty.canonicalRoot, "dirty.txt"), "not committed\n", "utf8");
    const dirtyCalls: GitCall[] = [];

    await expect(createSwarmWorkspaceManager({
      canonicalRoot: dirty.canonicalRoot,
      ownedRoot: dirty.ownedRoot,
      swarmId: "swarm-dirty",
      gitRunner: recordingGitRunner(dirtyCalls)
    })).rejects.toThrow(/clean canonical checkout/iu);
    expect(dirtyCalls.some(({ args }) => args.includes("worktree") && args.includes("add"))).toBe(false);

    const nonGitRoot = await mkdtemp(join(tmpdir(), "martin-swarm-non-git-"));
    scratchRoots.push(nonGitRoot);
    const nonGitCalls: GitCall[] = [];
    await expect(createSwarmWorkspaceManager({
      canonicalRoot: nonGitRoot,
      ownedRoot: join(nonGitRoot, ".martin", "swarms", "swarm-no-git", "worktrees"),
      swarmId: "swarm-no-git",
      gitRunner: recordingGitRunner(nonGitCalls)
    })).rejects.toThrow(/Git repository/iu);
    expect(nonGitCalls.some(({ args }) => args.includes("worktree") && args.includes("add"))).toBe(false);
  });

  it("rejects unsafe workspace IDs and a created worktree whose HEAD does not match the captured baseline", async () => {
    const fixture = await createRepoFixture();
    const calls: GitCall[] = [];
    const baseRunner = recordingGitRunner(calls);
    const manager = await createSwarmWorkspaceManager({
      canonicalRoot: fixture.canonicalRoot,
      ownedRoot: fixture.ownedRoot,
      swarmId: "swarm-unsafe",
      gitRunner: baseRunner
    });

    for (const workspaceId of [
      "../outside",
      "CON",
      "CON.txt",
      "aux",
      "LPT1",
      "agent.",
      "agent/name",
      "agent name"
    ]) {
      await expect(manager.createWorkspace({
        kind: "integration",
        workspaceId
      })).rejects.toThrow(/filename-safe workspace ID/iu);
    }
    expect(calls.some(({ args }) => args.includes("worktree") && args.includes("add"))).toBe(false);

    const mismatchFixture = await createRepoFixture();
    const mismatchCalls: GitCall[] = [];
    const realRunner = recordingGitRunner(mismatchCalls);
    const mismatchRunner: SwarmGitRunner = async (command) => {
      const result = await realRunner(command);
      if (
        resolve(command.cwd) !== resolve(mismatchFixture.canonicalRoot)
        && command.args[0] === "rev-parse"
        && command.args.includes("HEAD^{commit}")
      ) {
        return { ...result, stdout: `${"f".repeat(40)}\n` };
      }
      return result;
    };
    const mismatchManager = await createSwarmWorkspaceManager({
      canonicalRoot: mismatchFixture.canonicalRoot,
      ownedRoot: mismatchFixture.ownedRoot,
      swarmId: "swarm-mismatch",
      gitRunner: mismatchRunner
    });

    const mismatchPath = join(mismatchFixture.ownedRoot, "verifier-mismatch");
    await expect(mismatchManager.createWorkspace({
      kind: "verifier",
      workspaceId: "verifier-mismatch"
    })).rejects.toThrow(/baseline/iu);
    expect(mismatchCalls).toContainEqual({
      cwd: expect.any(String),
      args: ["worktree", "remove", "--force", resolve(mismatchPath)]
    });
    await expect(access(mismatchPath)).rejects.toThrow();
    expect(gitScalar(mismatchFixture.canonicalRoot, ["worktree", "list", "--porcelain"])).not.toContain(
      resolve(mismatchPath)
    );
  });

  it.each(["EPERM", "EBUSY"])("retains a recoverable manager capability when post-add rollback fails with %s", async (code) => {
    const fixture = await createRepoFixture();
    const calls: GitCall[] = [];
    const realRunner = recordingGitRunner(calls);
    let rollbackFailuresRemaining = 1;
    const mismatchHead = "f".repeat(40);
    const runner: SwarmGitRunner = async (command) => {
      if (
        command.args[0] === "worktree"
        && command.args[1] === "remove"
        && rollbackFailuresRemaining > 0
      ) {
        rollbackFailuresRemaining -= 1;
        calls.push({ cwd: command.cwd, args: [...command.args] });
        throw Object.assign(new Error("simulated post-add rollback lock"), { code });
      }
      const result = await realRunner(command);
      if (
        resolve(command.cwd) !== resolve(fixture.canonicalRoot)
        && command.args[0] === "rev-parse"
        && command.args.includes("HEAD^{commit}")
      ) {
        return { ...result, stdout: `${mismatchHead}\n` };
      }
      if (command.args.join(" ") === "worktree list --porcelain -z") {
        return { ...result, stdout: result.stdout.replaceAll(fixture.baselineCommit, mismatchHead) };
      }
      return result;
    };
    const manager = await createSwarmWorkspaceManager({
      canonicalRoot: fixture.canonicalRoot,
      ownedRoot: fixture.ownedRoot,
      swarmId: `swarm-post-add-${code.toLowerCase()}`,
      gitRunner: runner
    });

    let caught: unknown;
    try {
      await manager.createWorkspace({
        kind: "child",
        workspaceId: `agent-post-add-${code.toLowerCase()}`,
        childRunId: `loop-post-add-${code.toLowerCase()}`,
        agentId: "agent-06",
        taskIds: ["task-state"]
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(SwarmWorkspaceCreationError);
    const creationError = caught as SwarmWorkspaceCreationError;
    expect(creationError.originalCode).toBe("WORKTREE_BASELINE_MISMATCH");
    expect(creationError.cleanup).toMatchObject({
      workspaceId: `agent-post-add-${code.toLowerCase()}`,
      evidencePersisted: false,
      processCloseState: "not_required",
      removalState: "failed",
      state: "cleanup_pending",
      errorCode: code
    });
    expect(creationError.cleanup).not.toHaveProperty("path");
    expect(JSON.stringify(creationError.cleanup)).not.toContain(fixture.scratchRoot);
    await access(creationError.recoveryHandle.path);

    const recovered = await manager.removeWorkspace(creationError.recoveryHandle, {
      evidencePersisted: true,
      processTreeClosed: true,
      force: true
    });
    expect(recovered).toMatchObject({ state: "completed", removalState: "removed" });
    await expect(access(creationError.recoveryHandle.path)).rejects.toThrow();
  });

  it("refuses forged or canonical handles and refuses cleanup before evidence and process closure", async () => {
    const fixture = await createRepoFixture();
    const calls: GitCall[] = [];
    const manager = await createSwarmWorkspaceManager({
      canonicalRoot: fixture.canonicalRoot,
      ownedRoot: fixture.ownedRoot,
      swarmId: "swarm-cleanup-gates",
      gitRunner: recordingGitRunner(calls)
    });
    const handle = await manager.createWorkspace({
      kind: "integration",
      workspaceId: "integration-gates"
    });
    const forged = {
      ...handle,
      path: fixture.canonicalRoot
    } as SwarmWorkspaceRuntimeHandle;

    await expect(manager.removeWorkspace(forged, {
      evidencePersisted: true,
      processTreeClosed: true,
      force: true
    })).rejects.toThrow(/manager-issued|registered|canonical/iu);
    await expect(manager.removeWorkspace(handle, {
      evidencePersisted: false,
      processTreeClosed: true,
      force: true
    })).rejects.toThrow(/evidence/iu);
    await expect(manager.removeWorkspace(handle, {
      evidencePersisted: true,
      processTreeClosed: false,
      force: true
    })).rejects.toThrow(/process tree/iu);

    expect(calls.filter(({ args }) => args[0] === "worktree" && args[1] === "remove")).toHaveLength(0);
    await access(handle.path);
  });

  it.each(["EPERM", "EBUSY"])("preserves registration and returns cleanup_pending on Windows-style %s removal locks", async (code) => {
    const fixture = await createRepoFixture();
    const calls: GitCall[] = [];
    const realRunner = recordingGitRunner(calls);
    const lockRunner: SwarmGitRunner = async (command) => {
      if (command.args[0] === "worktree" && command.args[1] === "remove") {
        throw Object.assign(new Error("simulated Windows worktree lock"), { code });
      }
      return realRunner(command);
    };
    const manager = await createSwarmWorkspaceManager({
      canonicalRoot: fixture.canonicalRoot,
      ownedRoot: fixture.ownedRoot,
      swarmId: `swarm-lock-${code.toLowerCase()}`,
      gitRunner: lockRunner
    });
    const handle = await manager.createWorkspace({
      kind: "child",
      workspaceId: `agent-${code.toLowerCase()}`,
      childRunId: `loop-${code.toLowerCase()}`,
      agentId: "agent-06",
      taskIds: ["task-state"]
    });

    const cleanup = await manager.removeWorkspace(handle, {
      evidencePersisted: true,
      processTreeClosed: true,
      force: true
    });

    expect(cleanup).toMatchObject({
      workspaceId: handle.record.workspaceId,
      evidencePersisted: true,
      processCloseState: "closed",
      removalState: "failed",
      state: "cleanup_pending",
      errorCode: code
    });
    expect(JSON.stringify(cleanup)).not.toContain(fixture.scratchRoot);
    await access(handle.path);

    await expect(manager.removeWorkspace(handle, {
      evidencePersisted: true,
      processTreeClosed: true,
      force: true
    })).resolves.toMatchObject({ state: "cleanup_pending", errorCode: code });
  });
});

async function createRepoFixture(): Promise<RepoFixture> {
  const scratchRoot = await mkdtemp(join(tmpdir(), "martin-swarm-workspaces-"));
  scratchRoots.push(scratchRoot);
  const canonicalRootPath = join(scratchRoot, "canonical repo");
  await mkdir(canonicalRootPath, { recursive: true });
  const canonicalRoot = await realpath(canonicalRootPath);
  runGit(canonicalRoot, ["init"]);
  runGit(canonicalRoot, ["config", "user.email", "swarm-workspaces@test.invalid"]);
  runGit(canonicalRoot, ["config", "user.name", "Swarm Workspaces Test"]);
  await writeFile(join(canonicalRoot, ".gitignore"), ".martin/\n", "utf8");
  await writeFile(join(canonicalRoot, "tracked.txt"), "baseline\n", "utf8");
  runGit(canonicalRoot, ["add", ".gitignore", "tracked.txt"]);
  runGit(canonicalRoot, ["commit", "-m", "fixture baseline"]);
  const baselineCommit = gitScalar(canonicalRoot, ["rev-parse", "--verify", "HEAD^{commit}"]);
  return {
    scratchRoot,
    canonicalRoot,
    ownedRoot: join(canonicalRoot, ".martin", "swarms", "swarm-001", "worktrees"),
    baselineCommit
  };
}

function recordingGitRunner(calls: GitCall[]): SwarmGitRunner {
  return async ({ cwd, args }: SwarmGitCommand): Promise<SwarmGitResult> => {
    calls.push({ cwd, args: [...args] });
    return runGitResult(cwd, args);
  };
}

function gitScalar(cwd: string, args: readonly string[]): string {
  return runGitResult(cwd, args).stdout.trim();
}

function runGit(cwd: string, args: readonly string[]): void {
  runGitResult(cwd, args);
}

function runGitWithInput(cwd: string, args: readonly string[], input: Buffer): void {
  const result = spawnSync("git", [...args], {
    cwd,
    input,
    encoding: "buffer",
    windowsHide: true
  });
  if (result.status !== 0) {
    throw new Error(result.stderr?.toString("utf8") || `git ${args.join(" ")} failed`);
  }
}

function runGitResult(cwd: string, args: readonly string[]): SwarmGitResult {
  const result = spawnSync("git", [...args], {
    cwd,
    encoding: "utf8",
    windowsHide: true
  });
  if (result.status !== 0) {
    const spawnError = result.error as NodeJS.ErrnoException | undefined;
    throw Object.assign(
      new Error(result.stderr || `git ${args.join(" ")} failed with status ${String(result.status)}`),
      { code: spawnError?.code ?? `GIT_EXIT_${String(result.status)}` }
    );
  }
  return {
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? ""
  };
}
