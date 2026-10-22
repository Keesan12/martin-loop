/**
 * Stage C same-run acceptance test — isolated temp-repo, real verifier proof.
 *
 * Uses a self-contained temporary git repository (not the live development worktree)
 * so Stage C rollback/retention operates against a clean, known git state.
 *
 * Verifier: `node verify.cjs` — reads src/target.js and exits 0 (pass) / 1 (fail).
 * No pnpm, no vitest subprocess, no monorepo routing. Pure native exit codes.
 *
 * ATTEMPT 1: adapter writes WRONG_IMPL → verifier exits 1
 *   → candidate SAFE_UNVERIFIED, retained in workspace
 *   → candidateRetained = true
 *   → lastVerifierFailure carries exact attempt-1 evidence
 *
 * ATTEMPT 2: sees previousCandidateRetained=true, observes WRONG_IMPL on disk,
 *   repairs to CORRECT_IMPL → verifier exits 0
 *   → effectiveVerification.passed = true → VERIFIED
 *
 * TERMINAL TEST: attempt 1 retained, maxIterations=1 → terminal cleanup restores
 *   src/target.js to HEAD (CORRECT_IMPL) and preserves user-dirty.txt exactly.
 */

import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { createFileRunStore, runMartin, type MartinAdapter, type MartinAdapterRequest } from "../src/index.js";

// ── Canonical implementations ─────────────────────────────────────────────────

/** CORRECT implementation — passes all 4 oracle assertions in verify.cjs. */
const CORRECT_TARGET_JS = `\
function computePriority(failureClass, attemptIndex) {
  if (failureClass !== "verification_failure" || attemptIndex === 0) return "low";
  return attemptIndex === 1 ? "high" : "medium";
}
module.exports = { computePriority };
`;

/** WRONG implementation — fails tests 2 and 4. */
const WRONG_TARGET_JS = `\
function computePriority(failureClass, _attemptIndex) {
  if (failureClass === "verification_failure") return "high"; // BUG: ignores attemptIndex
  return "low";
}
module.exports = { computePriority };
`;

