import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { access, link, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, unlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { recordPreference, verifyReceiptIntegrityFromFiles, writeReceiptIntegrityMaterial } from "@martin/core";
import type { LoopRecord } from "@martin/contracts";
import { afterEach, describe, expect, it } from "vitest";

import { executeCli } from "../src/index.js";
import { setCleanRecoveryTestHookForTesting } from "../src/clean-recovery-test-hook.js";
import {
  ensureWorkflowCleanOwnership,
  setRecoveryClaimBeforeCleanupTestHookForTesting,
  verifyWorkflowCleanOwnership
} from "../src/clean-ownership.js";
import { consumeFirstRunBanner } from "../src/workflow-state.js";

const itOnDarwin = process.platform === "darwin" ? it : it.skip;
const cleanupRoots: string[] = [];
const originalIntegrityKeyDir = process.env["MARTIN_INTEGRITY_KEY_DIR"];
const originalCleanOwnershipKeyDir = process.env["MARTIN_CLEAN_OWNERSHIP_KEY_DIR"];

async function makeRoot(label: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), label));
  cleanupRoots.push(root);
  return root;
}

async function expectMissing(path: string): Promise<void> {
  await expect(access(path)).rejects.toThrow();
}

async function expectNoRecoveryClaims(directory: string, baseName: string): Promise<void> {
  const claims = (await readdir(directory))
    .filter((name) => name.startsWith(`${baseName}.recovery.`) && name.includes(".claim"));
  expect(claims).toEqual([]);
}

function recoveryClaimPathForTest(path: string, info: Awaited<ReturnType<typeof lstat>>): string {
  const identity = {
    dev: info.dev,
    ino: info.ino,
    size: info.size,
    mtimeMs: info.mtimeMs,
    birthtimeMs: info.birthtimeMs
  };
  const token = createHash("sha256").update(JSON.stringify(identity)).digest("hex").slice(0, 24);
  return `${path}.recovery.${token}.claim`;
}

async function createOwnedRun(runsRoot: string, loopId: string): Promise<string> {
  const runPath = join(runsRoot, loopId);
  const keyRoot = join(runsRoot, "..", ".integrity-keys");
  process.env["MARTIN_INTEGRITY_KEY_DIR"] = keyRoot;
  await mkdir(runPath, { recursive: true });
  const loopRecord = { loopId } as unknown as LoopRecord;
  await writeFile(join(runPath, "loop-record.json"), `${JSON.stringify(loopRecord, null, 2)}\n`, "utf8");
  await writeFile(join(runPath, "ledger.jsonl"), "", "utf8");
  await writeReceiptIntegrityMaterial({
    runId: loopId,
    runsRoot,
    loopRecord,
    ledgerEntries: []
  });
  const integrity = await verifyReceiptIntegrityFromFiles({
    runId: loopId,
    runsRoot,
    loopRecordPath: join(runPath, "loop-record.json"),
    ledgerPath: join(runPath, "ledger.jsonl")
  });
  if (integrity.state !== "verified") {
    throw new Error(`test fixture integrity setup failed: ${JSON.stringify(integrity)}`);
  }
  return runPath;
}

async function createOwnedWorkflowState(runsRoot: string): Promise<string> {
  process.env["MARTIN_CLEAN_OWNERSHIP_KEY_DIR"] = join(runsRoot, "..", ".clean-keys");
  await consumeFirstRunBanner(runsRoot);
  return join(runsRoot, "_martin");
}

async function createExitedProcessId(): Promise<number> {
  const child = spawn(process.execPath, ["-e", "process.exit(0)"]);
  const pid = child.pid;
  if (!pid) {
    throw new Error("test child process did not expose a pid");
  }
  await once(child, "exit");
  return pid;
}

async function runOwnershipWorkers(runsRoot: string, keyRoot: string, count: number): Promise<void> {
  const barrierPath = join(runsRoot, "..", `ownership-worker-barrier-${Date.now()}`);
  const moduleUrl = new URL("../src/clean-ownership.ts", import.meta.url).href;
  const workerSource = `
    import { access, writeFile } from "node:fs/promises";
    import { setTimeout as delay } from "node:timers/promises";
    import { ensureWorkflowCleanOwnership } from ${JSON.stringify(moduleUrl)};
    const [runsRoot, readyPath, barrierPath] = process.argv.slice(-3);
    await writeFile(readyPath, "ready\\n", "utf8");
    while (true) {
      try {
        await access(barrierPath);
        break;
      } catch {
        await delay(5);
      }
    }
    await ensureWorkflowCleanOwnership(runsRoot);
  `;
  const workers = Array.from({ length: count }, (_, index) => {
    const readyPath = join(runsRoot, "..", `ownership-worker-${index}.ready`);
    const child = spawn(process.execPath, [
      "--import", "tsx",
      "--input-type=module",
      "--eval", workerSource,
      runsRoot,
      readyPath,
      barrierPath
    ], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        MARTIN_CLEAN_OWNERSHIP_KEY_DIR: keyRoot
      },
      stdio: ["ignore", "ignore", "pipe"]
    });
    return { child, readyPath };
  });
  for (const { readyPath } of workers) {
    const deadline = Date.now() + 10_000;
    while (true) {
      try {
        await access(readyPath);
        break;
      } catch {
        if (Date.now() >= deadline) {
          throw new Error(`ownership worker did not become ready: ${readyPath}`);
        }
        await delay(10);
      }
    }
  }
  await writeFile(barrierPath, "go\n", "utf8");
  await Promise.all(workers.map(async ({ child }) => {
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    const [code] = await once(child, "exit") as [number | null];
    if (code !== 0) {
      throw new Error(`ownership worker exited ${String(code)}: ${stderr}`);
    }
  }));
}

async function writeOwnershipLockFixture(
  runsRoot: string,
  input: { pid: number; ageMs: number; nonce?: string }
): Promise<string> {
  const workflowRoot = join(runsRoot, "_martin");
  await mkdir(workflowRoot, { recursive: true });
  const timestamp = new Date(Date.now() - input.ageMs).toISOString();
  const lockPath = join(workflowRoot, ".clean-ownership.lock");
  await writeFile(lockPath, `${JSON.stringify({
    schemaVersion: "martin.clean-ownership-lock.v1",
    nonce: input.nonce ?? "a".repeat(32),
    pid: input.pid,
    createdAt: timestamp,
    heartbeatAt: timestamp
  })}\n`, "utf8");
  return lockPath;
}

