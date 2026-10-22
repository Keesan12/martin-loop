/**
 * Stage C terminal-path matrix tests.
 *
 * Every test uses an isolated temporary git repo (not the live dev worktree).
 * Verifier: `node verify.cjs` — exits 0/1 with no external dependencies.
 *
 * Invariants under test for every terminal path:
 * - retained candidate is removed
 * - preCandidateBoundary restored to original committed baseline
 * - pre-existing dirty state is preserved exactly
 * - termination evidence is truthful
 *
 * Additional invariants:
 * - provider exception surfaces original error after workspace cleanup
 * - workspace_restore_failed surfaces when restoration cannot be proven
 * - boundary unavailable → candidate is never retained (fail-closed)
 */

import { renameSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { createFileRunStore, runMartin, type LedgerEvent, type MartinAdapter, type MartinAdapterRequest, type RunStore } from "../src/index.js";

/** Wrap a real store to intercept appendLedger and trigger a side effect on the first occurrence of targetKind. */
function makeCorruptingStore(inner: RunStore, targetKind: string, corrupt: () => void): RunStore {
  let fired = false;
  return {
    ...inner,
    async appendLedger(runId: string, event: LedgerEvent): Promise<void> {
      await inner.appendLedger(runId, event);
      if (!fired && (event as unknown as { kind: string }).kind === targetKind) {
        fired = true;
        corrupt();
      }
    }
  };
}

// ── Canonical implementations (same as acceptance test) ──────────────────────

const CORRECT_TARGET_JS = `\
function computePriority(failureClass, attemptIndex) {
  if (failureClass !== "verification_failure" || attemptIndex === 0) return "low";
  return attemptIndex === 1 ? "high" : "medium";
}
module.exports = { computePriority };
`;

const WRONG_TARGET_JS = `\
function computePriority(failureClass, _attemptIndex) {
  if (failureClass === "verification_failure") return "high"; // BUG: ignores attemptIndex
  return "low";
}
module.exports = { computePriority };
`;

const VERIFY_CJS = `\
"use strict";
const { computePriority } = require("./src/target");
const cases = [
  { f: "verification_failure", i: 1, expected: "high" },
  { f: "verification_failure", i: 2, expected: "medium" },
  { f: "grounding_failure",    i: 1, expected: "low"    },
  { f: "verification_failure", i: 0, expected: "low"    },
];
const failures = cases.filter(c => computePriority(c.f, c.i) !== c.expected);
if (failures.length > 0) {
  failures.forEach(c =>
    process.stderr.write("FAIL: " + c.f + "," + c.i + " got " + computePriority(c.f, c.i) + " expected " + c.expected + "\\n")
  );
  process.exit(1);
}
process.stdout.write("PASS: 4 tests passed\\n");
process.exit(0);
`;

const VERIFIER_CMD = "node verify.cjs";

// ── Shared helpers ────────────────────────────────────────────────────────────

async function createIsolatedRepo(workDir: string): Promise<{ repoRoot: string; targetFile: string; dirtyFile: string }> {
  const repoRoot = join(workDir, "repo");
  await mkdir(join(repoRoot, "src"), { recursive: true });
  await writeFile(join(repoRoot, "src", "target.js"), CORRECT_TARGET_JS, "utf8");
  await writeFile(join(repoRoot, "verify.cjs"), VERIFY_CJS, "utf8");

  const run = (args: string[]) =>
    spawnSync("git", args, { cwd: repoRoot, encoding: "utf8", timeout: 10_000 });

  run(["init"]);
  run(["config", "user.name", "martin-test"]);
  run(["config", "user.email", "martin-test@test.local"]);
  run(["config", "core.autocrlf", "false"]);
  run(["config", "core.eol", "lf"]);
  run(["add", "."]);
  const commit = run(["commit", "-m", "baseline"]);
  if (commit.status !== 0) throw new Error(`git commit failed: ${commit.stderr}`);

  // Pre-existing dirty state (untracked, must survive every restore)
  const dirtyFile = join(repoRoot, "user-dirty.txt");
  await writeFile(dirtyFile, "pre-existing dirty content — must survive\n", "utf8");

  return { repoRoot, targetFile: join(repoRoot, "src", "target.js"), dirtyFile };
}

function buildBinding(request: MartinAdapterRequest) {
  const cwd = request.context.repoRoot ?? process.cwd();
  return {
    runId: request.loopId,
    workspaceId: request.workspaceId,
    attemptId: request.attemptId,
    cwd,
    ...(request.context.runsRoot ? { runsRoot: request.context.runsRoot } : {}),
    commands: request.context.verificationPlan,
  };
}

function runVerifier(request: MartinAdapterRequest) {
  const command = request.context.verificationPlan[0] ?? VERIFIER_CMD;
  const cwd = request.context.repoRoot ?? process.cwd();
  const proc = spawnSync(command, { cwd, shell: true, encoding: "utf8", timeout: 30_000 });
  const exitCode = proc.status ?? 1;
  const passed = exitCode === 0;
  const detail = [proc.stdout ?? "", proc.stderr ?? ""].filter(Boolean).join("\n");
  return {
    passed,
    summary: passed ? "Verifier passed." : `Verifier failed (exit ${exitCode}).`,
    binding: buildBinding(request),
    steps: [{
      command,
      launched: !proc.error,
      completed: !proc.error,
      crashed: !!proc.error,
      exitCode,
      timedOut: proc.signal === "SIGTERM",
      ...(detail.trim() ? { detail: detail.trim().slice(-2000) } : {}),
    }],
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("Stage C terminal matrix", () => {

  // ── T1: Retained → provider exception → workspace restored ────────────────

  it("retained → provider exception: workspace restored, original error surfaced", async () => {
    const workDir = await mkdtemp(join(tmpdir(), "martin-sc-exc-"));
    try {
      const { repoRoot, targetFile, dirtyFile } = await createIsolatedRepo(workDir);
      const store = createFileRunStore({ runsRoot: join(workDir, "runs") });
      let callCount = 0;

      const adapter: MartinAdapter = {
        adapterId: "agent-cli:claude", kind: "direct-provider", label: "exception-test",
        metadata: { providerId: "claude", model: "exc-test", capabilities: { workspaceMutations: true } },
        async execute(request) {
          callCount++;
          const usage = { actualUsd: 0.05, tokensIn: 100, tokensOut: 50, provenance: "actual" as const };
          if (callCount === 1) {
            await writeFile(targetFile, WRONG_TARGET_JS, "utf8");
            return { status: "completed" as const, summary: "wrote wrong", usage,
              verification: runVerifier(request) };
          }
          // Attempt 2: provider throws
          throw new Error("provider_exception_test");
        }
      };

      let thrownError: Error | undefined;
      try {
        await runMartin({
          workspaceId: "ws_exc", projectId: "proj_exc",
          task: { title: "test", objective: "test", verificationPlan: [VERIFIER_CMD],
            repoRoot, allowedPaths: ["src/target.js"], mutationMode: "edit" as const,
            approvalPolicy: { testChanges: true }, agentExecutionIntent: "governed-autonomous" as const },
          budget: { maxUsd: 10, softLimitUsd: 8, maxIterations: 3 },
          adapter, store,
        });
        expect.fail("Expected runMartin to throw");
      } catch (err) {
        thrownError = err as Error;
      }

      // Original error still surfaced
      expect(thrownError?.message).toContain("provider_exception_test");

      // Workspace restored: candidate (WRONG_IMPL) gone, baseline (CORRECT) back
      const content = await readFile(targetFile, "utf8");
      expect(content).toBe(CORRECT_TARGET_JS);
      // Pre-existing dirty file preserved
      expect(await readFile(dirtyFile, "utf8")).toBe("pre-existing dirty content — must survive\n");

    } finally {
      await rm(workDir, { force: true, recursive: true });
    }
  }, 30_000);

  // ── T2: Workspace restore failure → workspace_restore_failed + envelope matches ──

  it("restore failure: workspace_restore_failed in decision and termination envelope", async () => {
    const workDir = await mkdtemp(join(tmpdir(), "martin-sc-restfail-"));
    let gitRenamed = false;
    try {
      const { repoRoot, targetFile, dirtyFile } = await createIsolatedRepo(workDir);
      const store = createFileRunStore({ runsRoot: join(workDir, "runs") });
      let callCount = 0;

      const adapter: MartinAdapter = {
        adapterId: "agent-cli:claude", kind: "direct-provider", label: "restore-fail-test",
        metadata: { providerId: "claude", model: "restfail", capabilities: { workspaceMutations: true } },
        async execute(request) {
          callCount++;
          const usage = { actualUsd: 0.05, tokensIn: 100, tokensOut: 50, provenance: "actual" as const };
          if (callCount === 1) {
            await writeFile(targetFile, WRONG_TARGET_JS, "utf8");
            return { status: "completed" as const, summary: "wrote wrong", usage,
              verification: runVerifier(request) };
          }
          // Attempt 2: corrupt the git repo so all git operations fail.
          // This makes resolveChangedFiles throw (observation failure) AND
          // makes restoreRetainedCandidateForTerminalExit fail → workspace_restore_failed.
          const gitDir = join(repoRoot, ".git");
          renameSync(gitDir, join(repoRoot, ".git.bak"));
          gitRenamed = true;
          // Return any result — processing will fail at resolveChangedFiles due to no .git
          return { status: "completed" as const, summary: "corrupted git", usage,
            verification: { passed: false, summary: "fail", steps: [], binding: buildBinding(request) } };
        }
      };

      const result = await runMartin({
        workspaceId: "ws_rf", projectId: "proj_rf",
        task: { title: "test", objective: "test", verificationPlan: [VERIFIER_CMD],
          repoRoot, allowedPaths: ["src/target.js"], mutationMode: "edit" as const,
          approvalPolicy: { testChanges: true }, agentExecutionIntent: "governed-autonomous" as const },
        budget: { maxUsd: 10, softLimitUsd: 8, maxIterations: 3 },
        adapter, store,
      });

      // Restore failed: decision reflects workspace_restore_failed
      expect(result.decision.reasonCode).toBe("workspace_restore_failed");
      expect(result.decision.lifecycleState).toBe("human_escalation");

      // In-memory termination envelope authority: must NOT claim a clean original exit
      const envelope = result.loop.terminationEnvelope as { class: string; guard?: { reasonCode?: string } } | undefined;
      expect(envelope?.class).toBe("guard_stop");
      expect(envelope?.guard?.reasonCode).toBe("workspace_restore_failed");

      // Persisted termination.json must agree with the in-memory envelope (not the pre-cleanup state)
      const loopId = result.loop.loopId;
      const terminationPath = join(workDir, "runs", loopId, "termination.json");
      const persistedEnvelope = JSON.parse(await readFile(terminationPath, "utf8")) as { class: string; guard?: { reasonCode?: string } };
      expect(persistedEnvelope.class).toBe("guard_stop");
      expect(persistedEnvelope.guard?.reasonCode).toBe("workspace_restore_failed");

      // Dirty baseline file was preserved (was not cleaned up despite restore failure)
      expect(await readFile(dirtyFile, "utf8")).toBe("pre-existing dirty content — must survive\n");

    } finally {
      // Restore .git before cleanup so rm -rf can clean up
      if (gitRenamed) {
        try {
          const repoRoot = join(workDir, "repo");
          renameSync(join(repoRoot, ".git.bak"), join(repoRoot, ".git"));
        } catch { /* ignore */ }
      }
      await rm(workDir, { force: true, recursive: true });
    }
  }, 30_000);

  // ── T2b: turn_cap → terminateRun → restore fails → guard_stop persisted ──────
  //
  // This test specifically proves:
  //   1. evaluateCheckpoint() selects the winning evaluation IN MEMORY (no disk write)
  //   2. terminateRun() is called with the in-memory envelope
  //   3. cleanup fails (git corrupted at the run.exited ledger write inside terminateRun,
  //      which is BEFORE restoreRetainedCandidateForTerminalExit runs)
  //   4. terminateRun() writes guard_stop as the SOLE termination.json — not the
  //      pre-cleanup operational_exit
  //   This proves the first-write-wins disk ordering is correct.

  it("terminateRun path: turn_cap fires, restore fails → guard_stop is the persisted termination.json", async () => {
    const workDir = await mkdtemp(join(tmpdir(), "martin-sc-t2b-"));
    let gitRenamed = false;
    try {
      const { repoRoot, targetFile, dirtyFile } = await createIsolatedRepo(workDir);
      const runsRoot = join(workDir, "runs");
      const innerStore = createFileRunStore({ runsRoot });

      // Intercept appendLedger: when terminateRun writes "run.exited" (before cleanup),
      // corrupt the git repository. Then cleanup's restoreRollbackBoundary fails → workspace_restore_failed.
      const corruptingStore = makeCorruptingStore(innerStore, "run.exited", () => {
        try {
          renameSync(join(repoRoot, ".git"), join(repoRoot, ".git.bak"));
          gitRenamed = true;
        } catch { /* already renamed */ }
      });

      const adapter: MartinAdapter = {
        adapterId: "agent-cli:claude", kind: "direct-provider", label: "t2b",
        metadata: { providerId: "claude", model: "t2b", capabilities: { workspaceMutations: true } },
        async execute(request) {
          // Write wrong code — git is available at this point
          await writeFile(targetFile, WRONG_TARGET_JS, "utf8");
          const usage = { actualUsd: 0.05, tokensIn: 100, tokensOut: 50, provenance: "actual" as const };
          return { status: "completed" as const, summary: "wrote wrong", usage,
            verification: runVerifier(request) };
        }
      };

      const result = await runMartin({
        workspaceId: "ws_t2b", projectId: "proj_t2b",
        task: { title: "test", objective: "test", verificationPlan: [VERIFIER_CMD],
          repoRoot, allowedPaths: ["src/target.js"], mutationMode: "edit" as const,
          approvalPolicy: { testChanges: true }, agentExecutionIntent: "governed-autonomous" as const },
        budget: { maxUsd: 0.50, softLimitUsd: 0.40, maxIterations: 1 },
        adapter, store: corruptingStore,
      });

      // The turn_cap fired → terminateRun was called → cleanup failed → workspace_restore_failed
      expect(result.decision.reasonCode).toBe("workspace_restore_failed");
      expect(result.decision.lifecycleState).toBe("human_escalation");

      // In-memory terminationEnvelope agrees
      const envelope = result.loop.terminationEnvelope as { class: string; guard?: { reasonCode?: string } } | undefined;
      expect(envelope?.class).toBe("guard_stop");
      expect(envelope?.guard?.reasonCode).toBe("workspace_restore_failed");

      // Persisted termination.json is guard_stop — NOT the pre-cleanup operational_exit.
      // This is the key assertion: proves first-write-wins happened AFTER cleanup.
      const loopId = result.loop.loopId;
      const terminationPath = join(runsRoot, loopId, "termination.json");
      const persisted = JSON.parse(await readFile(terminationPath, "utf8")) as { class: string; guard?: { reasonCode?: string } };
      expect(persisted.class).toBe("guard_stop");
      expect(persisted.guard?.reasonCode).toBe("workspace_restore_failed");

      // result.loop.terminationEnvelope must match what is on disk
      expect(envelope?.class).toBe(persisted.class);
      expect(envelope?.guard?.reasonCode).toBe(persisted.guard?.reasonCode);

      // Pre-existing dirty file preserved
      expect(await readFile(dirtyFile, "utf8")).toBe("pre-existing dirty content — must survive\n");

    } finally {
      if (gitRenamed) {
        try { renameSync(join(workDir, "repo", ".git.bak"), join(workDir, "repo", ".git")); } catch { /* ignore */ }
      }
      await rm(workDir, { force: true, recursive: true });
    }
  }, 30_000);

  // ── T3: Boundary unavailable → retention prohibited (fail-closed) ─────────

  it("boundary unavailable: candidate never retained when rollbackBoundary is absent", async () => {
    const workDir = await mkdtemp(join(tmpdir(), "martin-sc-noboundary-"));
    try {
      const store = createFileRunStore({ runsRoot: join(workDir, "runs") });

      const adapter: MartinAdapter = {
        adapterId: "agent-cli:claude", kind: "direct-provider", label: "no-boundary-test",
        metadata: { providerId: "claude", model: "noboundary", capabilities: { workspaceMutations: false } },
        async execute(request) {
          const usage = { actualUsd: 0.05, tokensIn: 100, tokensOut: 50, provenance: "actual" as const };
          return { status: "completed" as const, summary: "fail", usage,
            verification: { passed: false, summary: "fail", steps: [],
              binding: buildBinding(request) } };
        }
      };

      // No repoRoot → tracksWorkspaceMutations = false → rollbackBoundary = undefined
      // → candidateRetainedThisAttempt = false (Blocker 3 invariant)
      const result = await runMartin({
        workspaceId: "ws_nb", projectId: "proj_nb",
        task: { title: "test", objective: "test", verificationPlan: ["node -e 'process.exit(1)'"],
          // No repoRoot
          mutationMode: "edit" as const, agentExecutionIntent: "governed-autonomous" as const },
        budget: { maxUsd: 0.10, softLimitUsd: 0.08, maxIterations: 1 },
        adapter, store,
      });

      expect(result.loop.attempts[0]?.candidateRetained).toBeFalsy();
      expect(result.decision.lifecycleState).not.toBe("completed");

    } finally {
      await rm(workDir, { force: true, recursive: true });
    }
  }, 15_000);

  // ── T4: Retained → scope violation → baseline restored, dirty state preserved ──

  it("retained → scope violation: baseline restored, pre-existing dirty state preserved", async () => {
    const workDir = await mkdtemp(join(tmpdir(), "martin-sc-scope-"));
    try {
      const { repoRoot, targetFile, dirtyFile } = await createIsolatedRepo(workDir);
      const store = createFileRunStore({ runsRoot: join(workDir, "runs") });
      const disallowedFile = join(repoRoot, "outside.js");
      let callCount = 0;

      const adapter: MartinAdapter = {
        adapterId: "agent-cli:claude", kind: "direct-provider", label: "scope-test",
        metadata: { providerId: "claude", model: "scope", capabilities: { workspaceMutations: true } },
        async execute(request) {
          callCount++;
          const usage = { actualUsd: 0.05, tokensIn: 100, tokensOut: 50, provenance: "actual" as const };
          if (callCount === 1) {
            await writeFile(targetFile, WRONG_TARGET_JS, "utf8");
            return { status: "completed" as const, summary: "attempt 1", usage,
              verification: runVerifier(request) };
          }
          // Attempt 2: writes to a disallowed file → scope violation
          await writeFile(disallowedFile, "outside scope\n", "utf8");
          return { status: "completed" as const, summary: "scope violation", usage,
            verification: runVerifier(request) };
        }
      };

      const result = await runMartin({
        workspaceId: "ws_scope", projectId: "proj_scope",
        task: { title: "test", objective: "test", verificationPlan: [VERIFIER_CMD],
          repoRoot, allowedPaths: ["src/target.js"], mutationMode: "edit" as const,
          approvalPolicy: { testChanges: true }, agentExecutionIntent: "governed-autonomous" as const },
        budget: { maxUsd: 10, softLimitUsd: 8, maxIterations: 3 },
        adapter, store,
      });

      // Attempt 1 retained
      expect(result.loop.attempts[0]?.candidateRetained).toBe(true);
      // Scope violation caused human_escalation exit
      expect(result.decision.lifecycleState).toBe("human_escalation");

      // Target file restored to baseline (CORRECT_IMPL) via preCandidateBoundary restore
      const finalContent = await readFile(targetFile, "utf8");
      expect(finalContent).toBe(CORRECT_TARGET_JS);

      // Disallowed file removed (per-attempt rollback) — may or may not exist
      // depending on whether the cleanup deleted it; the key invariant is target.js is clean.

      // Pre-existing dirty file preserved
      expect(await readFile(dirtyFile, "utf8")).toBe("pre-existing dirty content — must survive\n");

    } finally {
      await rm(workDir, { force: true, recursive: true });
    }
  }, 30_000);

  // ── T5: Retained → turn exit → baseline restored (additional coverage) ────

  it("retained → turn exit: preCandidateBoundary restored, dirty state preserved", async () => {
    const workDir = await mkdtemp(join(tmpdir(), "martin-sc-turn-"));
    try {
      const { repoRoot, targetFile, dirtyFile } = await createIsolatedRepo(workDir);
      const store = createFileRunStore({ runsRoot: join(workDir, "runs") });

      const adapter: MartinAdapter = {
        adapterId: "agent-cli:claude", kind: "direct-provider", label: "turn-test",
        metadata: { providerId: "claude", model: "turn", capabilities: { workspaceMutations: true } },
        async execute(request) {
          await writeFile(targetFile, WRONG_TARGET_JS, "utf8");
          return { status: "completed" as const, summary: "fail", usage: { actualUsd: 0.05, tokensIn: 100, tokensOut: 50, provenance: "actual" as const },
            verification: runVerifier(request) };
        }
      };

      const result = await runMartin({
        workspaceId: "ws_turn", projectId: "proj_turn",
        task: { title: "test", objective: "test", verificationPlan: [VERIFIER_CMD],
          repoRoot, allowedPaths: ["src/target.js"], mutationMode: "edit" as const,
          approvalPolicy: { testChanges: true }, agentExecutionIntent: "governed-autonomous" as const },
        budget: { maxUsd: 0.50, softLimitUsd: 0.40, maxIterations: 1 },
        adapter, store,
      });

      expect(result.loop.attempts[0]?.candidateRetained).toBe(true);
      expect(result.decision.lifecycleState).not.toBe("completed");

      // Baseline restored
      expect(await readFile(targetFile, "utf8")).toBe(CORRECT_TARGET_JS);
      // Dirty state preserved
      expect(await readFile(dirtyFile, "utf8")).toBe("pre-existing dirty content — must survive\n");

    } finally {
      await rm(workDir, { force: true, recursive: true });
    }
  }, 30_000);

});