/**
 * Minimal self-contained verifier script.
 * Reads ./src/target.js, runs 4 assertions, exits 0 or 1.
 * Zero external dependencies.
 */
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
    process.stderr.write(
      "FAIL: computePriority(" + c.f + "," + c.i + ")=" +
      computePriority(c.f, c.i) + " expected " + c.expected + "\\n"
    )
  );
  process.exit(1);
}
process.stdout.write("PASS: 4 tests passed\\n");
process.exit(0);
`;

const VERIFIER_CMD = "node verify.cjs";

// ── Temp repo setup ───────────────────────────────────────────────────────────

/** Initialize an isolated git repo with a clean committed baseline. */
async function createIsolatedRepo(rootDir: string): Promise<{ repoRoot: string; targetFile: string }> {
  const repoRoot = join(rootDir, "repo");
  await mkdir(join(repoRoot, "src"), { recursive: true });

  // Write initial files
  await writeFile(join(repoRoot, "src", "target.js"), CORRECT_TARGET_JS, "utf8");
  await writeFile(join(repoRoot, "verify.cjs"), VERIFY_CJS, "utf8");

  // Initialize git
  const run = (args: string[]) =>
    spawnSync("git", args, { cwd: repoRoot, encoding: "utf8", timeout: 10_000 });

  run(["init"]);
  run(["config", "user.name", "martin-test"]);
  run(["config", "user.email", "martin-test@test.local"]);
  // Disable line-ending conversion so git checkout restores exact bytes.
  run(["config", "core.autocrlf", "false"]);
  run(["config", "core.eol", "lf"]);
  run(["add", "."]);
  const commit = run(["commit", "-m", "baseline"]);
  if (commit.status !== 0) {
    throw new Error(`Failed to create baseline commit: ${commit.stderr}`);
  }

  const targetFile = join(repoRoot, "src", "target.js");
  return { repoRoot, targetFile };
}

/** Build a complete verifier binding matching resolveExpectedVerifierBinding(). */
function buildBinding(request: MartinAdapterRequest) {
  const cwd = request.context.repoRoot ?? process.cwd();
  return {
    runId: request.loopId,
    workspaceId: request.workspaceId,
    attemptId: request.attemptId,
    cwd,
    ...(request.context.runsRoot ? { runsRoot: request.context.runsRoot } : {}),
    ...(request.context.executionProfile ? { executionProfile: request.context.executionProfile } : {}),
    ...(request.context.allowedNetworkDomains?.length
      ? { allowedNetworkDomains: [...request.context.allowedNetworkDomains] }
      : {}),
    commands: request.context.verificationPlan,
  };
}

/** Run `node verify.cjs` from repoRoot and return structured evidence. */
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

describe("Stage C same-run acceptance", () => {
  it("retain→repair→VERIFIED: attempt 1 fails (exit 1), candidate retained, attempt 2 repairs (exit 0)", async () => {
    const workDir = await mkdtemp(join(tmpdir(), "martin-sc-accept-"));
    try {
      const { repoRoot, targetFile } = await createIsolatedRepo(workDir);
      // Create pre-existing dirty state (untracked, must survive rollback)
      const dirtyFile = join(repoRoot, "user-dirty.txt");
      await writeFile(dirtyFile, "pre-existing dirty content — must survive\n", "utf8");

      const store = createFileRunStore({ runsRoot: join(workDir, "runs") });
      const capturedAttempts: MartinAdapterRequest[] = [];
      let callCount = 0;
      let attempt2ObservedCandidate: string | undefined;
      let attempt1NativeExitCode: number | undefined;

      const adapter: MartinAdapter = {
        adapterId: "agent-cli:claude",
        kind: "direct-provider",
        label: "Stage C real-verifier fault-injection",
        metadata: { providerId: "claude", model: "real-exec", capabilities: { workspaceMutations: true } },
        async execute(request) {
          capturedAttempts.push(request);
          callCount++;
          const usage = { actualUsd: 0.05, tokensIn: 100, tokensOut: 50, provenance: "actual" as const };

          if (callCount === 1) {
            await writeFile(targetFile, WRONG_TARGET_JS, "utf8");
          } else {
            // Capture what attempt 2 sees BEFORE repairing
            attempt2ObservedCandidate = await readFile(targetFile, "utf8");
            await writeFile(targetFile, CORRECT_TARGET_JS, "utf8");
          }

          const verification = runVerifier(request);
          if (callCount === 1) attempt1NativeExitCode = (verification.steps[0] as { exitCode: number }).exitCode;

          return {
            status: "completed" as const,
            summary: callCount === 1 ? "Implemented wrong." : "Repaired.",
            usage,
            verification,
          };
        },
      };

      const result = await runMartin({
        workspaceId: "ws_sc_accept",
        projectId: "proj_sc_accept",
        task: {
          title: "Fix computePriority",
          objective: "Fix computePriority in src/target.js.",
          verificationPlan: [VERIFIER_CMD],
          repoRoot,
          allowedPaths: ["src/target.js"],
          mutationMode: "edit" as const,
          approvalPolicy: { testChanges: true },
          agentExecutionIntent: "governed-autonomous" as const,
        },
        budget: { maxUsd: 10.00, softLimitUsd: 8.00, maxIterations: 3 },
        adapter,
        store,
      });

      // ── Attempt 1: verifier exit 1, candidate retained ────────────────────
      expect(capturedAttempts).toHaveLength(2);
      expect(attempt1NativeExitCode).toBe(1);                            // native exit 1 from node verify.cjs
      const attempt1 = result.loop.attempts[0];
      expect(attempt1?.verifierScore).toBeLessThan(1);                   // normalized: failed
      expect(attempt1?.candidateRetained).toBe(true);                    // SAFE_UNVERIFIED retained
      expect(attempt1?.failingVerifierStepCount).toBe(1);                // 1 failing verifier command

      // ── Attempt 2: inherited exactly attempt-1 context ───────────────────
      const req2 = capturedAttempts[1]!;
      expect(req2.context.previousCandidateRetained).toBe(true);
      expect(req2.context.lastVerifierFailure?.exitCode).toBe(1);
      expect(req2.context.lastVerifierFailure?.attemptIndex).toBe(1);
      // Attempt-2 adapter saw WRONG_IMPL still on disk (candidate retained)
      expect(attempt2ObservedCandidate).toBe(WRONG_TARGET_JS);

      // ── Final: VERIFIED, CORRECT_IMPL on disk, no third attempt ──────────
      expect(result.loop.attempts).toHaveLength(2);
      expect(result.decision.lifecycleState).toBe("completed");
      const finalContent = await readFile(targetFile, "utf8");
      expect(finalContent).toBe(CORRECT_TARGET_JS);
      // Pre-existing dirty file preserved exactly
      expect(await readFile(dirtyFile, "utf8")).toBe("pre-existing dirty content — must survive\n");

    } finally {
      await rm(workDir, { force: true, recursive: true });
    }
  }, 30_000);

  it("terminal stop: retained candidate cleaned up, original baseline restored, dirty state preserved", async () => {
    const workDir = await mkdtemp(join(tmpdir(), "martin-sc-terminal-"));
    try {
      const { repoRoot, targetFile } = await createIsolatedRepo(workDir);
      // Pre-existing dirty baseline (must survive terminal restore)
      const dirtyFile = join(repoRoot, "user-dirty.txt");
      await writeFile(dirtyFile, "user-dirty — must survive terminal restore\n", "utf8");

      const store = createFileRunStore({ runsRoot: join(workDir, "runs") });

      const adapter: MartinAdapter = {
        adapterId: "agent-cli:claude",
        kind: "direct-provider",
        label: "Single-attempt real-verifier",
        metadata: { providerId: "claude", model: "real-exec-single", capabilities: { workspaceMutations: true } },
        async execute(request) {
          await writeFile(targetFile, WRONG_TARGET_JS, "utf8");
          const usage = { actualUsd: 0.05, tokensIn: 50, tokensOut: 20, provenance: "actual" as const };
          return {
            status: "completed" as const,
            summary: "Attempted fix.",
            usage,
            verification: runVerifier(request),
          };
        },
      };

      const result = await runMartin({
        workspaceId: "ws_sc_terminal",
        projectId: "proj_sc_terminal",
        task: {
          title: "Fix computePriority (one attempt)",
          objective: "Fix computePriority.",
          verificationPlan: [VERIFIER_CMD],
          repoRoot,
          allowedPaths: ["src/target.js"],
          mutationMode: "edit" as const,
          approvalPolicy: { testChanges: true },
          agentExecutionIntent: "governed-autonomous" as const,
        },
        budget: { maxUsd: 0.50, softLimitUsd: 0.40, maxIterations: 1 },
        adapter,
        store,
      });

      // Run ended without VERIFIED
      expect(result.decision.lifecycleState).not.toBe("completed");
      // Candidate was retained in attempt 1
      expect(result.loop.attempts[0]?.candidateRetained).toBe(true);

      // Terminal cleanup restored src/target.js to HEAD baseline (CORRECT_IMPL)
      const finalTarget = await readFile(targetFile, "utf8");
      expect(finalTarget).toBe(CORRECT_TARGET_JS);                       // pre-candidate state restored
      expect(finalTarget).not.toContain("BUG: ignores attemptIndex");    // WRONG_IMPL gone

      // Pre-existing dirty file preserved exactly (not deleted by rollback)
      const finalDirty = await readFile(dirtyFile, "utf8");
      expect(finalDirty).toBe("user-dirty — must survive terminal restore\n");

    } finally {
      await rm(workDir, { force: true, recursive: true });
    }
  }, 30_000);
});