async function writeCrashedOwnershipFixture(path: string, contents: string, ageMs: number): Promise<void> {
  await mkdir(resolve(path, ".."), { recursive: true });
  await writeFile(path, contents, { encoding: "utf8", mode: 0o600, flag: "wx" });
  const timestamp = new Date(Date.now() - ageMs);
  await utimes(path, timestamp, timestamp);
}

async function writeHardLinkedPublicationCrash(finalPath: string, contents: string): Promise<string> {
  await mkdir(resolve(finalPath, ".."), { recursive: true });
  const tempPath = join(resolve(finalPath, ".."), ".fixture.init.tmp");
  await writeFile(tempPath, contents, { encoding: "utf8", mode: 0o600, flag: "wx" });
  await link(tempPath, finalPath);
  return tempPath;
}

function ownershipKeyPath(runsRoot: string, keyRoot: string): string {
  const digest = createHash("sha256").update(resolve(runsRoot)).digest("hex").slice(0, 16);
  return join(keyRoot, `${digest}.key`);
}

afterEach(async () => {
  setCleanRecoveryTestHookForTesting(undefined);
  setRecoveryClaimBeforeCleanupTestHookForTesting(undefined);
  await Promise.all(cleanupRoots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
  if (originalIntegrityKeyDir === undefined) {
    delete process.env["MARTIN_INTEGRITY_KEY_DIR"];
  } else {
    process.env["MARTIN_INTEGRITY_KEY_DIR"] = originalIntegrityKeyDir;
  }
  if (originalCleanOwnershipKeyDir === undefined) {
    delete process.env["MARTIN_CLEAN_OWNERSHIP_KEY_DIR"];
  } else {
    process.env["MARTIN_CLEAN_OWNERSHIP_KEY_DIR"] = originalCleanOwnershipKeyDir;
  }
});

describe("0.9.0 CLI trust hardening", () => {
  itOnDarwin("accepts the standard macOS /var temporary-directory alias", async () => {
    const workspace = await makeRoot("martin-clean-macos-var-alias-");
    const runsRoot = join(workspace, "runs");
    process.env["MARTIN_CLEAN_OWNERSHIP_KEY_DIR"] = join(workspace, ".clean-keys");

    expect(resolve(workspace)).toMatch(/^\/var\//u);
    await expect(ensureWorkflowCleanOwnership(runsRoot)).resolves.toBeUndefined();
    await expect(verifyWorkflowCleanOwnership(runsRoot)).resolves.toBe(true);
  });

  it("does not emit a governed badge without verified local evidence", async () => {
    const runsRoot = await makeRoot("martin-badge-governed-empty-");

    const result = await executeCli(["badge", "--governed", "--runs-dir", runsRoot]);

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("verified");
    expect(result.stdout).not.toContain("MartinLoop-Governed");
  });

  it("clean help discloses the remaining same-user path-mutation boundary", async () => {
    const result = await executeCli(["clean", "--help"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("same-user process");
    expect(result.stdout).toContain("final path-based operation");
    expect(result.stdout).toContain("stop competing writers");
  });

  it("does not infer config, verifier, or MCP doctor evidence from an empty file and Node", async () => {
    const workspace = await makeRoot("martin-badge-readiness-");
    const runsRoot = join(workspace, "runs");
    await mkdir(runsRoot, { recursive: true });
    await writeFile(join(workspace, "martin.config.yaml"), "# intentionally empty\n", "utf8");

    const previousCwd = process.cwd();
    try {
      process.chdir(workspace);
      const result = await executeCli(["--json", "badge", "--runs-dir", runsRoot]);
      const payload = JSON.parse(result.stdout) as {
        score: { signalCount: number; signals: Array<{ id: string; passed: boolean }> };
      };

      expect(result.exitCode).toBe(0);
      expect(payload.score.signalCount).toBe(0);
      expect(payload.score.signals).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: "budgetConfigured", passed: false }),
        expect.objectContaining({ id: "verifierConfigured", passed: false }),
        expect.objectContaining({ id: "mcpDoctorPassing", passed: false }),
      ]));
    } finally {
      process.chdir(previousCwd);
    }
  });

  it("clean --all removes workflow state plus recent and old run records", async () => {
    const workspace = await makeRoot("martin-clean-all-");
    const runsRoot = join(workspace, "runs");
    const recentRun = await createOwnedRun(runsRoot, "loop_recent");
    const oldRun = await createOwnedRun(runsRoot, "loop_old");
    const workflowState = await createOwnedWorkflowState(runsRoot);

    const result = await executeCli([
      "clean", "--all", "--cwd", workspace, "--runs-dir", runsRoot,
    ]);

    expect(result.exitCode, result.stderr).toBe(0);
    await expectMissing(recentRun);
    await expectMissing(oldRun);
    await expectMissing(workflowState);
    expect(result.stdout).toContain("3 item(s)");

    const repeated = await executeCli([
      "clean", "--all", "--cwd", workspace, "--runs-dir", runsRoot,
    ]);
    expect(repeated.exitCode).toBe(0);
    expect(repeated.stdout).toContain("Nothing to clean");
  });

  it("clean --all refuses an unowned loop-like directory", async () => {
    const workspace = await makeRoot("martin-clean-unowned-");
    const runsRoot = join(workspace, "runs");
    const unowned = join(runsRoot, "loop_customer_backup");
    await mkdir(unowned, { recursive: true });
    await writeFile(join(unowned, "keep.txt"), "customer data\n", "utf8");

    const result = await executeCli([
      "clean", "--all", "--cwd", workspace, "--runs-dir", runsRoot,
    ]);

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toMatch(/ownership/iu);
    await expect(access(join(unowned, "keep.txt"))).resolves.toBeUndefined();
  });

  it("clean --all refuses a forged matching loop record without verified receipt integrity", async () => {
    const workspace = await makeRoot("martin-clean-forged-record-");
    const runsRoot = join(workspace, "runs");
    const forged = join(runsRoot, "loop_forged");
    await mkdir(forged, { recursive: true });
    await writeFile(join(forged, "loop-record.json"), JSON.stringify({ loopId: "loop_forged" }), "utf8");
    await writeFile(join(forged, "ledger.jsonl"), "", "utf8");
    await writeFile(join(forged, "keep.txt"), "customer data\n", "utf8");

    const result = await executeCli([
      "clean", "--all", "--cwd", workspace, "--runs-dir", runsRoot,
    ]);

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("Skipped unverified or legacy run directory");
    expect(result.stderr).toContain("nothing was deleted");
    expect(result.stderr).toContain("martin runs verify --loop loop_forged");
    await expect(access(join(forged, "keep.txt"))).resolves.toBeUndefined();
  });

  it("clean --all validates every selected target before deleting any target", async () => {
    const workspace = await makeRoot("martin-clean-atomic-validation-");
    const runsRoot = join(workspace, "runs");
    const owned = join(runsRoot, "loop_owned");
    const unowned = join(runsRoot, "loop_unowned");
    await createOwnedRun(runsRoot, "loop_owned");
    await mkdir(unowned, { recursive: true });
    await writeFile(join(owned, "keep.txt"), "owned canary\n", "utf8");
    await writeFile(join(unowned, "keep.txt"), "customer data\n", "utf8");

    const result = await executeCli([
      "clean", "--all", "--cwd", workspace, "--runs-dir", runsRoot,
    ]);

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toMatch(/ownership/iu);
    await expect(access(join(owned, "keep.txt"))).resolves.toBeUndefined();
    await expect(access(join(unowned, "keep.txt"))).resolves.toBeUndefined();
  });

  it("clean refuses an unrelated _martin directory without a valid ownership sentinel", async () => {
    const workspace = await makeRoot("martin-clean-unowned-state-");
    const runsRoot = join(workspace, "runs");
    const unrelated = join(runsRoot, "_martin");
    await mkdir(unrelated, { recursive: true });
    await writeFile(join(unrelated, "keep.txt"), "customer data\n", "utf8");

    const result = await executeCli(["clean", "--cwd", workspace, "--runs-dir", runsRoot]);

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("ownership");
    await expect(access(join(unrelated, "keep.txt"))).resolves.toBeUndefined();
  });

  it("clean refuses a self-asserted workflow-state file outside the canonical receipt layout", async () => {
    const workspace = await makeRoot("martin-clean-fake-state-");
    const runsRoot = join(workspace, "runs");
    const unrelated = join(runsRoot, "_martin");
    await mkdir(unrelated, { recursive: true });
    await writeFile(join(unrelated, "workflow-state.json"), JSON.stringify({ version: 1 }), "utf8");
    await writeFile(join(unrelated, "keep.txt"), "customer data\n", "utf8");

    const result = await executeCli(["clean", "--cwd", workspace, "--runs-dir", runsRoot]);

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("ownership");
    await expect(access(join(unrelated, "keep.txt"))).resolves.toBeUndefined();
  });

  it("clean never treats an unrelated workspace-local _martin directory as the configured runs metadata root", async () => {
    const workspace = await makeRoot("martin-clean-workspace-boundary-");
    const runsRoot = join(workspace, "configured-runs");
    const workspaceLocal = join(workspace, "_martin");
    await mkdir(workspaceLocal, { recursive: true });
    await writeFile(join(workspaceLocal, "keep.txt"), "workspace data\n", "utf8");

    const result = await executeCli(["clean", "--cwd", workspace, "--runs-dir", runsRoot]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Nothing to clean");
    await expect(access(join(workspaceLocal, "keep.txt"))).resolves.toBeUndefined();
  });

  it("clean accepts the canonical first-run state as MartinLoop ownership evidence", async () => {
    const workspace = await makeRoot("martin-clean-first-run-state-");
    const runsRoot = join(workspace, "runs");
    const martinRoot = await createOwnedWorkflowState(runsRoot);

    const result = await executeCli(["clean", "--cwd", workspace, "--runs-dir", runsRoot]);

    expect(result.exitCode).toBe(0);
    await expectMissing(martinRoot);
  });

  it("workflow ownership persistence refuses a marker leaf symlink without truncating its outside canary", async () => {
    const workspace = await makeRoot("martin-clean-marker-link-");
    const runsRoot = join(workspace, "runs");
    const workflowRoot = join(runsRoot, "_martin");
    const outside = await makeRoot("martin-clean-marker-link-outside-");
    const canary = join(outside, "do-not-truncate.txt");
    await mkdir(workflowRoot, { recursive: true });
    await writeFile(canary, "outside canary\n", "utf8");
    await symlink(outside, join(workflowRoot, "clean-ownership.json"), process.platform === "win32" ? "junction" : "dir");
    process.env["MARTIN_CLEAN_OWNERSHIP_KEY_DIR"] = join(workspace, ".clean-keys");

    await expect(ensureWorkflowCleanOwnership(runsRoot)).rejects.toThrow(/exclusive regular file/iu);
    await expect(access(canary)).resolves.toBeUndefined();
    await expect(readFile(canary, "utf8")).resolves.toBe("outside canary\n");
  });

  it("workflow ownership persistence refuses a hard-linked marker without truncating its outside canary", async () => {
    const workspace = await makeRoot("martin-clean-marker-hardlink-");
    const runsRoot = join(workspace, "runs");
    const workflowRoot = join(runsRoot, "_martin");
    const outside = join(workspace, "do-not-truncate.txt");
    await mkdir(workflowRoot, { recursive: true });
    await writeFile(outside, "outside canary\n", "utf8");
    await link(outside, join(workflowRoot, "clean-ownership.json"));
    process.env["MARTIN_CLEAN_OWNERSHIP_KEY_DIR"] = join(workspace, ".clean-keys");

    await expect(ensureWorkflowCleanOwnership(runsRoot)).rejects.toThrow(/exclusive regular file/iu);
    await expect(readFile(outside, "utf8")).resolves.toBe("outside canary\n");
  });

  it("workflow ownership persistence refuses an _martin parent junction and preserves the outside target", async () => {
    const workspace = await makeRoot("martin-clean-marker-parent-link-");
    const runsRoot = join(workspace, "runs");
    const outside = await makeRoot("martin-clean-marker-parent-outside-");
    const canary = join(outside, "do-not-write.txt");
    await mkdir(runsRoot, { recursive: true });
    await writeFile(canary, "outside canary\n", "utf8");
    await symlink(outside, join(runsRoot, "_martin"), process.platform === "win32" ? "junction" : "dir");
    process.env["MARTIN_CLEAN_OWNERSHIP_KEY_DIR"] = join(workspace, ".clean-keys");

    await expect(ensureWorkflowCleanOwnership(runsRoot)).rejects.toThrow(/unsafe clean ownership directory/iu);
    await expect(readFile(canary, "utf8")).resolves.toBe("outside canary\n");
    await expectMissing(join(outside, "clean-ownership.json"));
  });

  it("workflow ownership persistence remains valid under concurrent atomic writers", async () => {
    const workspace = await makeRoot("martin-clean-marker-concurrent-");
    const runsRoot = join(workspace, "runs");
    process.env["MARTIN_CLEAN_OWNERSHIP_KEY_DIR"] = join(workspace, ".clean-keys");

    await Promise.all(Array.from({ length: 16 }, () => ensureWorkflowCleanOwnership(runsRoot)));

    await expect(verifyWorkflowCleanOwnership(runsRoot)).resolves.toBe(true);
    const markerInfo = await lstat(join(runsRoot, "_martin", "clean-ownership.json"));
    expect(markerInfo.isFile()).toBe(true);
    expect(markerInfo.isSymbolicLink()).toBe(false);
    expect(markerInfo.nlink).toBe(1);
    const leftovers = (await readdir(join(runsRoot, "_martin"))).filter((name) => name.endsWith(".tmp"));
    expect(leftovers).toEqual([]);
  });

  it("workflow ownership contention accepts a valid marker published while a live lock remains held", async () => {
    const workspace = await makeRoot("martin-clean-marker-contention-satisfied-");
    const runsRoot = join(workspace, "runs");
    const markerPath = join(runsRoot, "_martin", "clean-ownership.json");
    process.env["MARTIN_CLEAN_OWNERSHIP_KEY_DIR"] = join(workspace, ".clean-keys");
    await ensureWorkflowCleanOwnership(runsRoot);
    const validMarker = await readFile(markerPath, "utf8");
    await writeFile(markerPath, "{}\n", "utf8");
    const lockPath = await writeOwnershipLockFixture(runsRoot, {
      pid: process.pid,
      ageMs: 0,
      nonce: "1".repeat(32)
    });

    const waitingWriter = ensureWorkflowCleanOwnership(runsRoot);
    await delay(50);
    await writeFile(markerPath, validMarker, "utf8");

    await expect(waitingWriter).resolves.toBeUndefined();
    await expect(access(lockPath)).resolves.toBeUndefined();
    expect(await readFile(lockPath, "utf8")).toContain("1".repeat(32));
  });

  it("workflow ownership normalizes one abandoned hard-link publication under concurrent recovery", async () => {
    const workspace = await makeRoot("martin-clean-marker-concurrent-normalize-");
    const runsRoot = join(workspace, "runs");
    const lockPath = join(runsRoot, "_martin", ".clean-ownership.lock");
    const timestamp = new Date(Date.now() - 60_000).toISOString();
    process.env["MARTIN_CLEAN_OWNERSHIP_KEY_DIR"] = join(workspace, ".clean-keys");
    const tempPath = await writeHardLinkedPublicationCrash(lockPath, `${JSON.stringify({
      schemaVersion: "martin.clean-ownership-lock.v1",
      nonce: "2".repeat(32),
      pid: await createExitedProcessId(),
      createdAt: timestamp,
      heartbeatAt: timestamp
    })}\n`);

    await expect(Promise.all(
      Array.from({ length: 16 }, () => ensureWorkflowCleanOwnership(runsRoot))
    )).resolves.toHaveLength(16);
    await expect(verifyWorkflowCleanOwnership(runsRoot)).resolves.toBe(true);
    await expectMissing(tempPath);
    await expectMissing(lockPath);
  });

  it("workflow ownership recovery is identity-bound across independent processes", async () => {
    for (let iteration = 0; iteration < 1; iteration += 1) {
      const workspace = await makeRoot(`martin-clean-marker-multiprocess-${iteration}-`);
      const runsRoot = join(workspace, "runs");
      const keyRoot = join(workspace, ".clean-keys");
      process.env["MARTIN_CLEAN_OWNERSHIP_KEY_DIR"] = keyRoot;
      await writeOwnershipLockFixture(runsRoot, {
        pid: await createExitedProcessId(),
        ageMs: 60_000,
        nonce: "3".repeat(32)
      });

      await runOwnershipWorkers(runsRoot, keyRoot, 6);

      await expect(verifyWorkflowCleanOwnership(runsRoot)).resolves.toBe(true);
      await expectMissing(join(runsRoot, "_martin", ".clean-ownership.lock"));
      await expectNoRecoveryClaims(join(runsRoot, "_martin"), ".clean-ownership.lock");
    }
  });

  it("recovery finalization cannot delete a replacement lock claim", async () => {
    const workspace = await makeRoot("martin-clean-marker-claim-replacement-");
    const runsRoot = join(workspace, "runs");
    const keyRoot = join(workspace, ".clean-keys");
    const markerPath = join(runsRoot, "_martin", "clean-ownership.json");
    const lockPath = join(runsRoot, "_martin", ".clean-ownership.lock");
    process.env["MARTIN_CLEAN_OWNERSHIP_KEY_DIR"] = keyRoot;
    await ensureWorkflowCleanOwnership(runsRoot);
    await rm(markerPath, { force: false });
    await writeOwnershipLockFixture(runsRoot, {
      pid: await createExitedProcessId(),
      ageMs: 60_000,
      nonce: "4".repeat(32)
    });
    let replacementClaimPath: string | undefined;
    let originalClaimPath: string | undefined;
    setRecoveryClaimBeforeCleanupTestHookForTesting(async ({ path, claimPath }) => {
      if (path !== lockPath || replacementClaimPath) {
        return;
      }
      originalClaimPath = claimPath;
      const now = new Date().toISOString();
      await writeFile(lockPath, `${JSON.stringify({
        schemaVersion: "martin.clean-ownership-lock.v1",
        nonce: "5".repeat(32),
        pid: process.pid,
        createdAt: now,
        heartbeatAt: now
      })}\n`, { encoding: "utf8", flag: "wx" });
      replacementClaimPath = recoveryClaimPathForTest(lockPath, await lstat(lockPath));
      await link(lockPath, replacementClaimPath);
    });

    await expect(ensureWorkflowCleanOwnership(runsRoot)).rejects.toThrow(/live or unverifiable/iu);

    expect(replacementClaimPath).toBeDefined();
    expect(originalClaimPath).toBeDefined();
    expect(replacementClaimPath).not.toBe(originalClaimPath);
    await expect(access(replacementClaimPath!)).resolves.toBeUndefined();
    expect(await readFile(lockPath, "utf8")).toContain("5".repeat(32));
  });

  it("a new process reclaims recovery ownership after the claimant is killed", async () => {
    const workspace = await makeRoot("martin-clean-marker-killed-recovery-owner-");
    const runsRoot = join(workspace, "runs");
    const keyRoot = join(workspace, ".clean-keys");
    const markerPath = join(runsRoot, "_martin", "clean-ownership.json");
    const lockPath = join(runsRoot, "_martin", ".clean-ownership.lock");
    const readyPath = join(workspace, "recovery-claim-ready");
    const moduleUrl = new URL("../src/clean-ownership.ts", import.meta.url).href;
    process.env["MARTIN_CLEAN_OWNERSHIP_KEY_DIR"] = keyRoot;
    await ensureWorkflowCleanOwnership(runsRoot);
    await rm(markerPath, { force: false });
    await writeOwnershipLockFixture(runsRoot, {
      pid: await createExitedProcessId(),
      ageMs: 60_000,
      nonce: "6".repeat(32)
    });
    const claimantSource = `
      import { readFile, writeFile } from "node:fs/promises";
      import {
        ensureWorkflowCleanOwnership,
        setRecoveryClaimBeforeCleanupTestHookForTesting
      } from ${JSON.stringify(moduleUrl)};
      const [runsRoot, readyPath] = process.argv.slice(-2);
      setRecoveryClaimBeforeCleanupTestHookForTesting(async ({ claimPath }) => {
        const ownerPath = claimPath + ".owner";
        const owner = JSON.parse(await readFile(ownerPath, "utf8"));
        owner.createdAt = new Date(Date.now() - 60_000).toISOString();
        await writeFile(ownerPath, JSON.stringify(owner) + "\\n", "utf8");
        await writeFile(readyPath, "ready\\n", "utf8");
        await new Promise(() => {});
      });
      await ensureWorkflowCleanOwnership(runsRoot);
    `;
    const claimant = spawn(process.execPath, [
      "--import", "tsx",
      "--input-type=module",
      "--eval", claimantSource,
      runsRoot,
      readyPath
    ], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        MARTIN_CLEAN_OWNERSHIP_KEY_DIR: keyRoot
      },
      stdio: ["ignore", "ignore", "pipe"]
    });
    let claimantStderr = "";
    claimant.stderr?.on("data", (chunk: Buffer) => {
      claimantStderr += chunk.toString("utf8");
    });
    const readyDeadline = Date.now() + 10_000;
    while (true) {
      try {
        await access(readyPath);
        break;
      } catch {
        if (claimant.exitCode !== null) {
          throw new Error(`recovery claimant exited before its claim was ready: ${claimantStderr}`);
        }
        if (Date.now() >= readyDeadline) {
          claimant.kill();
          throw new Error(`recovery claimant did not become ready: ${claimantStderr}`);
        }
        await delay(10);
      }
    }
    claimant.kill();
    await once(claimant, "exit");

    await expectMissing(lockPath);
    await runOwnershipWorkers(runsRoot, keyRoot, 1);

    await expect(verifyWorkflowCleanOwnership(runsRoot)).resolves.toBe(true);
    await expectMissing(lockPath);
    await expectNoRecoveryClaims(join(runsRoot, "_martin"), ".clean-ownership.lock");
  });

  it("fails closed with an explicit diagnostic when owner reclamation itself was interrupted", async () => {
    const workspace = await makeRoot("martin-clean-marker-interrupted-owner-reclaim-");
    const runsRoot = join(workspace, "runs");
    const keyRoot = join(workspace, ".clean-keys");
    const markerPath = join(runsRoot, "_martin", "clean-ownership.json");
    const lockPath = join(runsRoot, "_martin", ".clean-ownership.lock");
    process.env["MARTIN_CLEAN_OWNERSHIP_KEY_DIR"] = keyRoot;
    await ensureWorkflowCleanOwnership(runsRoot);
    await rm(markerPath, { force: false });
    await writeOwnershipLockFixture(runsRoot, {
      pid: await createExitedProcessId(),
      ageMs: 60_000,
      nonce: "7".repeat(32)
    });
    const claimPath = recoveryClaimPathForTest(lockPath, await lstat(lockPath));
    await link(lockPath, claimPath);
    await rm(lockPath, { force: false });
    const ownerPath = `${claimPath}.owner`;
    const ownerNonce = "8".repeat(32);
    await writeFile(ownerPath, `${JSON.stringify({
      schemaVersion: "martin.clean-ownership-recovery-owner.v1",
      nonce: ownerNonce,
      pid: await createExitedProcessId(),
      createdAt: new Date(Date.now() - 60_000).toISOString()
    })}\n`, "utf8");
    await link(ownerPath, `${ownerPath}.reclaim.${ownerNonce}`);

    await expect(ensureWorkflowCleanOwnership(runsRoot)).rejects.toThrow(
      /reclaim was interrupted and requires manual inspection/iu
    );
    await expect(access(claimPath)).resolves.toBeUndefined();
    await expect(access(ownerPath)).resolves.toBeUndefined();
  });

  it("stale ownership key recovery is identity-bound across independent processes", async () => {
    for (let iteration = 0; iteration < 1; iteration += 1) {
      const workspace = await makeRoot(`martin-clean-key-multiprocess-${iteration}-`);
      const runsRoot = join(workspace, "runs");
      const keyRoot = join(workspace, ".clean-keys");
      const keyPath = ownershipKeyPath(runsRoot, keyRoot);
      process.env["MARTIN_CLEAN_OWNERSHIP_KEY_DIR"] = keyRoot;
      await writeCrashedOwnershipFixture(keyPath, "invalid-stale-key\n", 60_000);

      await runOwnershipWorkers(runsRoot, keyRoot, 6);

      await expect(verifyWorkflowCleanOwnership(runsRoot)).resolves.toBe(true);
      expect((await readFile(keyPath, "utf8")).trim()).toMatch(/^[a-f0-9]{64}$/u);
      await expectNoRecoveryClaims(keyRoot, `${createHash("sha256").update(resolve(runsRoot)).digest("hex").slice(0, 16)}.key`);
    }
  });

  it("a new process reclaims stale key recovery ownership after the claimant is killed", async () => {
    const workspace = await makeRoot("martin-clean-key-killed-recovery-owner-");
    const runsRoot = join(workspace, "runs");
    const keyRoot = join(workspace, ".clean-keys");
    const keyPath = ownershipKeyPath(runsRoot, keyRoot);
    const readyPath = join(workspace, "key-recovery-claim-ready");
    const moduleUrl = new URL("../src/clean-ownership.ts", import.meta.url).href;
    process.env["MARTIN_CLEAN_OWNERSHIP_KEY_DIR"] = keyRoot;
    await writeCrashedOwnershipFixture(keyPath, "invalid-stale-key\n", 60_000);
    const claimantSource = `
      import { readFile, writeFile } from "node:fs/promises";
      import {
        ensureWorkflowCleanOwnership,
        setRecoveryClaimBeforeCleanupTestHookForTesting
      } from ${JSON.stringify(moduleUrl)};
      const [runsRoot, keyPath, readyPath] = process.argv.slice(-3);
      setRecoveryClaimBeforeCleanupTestHookForTesting(async ({ path, claimPath }) => {
        if (path !== keyPath) return;
        const ownerPath = claimPath + ".owner";
        const owner = JSON.parse(await readFile(ownerPath, "utf8"));
        owner.createdAt = new Date(Date.now() - 60_000).toISOString();
        await writeFile(ownerPath, JSON.stringify(owner) + "\\n", "utf8");
        await writeFile(readyPath, "ready\\n", "utf8");
        await new Promise(() => {});
      });
      await ensureWorkflowCleanOwnership(runsRoot);
    `;
    const claimant = spawn(process.execPath, [
      "--import", "tsx",
      "--input-type=module",
      "--eval", claimantSource,
      runsRoot,
      keyPath,
      readyPath
    ], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        MARTIN_CLEAN_OWNERSHIP_KEY_DIR: keyRoot
      },
      stdio: ["ignore", "ignore", "pipe"]
    });
    let claimantStderr = "";
    claimant.stderr?.on("data", (chunk: Buffer) => {
      claimantStderr += chunk.toString("utf8");
    });
    const readyDeadline = Date.now() + 10_000;
    while (true) {
      try {
        await access(readyPath);
        break;
      } catch {
        if (claimant.exitCode !== null) {
          throw new Error(`key recovery claimant exited before its claim was ready: ${claimantStderr}`);
        }
        if (Date.now() >= readyDeadline) {
          claimant.kill();
          throw new Error(`key recovery claimant did not become ready: ${claimantStderr}`);
        }
        await delay(10);
      }
    }
    claimant.kill();
    await once(claimant, "exit");

    await expectMissing(keyPath);
    await runOwnershipWorkers(runsRoot, keyRoot, 1);

    await expect(verifyWorkflowCleanOwnership(runsRoot)).resolves.toBe(true);
    expect((await readFile(keyPath, "utf8")).trim()).toMatch(/^[a-f0-9]{64}$/u);
    await expectNoRecoveryClaims(keyRoot, `${createHash("sha256").update(resolve(runsRoot)).digest("hex").slice(0, 16)}.key`);
  });

  it("workflow ownership survives repeated sixteen-writer contention", async () => {
    for (let iteration = 0; iteration < 5; iteration += 1) {
      const workspace = await makeRoot(`martin-clean-marker-stress-${iteration}-`);
      const runsRoot = join(workspace, "runs");
      process.env["MARTIN_CLEAN_OWNERSHIP_KEY_DIR"] = join(workspace, ".clean-keys");

      await expect(Promise.all(
        Array.from({ length: 16 }, () => ensureWorkflowCleanOwnership(runsRoot))
      )).resolves.toHaveLength(16);
      await expect(verifyWorkflowCleanOwnership(runsRoot)).resolves.toBe(true);
    }
  });

  it("workflow ownership fast-path accepts a valid marker without stealing a stale lock", async () => {
    const workspace = await makeRoot("martin-clean-marker-valid-stale-lock-");
    const runsRoot = join(workspace, "runs");
    process.env["MARTIN_CLEAN_OWNERSHIP_KEY_DIR"] = join(workspace, ".clean-keys");
    await ensureWorkflowCleanOwnership(runsRoot);
    const lockPath = await writeOwnershipLockFixture(runsRoot, {
      pid: await createExitedProcessId(),
      ageMs: 60_000,
      nonce: "b".repeat(32)
    });

    await expect(ensureWorkflowCleanOwnership(runsRoot)).resolves.toBeUndefined();
    await expect(access(lockPath)).resolves.toBeUndefined();
    expect(await readFile(lockPath, "utf8")).toContain("b".repeat(32));
  });

  it("workflow ownership recovers an expired lock whose owner process exited", async () => {
    const workspace = await makeRoot("martin-clean-marker-abandoned-lock-");
    const runsRoot = join(workspace, "runs");
    process.env["MARTIN_CLEAN_OWNERSHIP_KEY_DIR"] = join(workspace, ".clean-keys");
    const lockPath = await writeOwnershipLockFixture(runsRoot, {
      pid: await createExitedProcessId(),
      ageMs: 60_000,
      nonce: "c".repeat(32)
    });

    await expect(ensureWorkflowCleanOwnership(runsRoot)).resolves.toBeUndefined();
    await expect(verifyWorkflowCleanOwnership(runsRoot)).resolves.toBe(true);
    await expectMissing(lockPath);
  });

  it("workflow ownership does not steal an expired-looking lock from a live owner", async () => {
    const workspace = await makeRoot("martin-clean-marker-live-lock-");
    const runsRoot = join(workspace, "runs");
    process.env["MARTIN_CLEAN_OWNERSHIP_KEY_DIR"] = join(workspace, ".clean-keys");
    const lockPath = await writeOwnershipLockFixture(runsRoot, {
      pid: process.pid,
      ageMs: 60_000,
      nonce: "d".repeat(32)
    });

    await expect(ensureWorkflowCleanOwnership(runsRoot)).rejects.toThrow(/live or unverifiable.*not stolen/iu);
    await expect(access(lockPath)).resolves.toBeUndefined();
    expect(await readFile(lockPath, "utf8")).toContain("d".repeat(32));
  });

  for (const [label, contents] of [
    ["empty", ""],
    ["partial", '{"schemaVersion":"martin.clean-ownership-lock.v1"'],
    ["malformed", "not-json\n"]
  ] as const) {
    it(`workflow ownership recovers an abandoned ${label} create-before-write lock`, async () => {
      const workspace = await makeRoot(`martin-clean-marker-${label}-crash-lock-`);
      const runsRoot = join(workspace, "runs");
      const keyRoot = join(workspace, ".clean-keys");
      const lockPath = join(runsRoot, "_martin", ".clean-ownership.lock");
      process.env["MARTIN_CLEAN_OWNERSHIP_KEY_DIR"] = keyRoot;
      await writeCrashedOwnershipFixture(lockPath, contents, 60_000);

      await expect(ensureWorkflowCleanOwnership(runsRoot)).resolves.toBeUndefined();
      await expect(verifyWorkflowCleanOwnership(runsRoot)).resolves.toBe(true);
      await expectMissing(lockPath);
    });
  }

  it("workflow ownership does not steal a fresh empty create-before-write lock", async () => {
    const workspace = await makeRoot("martin-clean-marker-live-empty-lock-");
    const runsRoot = join(workspace, "runs");
    const keyRoot = join(workspace, ".clean-keys");
    const lockPath = join(runsRoot, "_martin", ".clean-ownership.lock");
    process.env["MARTIN_CLEAN_OWNERSHIP_KEY_DIR"] = keyRoot;
    await writeCrashedOwnershipFixture(lockPath, "", 0);

    await expect(ensureWorkflowCleanOwnership(runsRoot)).rejects.toThrow(/live or unverifiable.*not stolen/iu);
    await expect(access(lockPath)).resolves.toBeUndefined();
    await expect(readFile(lockPath, "utf8")).resolves.toBe("");
  });

  it("workflow ownership recovers a complete lock published before temp-link cleanup", async () => {
    const workspace = await makeRoot("martin-clean-marker-published-lock-crash-");
    const runsRoot = join(workspace, "runs");
    const keyRoot = join(workspace, ".clean-keys");
    const lockPath = join(runsRoot, "_martin", ".clean-ownership.lock");
    const timestamp = new Date(Date.now() - 60_000).toISOString();
    process.env["MARTIN_CLEAN_OWNERSHIP_KEY_DIR"] = keyRoot;
    const tempPath = await writeHardLinkedPublicationCrash(lockPath, `${JSON.stringify({
      schemaVersion: "martin.clean-ownership-lock.v1",
      nonce: "e".repeat(32),
      pid: await createExitedProcessId(),
      createdAt: timestamp,
      heartbeatAt: timestamp
    })}\n`);

    await expect(ensureWorkflowCleanOwnership(runsRoot)).resolves.toBeUndefined();
    await expect(verifyWorkflowCleanOwnership(runsRoot)).resolves.toBe(true);
    await expectMissing(lockPath);
    await expectMissing(tempPath);
  });

  for (const [label, contents] of [
    ["empty", ""],
    ["partial", "0123456789abcdef"],
    ["malformed", "not-a-clean-ownership-key\n"]
  ] as const) {
    it(`workflow ownership recovers an abandoned ${label} final key`, async () => {
      const workspace = await makeRoot(`martin-clean-key-${label}-crash-`);
      const runsRoot = join(workspace, "runs");
      const keyRoot = join(workspace, ".clean-keys");
      const keyPath = ownershipKeyPath(runsRoot, keyRoot);
      process.env["MARTIN_CLEAN_OWNERSHIP_KEY_DIR"] = keyRoot;
      await writeCrashedOwnershipFixture(keyPath, contents, 60_000);

      await expect(ensureWorkflowCleanOwnership(runsRoot)).resolves.toBeUndefined();
      await expect(verifyWorkflowCleanOwnership(runsRoot)).resolves.toBe(true);
      expect((await readFile(keyPath, "utf8")).trim()).toMatch(/^[a-f0-9]{64}$/u);
    });
  }

  it("workflow ownership does not replace a fresh partial final key", async () => {
    const workspace = await makeRoot("martin-clean-key-live-partial-");
    const runsRoot = join(workspace, "runs");
    const keyRoot = join(workspace, ".clean-keys");
    const keyPath = ownershipKeyPath(runsRoot, keyRoot);
    process.env["MARTIN_CLEAN_OWNERSHIP_KEY_DIR"] = keyRoot;
    await writeCrashedOwnershipFixture(keyPath, "0123456789abcdef", 0);

    await expect(ensureWorkflowCleanOwnership(runsRoot)).rejects.toThrow();
    await expect(readFile(keyPath, "utf8")).resolves.toBe("0123456789abcdef");
  });

  it("workflow ownership accepts a complete key published before temp-link cleanup", async () => {
    const workspace = await makeRoot("martin-clean-key-published-crash-");
    const runsRoot = join(workspace, "runs");
    const keyRoot = join(workspace, ".clean-keys");
    const keyPath = ownershipKeyPath(runsRoot, keyRoot);
    process.env["MARTIN_CLEAN_OWNERSHIP_KEY_DIR"] = keyRoot;
    const tempPath = await writeHardLinkedPublicationCrash(keyPath, `${"f".repeat(64)}\n`);

    await expect(ensureWorkflowCleanOwnership(runsRoot)).resolves.toBeUndefined();
    await expect(verifyWorkflowCleanOwnership(runsRoot)).resolves.toBe(true);
    await expectMissing(tempPath);
    expect((await lstat(keyPath)).nlink).toBe(1);
  });

  it("clean --all refuses a loop junction or symlink and preserves the outside target", async () => {
    const workspace = await makeRoot("martin-clean-link-");
    const runsRoot = join(workspace, "runs");
    const outside = await makeRoot("martin-clean-outside-");
    const canary = join(outside, "do-not-delete.txt");
    const linkedRun = join(runsRoot, "loop_escape");
    await mkdir(runsRoot, { recursive: true });
    await writeFile(canary, "outside canary\n", "utf8");
    await writeFile(join(outside, "loop-record.json"), JSON.stringify({ loopId: "loop_escape" }), "utf8");
    await symlink(outside, linkedRun, process.platform === "win32" ? "junction" : "dir");

    const result = await executeCli([
      "clean", "--all", "--cwd", workspace, "--runs-dir", runsRoot,
    ]);

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toMatch(/symbolic link|junction|outside/iu);
    await expect(access(canary)).resolves.toBeUndefined();
  });

  it("clean --all refuses a configured runs-root junction and preserves the outside target", async () => {
    const workspace = await makeRoot("martin-clean-parent-link-");
    const outside = await makeRoot("martin-clean-parent-outside-");
    const canary = join(outside, "do-not-delete.txt");
    const linkedRunsRoot = join(workspace, "runs-link");
    await writeFile(canary, "outside canary\n", "utf8");
    await symlink(outside, linkedRunsRoot, process.platform === "win32" ? "junction" : "dir");

    const result = await executeCli([
      "clean", "--all", "--cwd", workspace, "--runs-dir", linkedRunsRoot,
    ]);

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toMatch(/configured parent|symbolic link|junction/iu);
    await expect(access(canary)).resolves.toBeUndefined();
  });

  it("clean --all revalidates a quarantined target and refuses a replacement race", async () => {
    const workspace = await makeRoot("martin-clean-replacement-race-");
    const runsRoot = join(workspace, "runs");
    const runPath = await createOwnedRun(runsRoot, "loop_race");
    const outside = await makeRoot("martin-clean-race-outside-");
    const canary = join(outside, "do-not-delete.txt");
    const parked = join(runsRoot, "parked-owned-run");
    const secondParked = join(runsRoot, "verified-run-preserved-after-restore-race");
    await writeFile(canary, "outside canary\n", "utf8");
    for (let index = 0; index < 250; index += 1) {
      await writeFile(join(runPath, `artifact-${index}.txt`), "owned artifact\n", "utf8");
    }

    let swapped = false;
    setCleanRecoveryTestHookForTesting(async ({ candidatePath }) => {
      if (!swapped && candidatePath.startsWith(join(runsRoot, ".martin-clean-"))) {
        await rename(candidatePath, parked);
        await symlink(outside, candidatePath, process.platform === "win32" ? "junction" : "dir");
        swapped = true;
        return;
      }
      if (candidatePath !== parked) {
        return;
      }
      await rename(parked, secondParked);
      await symlink(outside, parked, process.platform === "win32" ? "junction" : "dir");
    });

    const result = await executeCli([
      "clean", "--all", "--cwd", workspace, "--runs-dir", runsRoot,
    ]);

    expect(swapped).toBe(true);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("Recovery status:");
    expect(result.stderr).toContain("post-restore validation failed");
    expect(result.stderr).toContain("original path was absent when re-inspected");
    expect(result.stderr).toContain("verified target remains preserved");
    await expect(access(canary)).resolves.toBeUndefined();
    await expectMissing(runPath);
    await expectMissing(parked);
    const preservedInfo = await lstat(secondParked);
    expect(preservedInfo.isDirectory()).toBe(true);
    expect(preservedInfo.isSymbolicLink()).toBe(false);
    await expect(access(join(secondParked, "receipt-integrity.json"))).resolves.toBeUndefined();
    const isolated = (await readdir(runsRoot)).filter((name) => name.startsWith(".martin-clean-"));
    expect(isolated).toHaveLength(2);
    for (const isolatedName of isolated) {
      const isolatedPath = join(runsRoot, isolatedName);
      expect((await lstat(isolatedPath)).isSymbolicLink()).toBe(true);
      await unlink(isolatedPath);
    }
    await expect(access(canary)).resolves.toBeUndefined();
  });

  it("clean --all refuses a workflow-state junction and preserves the outside target", async () => {
    const workspace = await makeRoot("martin-clean-state-link-");
    const runsRoot = join(workspace, "runs");
    const outside = await makeRoot("martin-clean-state-outside-");
    const canary = join(outside, "do-not-delete.txt");
    await mkdir(runsRoot, { recursive: true });
    await writeFile(canary, "outside canary\n", "utf8");
    await symlink(outside, join(runsRoot, "_martin"), process.platform === "win32" ? "junction" : "dir");

    const result = await executeCli([
      "clean", "--all", "--cwd", workspace, "--runs-dir", runsRoot,
    ]);

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toMatch(/symbolic link|junction|outside/iu);
    await expect(access(canary)).resolves.toBeUndefined();
  });

  it("clean --all refuses nested junctions inside an otherwise owned run", async () => {
    const workspace = await makeRoot("martin-clean-nested-link-");
    const runsRoot = join(workspace, "runs");
    const runPath = join(runsRoot, "loop_nested_escape");
    const outside = await makeRoot("martin-clean-nested-outside-");
    const canary = join(outside, "do-not-delete.txt");
    await mkdir(runPath, { recursive: true });
    await writeFile(join(runPath, "loop-record.json"), JSON.stringify({ loopId: "loop_nested_escape" }), "utf8");
    await writeFile(canary, "outside canary\n", "utf8");
    await symlink(outside, join(runPath, "external"), process.platform === "win32" ? "junction" : "dir");

    const result = await executeCli([
      "clean", "--all", "--cwd", workspace, "--runs-dir", runsRoot,
    ]);

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toMatch(/symbolic link|junction/iu);
    await expect(access(canary)).resolves.toBeUndefined();
    await expect(access(join(runPath, "loop-record.json"))).resolves.toBeUndefined();
  });

  it("uses the stored budget in every start recommendation and generated command", async () => {
    const workspace = await makeRoot("martin-start-budget-");
    const runsRoot = join(workspace, "runs");
    await mkdir(runsRoot, { recursive: true });
    await recordPreference(runsRoot, "budget.default", 7, "explicit");

    const result = await executeCli([
      "--json", "start", "--cwd", workspace, "--runs-dir", runsRoot,
    ]);
    const payload = JSON.parse(result.stdout) as {
      recommended: { budgetUsd: number };
      next: { run: string; proofRun: string; estimate: string; enable: string };
    };

    expect(result.exitCode).toBe(0);
    expect(payload.recommended.budgetUsd).toBe(7);
    for (const command of [payload.next.run, payload.next.proofRun, payload.next.estimate, payload.next.enable]) {
      expect(command).toContain("--budget-usd 7");
    }
  });

  it("rejects an unknown challenge format before rendering evidence", async () => {
    const result = await executeCli(["challenge", "--format", "garbage"]);

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("invalid_input");
    expect(result.stdout).toBe("");
  });
});
