/**
 * Regression tests for `runs verify` exit code contract.
 *
 * The exit code must reflect BOTH receipt integrity AND handoff outcome.
 * A valid signature on the bytes does not guarantee the work was verified.
 *
 * Complete exit-code contract:
 *   receipt=verified  + outcome=VERIFIED      → exit 0   (clean)
 *   receipt=verified  + outcome=NEEDS_REVIEW  → exit 7   (work not verified, bytes intact)
 *   receipt=verified  + outcome=STOPPED       → exit 9   (budget stop, bytes intact)
 *   receipt=tamper_detected                   → exit 7   (active tampering)
 *   receipt=material_missing                  → exit 6   (untrustworthy evidence)
 *   receipt=relocated                         → exit 6   (untrustworthy evidence)
 *   receipt=selector_noncanonical (*)         → exit 6   (untrustworthy evidence)
 *
 * (*) selector_noncanonical is no longer produced by --file <json-file>: that
 *     path now sets runDirectory so the canonical integrity check runs.  It is
 *     still produced by code paths that reconstruct a loop from a workspace index
 *     without a known on-disk record location.
 *
 * The `unsigned` integrity state is documented but not exercised with a live
 * fixture: the canonical verifier only produces it for pre-upgrade records written
 * before the HMAC sidecar was introduced.  The `integrityState !== "verified"`
 * branch covers `unsigned`; verifying it would require injecting internal key
 * material outside the public API.
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createStubDirectProviderAdapter } from "@martin/adapters";
import { writeReceiptIntegrityMaterial } from "@martin/core";
import { afterEach, describe, expect, it } from "vitest";

import { createLoopRecord, type LoopRecord } from "../../contracts/src/index.js";
import { __setRunAdapterOverrideForTests, executeCli } from "../src/index.js";

const RUNS_VERIFY_TAMPER_EXIT_CODE = 7;
const RUNS_VERIFY_UNTRUSTED_EXIT_CODE = 6;
const RUNS_VERIFY_NEEDS_REVIEW_EXIT_CODE = 7; // same as verification_failed category
const NOOP_VERIFIER = process.platform === "win32" ? "cmd /c exit 0" : "true";

afterEach(() => {
  __setRunAdapterOverrideForTests(undefined);
});

async function withIsolatedRunsEnv<T>(directory: string, fn: () => Promise<T>): Promise<T> {
  const previous = process.env.MARTIN_RUNS_DIR;
  const prevKey = process.env.MARTIN_INTEGRITY_KEY_DIR;
  process.env.MARTIN_RUNS_DIR = join(directory, ".martin-runs");
  process.env.MARTIN_INTEGRITY_KEY_DIR = join(directory, ".martin-receipt-integrity");
  try {
    return await fn();
  } finally {
    if (previous === undefined) delete process.env.MARTIN_RUNS_DIR;
    else process.env.MARTIN_RUNS_DIR = previous;
    if (prevKey === undefined) delete process.env.MARTIN_INTEGRITY_KEY_DIR;
    else process.env.MARTIN_INTEGRITY_KEY_DIR = prevKey;
  }
}

/**
 * Build a minimal LoopRecord suitable for integrity and outcome testing.
 *
 * Design choices that directly affect which exit codes are produced:
 *
 *   mutationMode: "read_only"
 *     resolveVerifiedHandoffOutcome checks (mutationRequired && changedFileCount === 0)
 *     → NEEDS_REVIEW.  Using "read_only" removes that gate so VERIFIED is reachable
 *     with zero changed files.
 *
 *   terminationEnvelope.primary: always "goal_met"
 *     "goal_met" keeps the lifecycle out of the STOPPED branch.  For the NEEDS_REVIEW
 *     case we vary verifierPassed=false — the verifier failure (not the lifecycle) drives
 *     the outcome.  Using "verification_failed" as primary would produce STOPPED (exit 9),
 *     not NEEDS_REVIEW (exit 7).
 */
function makeMinimalLoop(directory: string, loopId = "loop_exit_code_test", verifierPassed = true): LoopRecord {
  const runsRoot = join(directory, ".martin-runs");
  const base = createLoopRecord({
    workspaceId: "ws_exit_code_test",
    projectId: "proj_exit_code_test",
    task: {
      title: "Exit code regression",
      objective: "Exit code regression",
      repoRoot: directory,
      verificationPlan: ["node --version"],
      mutationMode: "read_only", // avoids changedFileCount gate in resolveVerifiedHandoffOutcome
    },
    budget: { maxUsd: 1, softLimitUsd: 0.8, maxIterations: 1 },
    cost: { actualUsd: 0.01, avoidedUsd: 0, tokensIn: 10, tokensOut: 5, provenance: "actual" },
    receiptScope: { workingDirectory: directory, runsRoot },
    terminationEnvelope: {
      schemaVersion: "termination/1",
      class: "operational_exit",
      exit: {
        schemaVersion: "exit-evaluation/1",
        policyVersion: "exit-policy/1",
        shouldExit: true,
        primary: "goal_met", // always goal_met; verifierPassed controls outcome tier
        matched: ["goal_met"],
        phase: "post_attempt",
        evaluatedAt: "2026-10-20T00:00:00.000Z",
        matches: [{ kind: "goal_met", reason: "Lifecycle complete.", evidence: {} }],
      },
    },
  });
  return {
    ...base,
    loopId,
    status: "completed",
    lifecycleState: "completed",
    updatedAt: "2026-10-20T00:00:01.000Z",
    attempts: [{
      attemptId: "att_exit_code_test",
      index: 1,
      adapterId: "agent-cli:codex",
      model: "test-model",
      startedAt: "2026-10-20T00:00:00.000Z",
      completedAt: "2026-10-20T00:00:01.000Z",
    }],
    events: [
      {
        eventId: "evt_verification",
        timestamp: "2026-10-20T00:00:01.000Z",
        type: "verification.completed",
        lifecycleState: "verifying",
        payload: {
          passed: verifierPassed,
          attemptIndex: 1,
          summary: verifierPassed ? "Passed." : "Verifier exited non-zero.",
          changedFiles: [],
          binding: {
            runId: loopId,
            workspaceId: "ws_exit_code_test",
            attemptId: "att_exit_code_test",
            cwd: directory,
            runsRoot,
            commands: ["node --version"],
          },
          steps: [{ command: "node --version", launched: true, completed: true, crashed: false, exitCode: verifierPassed ? 0 : 1, timedOut: false }],
        },
      },
      {
        eventId: "evt_run_completed",
        timestamp: "2026-10-20T00:00:02.000Z",
        type: "run.completed",
        lifecycleState: "completed",
        payload: {
          reason: verifierPassed ? "goal_met" : "verification_failed",
          fileEffects: {
            observationStatus: "observed",
            touchedDuringExecution: [],
            netChangedAtCompletion: [],
            revertedBeforeCompletion: [],
          },
        },
      },
    ],
  };
}

async function persistLoop(directory: string, loop: LoopRecord): Promise<void> {
  const runsRoot = join(directory, ".martin-runs");
  const loopDir = join(runsRoot, loop.loopId);
  const ledgerEntries = loop.events;
  await mkdir(loopDir, { recursive: true });
  await writeFile(join(loopDir, "loop-record.json"), `${JSON.stringify(loop, null, 2)}\n`, "utf8");
  await writeFile(join(loopDir, "ledger.jsonl"), `${ledgerEntries.map((e) => JSON.stringify(e)).join("\n")}\n`, "utf8");
  await writeReceiptIntegrityMaterial({ runId: loop.loopId, runsRoot, loopRecord: loop, ledgerEntries, scope: loop.receiptScope, signedAt: loop.updatedAt });
}

async function persistLoopWithoutIntegritySidecar(directory: string, loop: LoopRecord): Promise<void> {
  const runsRoot = join(directory, ".martin-runs");
  const loopDir = join(runsRoot, loop.loopId);
  const ledgerEntries = loop.events;
  await mkdir(loopDir, { recursive: true });
  await writeFile(join(loopDir, "loop-record.json"), `${JSON.stringify(loop, null, 2)}\n`, "utf8");
  await writeFile(join(loopDir, "ledger.jsonl"), `${ledgerEntries.map((e) => JSON.stringify(e)).join("\n")}\n`, "utf8");
  // Deliberately omit writeReceiptIntegrityMaterial → material_missing state
}

describe("runs verify exit code contract — receipt integrity tier", () => {
  // ── Positive control ──────────────────────────────────────────────────────
  it("exits 0 for verified receipt + VERIFIED outcome via --loop-id", async () => {
    const directory = await mkdtemp(join(tmpdir(), "martin-exit-verified-"));
    try {
      await withIsolatedRunsEnv(directory, async () => {
        const loop = makeMinimalLoop(directory, "loop_exit_verified");
        await persistLoop(directory, loop);
        const result = await executeCli(["--json", "runs", "verify", "--loop-id", loop.loopId]);
        expect(result.exitCode).toBe(0);
        const parsed = JSON.parse(result.stdout);
        expect(parsed.receiptIntegrity.state).toBe("verified");
        expect(parsed.verifiedHandoff.outcome).toBe("VERIFIED");
      });
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("exits 0 for verified receipt via --file <json-file> when file is within runs root", async () => {
    const directory = await mkdtemp(join(tmpdir(), "martin-exit-file-canonical-"));
    try {
      await withIsolatedRunsEnv(directory, async () => {
        const loop = makeMinimalLoop(directory, "loop_exit_file_canonical");
        await persistLoop(directory, loop);
        // --file <json-file> now resolves runDirectory so integrity check runs canonically
        const loopRecordPath = join(directory, ".martin-runs", loop.loopId, "loop-record.json");
        const result = await executeCli(["--json", "runs", "verify", "--file", loopRecordPath]);
        expect(result.exitCode).toBe(0);
        const parsed = JSON.parse(result.stdout);
        expect(parsed.receiptIntegrity.state).toBe("verified");
      });
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  // ── Active tampering ──────────────────────────────────────────────────────
  it("exits 7 for tamper_detected (loop-record bytes modified after signing)", async () => {
    const directory = await mkdtemp(join(tmpdir(), "martin-exit-tampered-"));
    try {
      await withIsolatedRunsEnv(directory, async () => {
        const loopId = "loop_exit_tampered";
        const loop = makeMinimalLoop(directory, loopId);
        await persistLoop(directory, loop);
        const loopRecordPath = join(directory, ".martin-runs", loopId, "loop-record.json");
        const original = JSON.parse(await readFile(loopRecordPath, "utf8")) as Record<string, unknown>;
        original["_tampered"] = true;
        await writeFile(loopRecordPath, `${JSON.stringify(original, null, 2)}\n`, "utf8");
        const result = await executeCli(["--json", "runs", "verify", "--loop-id", loopId]);
        expect(result.exitCode).toBe(RUNS_VERIFY_TAMPER_EXIT_CODE);
        const parsed = JSON.parse(result.stdout);
        expect(parsed.receiptIntegrity.state).toBe("tamper_detected");
      });
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  // ── Missing sidecar ───────────────────────────────────────────────────────
  it("exits 6 for material_missing (no integrity sidecar)", async () => {
    const directory = await mkdtemp(join(tmpdir(), "martin-exit-missing-"));
    try {
      await withIsolatedRunsEnv(directory, async () => {
        const loop = makeMinimalLoop(directory, "loop_exit_missing");
        await persistLoopWithoutIntegritySidecar(directory, loop);
        const result = await executeCli(["--json", "runs", "verify", "--loop-id", loop.loopId]);
        expect(result.exitCode).toBe(RUNS_VERIFY_UNTRUSTED_EXIT_CODE);
        const parsed = JSON.parse(result.stdout);
        expect(parsed.receiptIntegrity.state).toBe("material_missing");
      });
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  // ── Relocated evidence ────────────────────────────────────────────────────
  it("exits 6 and reports relocated when loop directory is outside the provided runs root", async () => {
    const directory = await mkdtemp(join(tmpdir(), "martin-exit-relocated-"));
    try {
      await withIsolatedRunsEnv(directory, async () => {
        const loopId = "loop_exit_relocated";
        const loop = makeMinimalLoop(directory, loopId);
        await persistLoop(directory, loop);
        const loopDir = join(directory, ".martin-runs", loopId);
        const altRunsRoot = join(directory, ".martin-runs-alt");
        await mkdir(altRunsRoot, { recursive: true });
        // loopDir lies outside altRunsRoot → relocated
        const result = await executeCli(["--json", "runs", "verify", "--file", loopDir, "--runs-dir", altRunsRoot]);
        expect(result.exitCode).toBe(RUNS_VERIFY_UNTRUSTED_EXIT_CODE);
        const parsed = JSON.parse(result.stdout);
        expect(parsed.receiptIntegrity.state).toBe("relocated");
      });
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  // ── --file outside runs root ──────────────────────────────────────────────
  it("exits 6 and reports relocated when --file <json-file> is outside the runs root", async () => {
    const directory = await mkdtemp(join(tmpdir(), "martin-exit-file-outside-"));
    try {
      await withIsolatedRunsEnv(directory, async () => {
        const loopId = "loop_exit_file_outside";
        const loop = makeMinimalLoop(directory, loopId);
        await persistLoop(directory, loop);
        // Copy loop-record.json to a location outside the runs root
        const originalPath = join(directory, ".martin-runs", loopId, "loop-record.json");
        const outsidePath = join(directory, "exported-loop-record.json");
        const content = await readFile(originalPath, "utf8");
        await writeFile(outsidePath, content, "utf8");
        // Use --runs-dir pointing to the canonical runs root; file is outside it
        const result = await executeCli(["--json", "runs", "verify", "--file", outsidePath]);
        expect(result.exitCode).toBe(RUNS_VERIFY_UNTRUSTED_EXIT_CODE);
        const parsed = JSON.parse(result.stdout);
        // dirname(outsidePath) is the temp directory itself, not inside .martin-runs
        expect(parsed.receiptIntegrity.state).toBe("relocated");
      });
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });
});

describe("runs verify exit code contract — handoff outcome tier", () => {
  // ── Verified bytes but failed verifier ───────────────────────────────────
  // This is the core safety property: a correctly signed receipt does NOT prove
  // the work was verified.  The exit code must still be non-zero when the verifier
  // failed, so CI gates cannot confuse "bytes match signature" with "work passed".
  it("exits 7 for verified receipt + NEEDS_REVIEW outcome (verifier failed)", async () => {
    const directory = await mkdtemp(join(tmpdir(), "martin-exit-needs-review-"));
    try {
      await withIsolatedRunsEnv(directory, async () => {
        // Create a loop with verifierPassed=false — bytes will be correctly signed
        // but the verifier step recorded failure → outcome NEEDS_REVIEW
        const loopId = "loop_exit_needs_review";
        const loop = makeMinimalLoop(directory, loopId, false /* verifierPassed */);
        await persistLoop(directory, loop); // signed correctly
        const result = await executeCli(["--json", "runs", "verify", "--loop-id", loopId]);
        expect(result.exitCode).toBe(RUNS_VERIFY_NEEDS_REVIEW_EXIT_CODE);
        const parsed = JSON.parse(result.stdout);
        // Receipt bytes are intact — the receipt IS verified
        expect(parsed.receiptIntegrity.state).toBe("verified");
        // But the handoff outcome is NOT VERIFIED because the verifier failed
        expect(parsed.verifiedHandoff.outcome).not.toBe("VERIFIED");
        expect(parsed.verifiedHandoff.verification.status).not.toBe("PASSED");
      });
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  // ── Passing verifier cannot rescue untrustworthy evidence ────────────────
  // Explicit proof: even when the verifier subprocess reports passed=true,
  // exit 6 is returned and outcome is not VERIFIED when receipt is material_missing.
  it("exits 6 even when verification.status is passed — material_missing is not rescued", async () => {
    const directory = await mkdtemp(join(tmpdir(), "martin-exit-untrusted-pass-"));
    try {
      await withIsolatedRunsEnv(directory, async () => {
        const loopId = "loop_exit_untrusted_pass";
        // Loop has a passing verifier event but NO integrity sidecar
        const loop = makeMinimalLoop(directory, loopId, true /* verifierPassed */);
        await persistLoopWithoutIntegritySidecar(directory, loop);
        const result = await executeCli(["--json", "runs", "verify", "--loop-id", loopId]);
        const parsed = JSON.parse(result.stdout);
        // Verify the fixture's verifier DID report passed (the critical precondition)
        expect(parsed.verification.status).toBe("passed");
        // Despite passing verifier, exit must be 6 — integrity is untrusted
        expect(result.exitCode).toBe(RUNS_VERIFY_UNTRUSTED_EXIT_CODE);
        expect(parsed.receiptIntegrity.state).toBe("material_missing");
        // Outcome must not be VERIFIED
        expect(parsed.verifiedHandoff.outcome).not.toBe("VERIFIED");
        // Warning surface must call out the untrusted state
        expect(parsed.warnings.some((w: string) => w.includes("material_missing"))).toBe(true);
      });
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });
});

describe("martin run path scope enforcement — live and proof mode", () => {
  // Proof mode: path check blocks before any provider or loop record is created
  it("proof mode — exits non-zero and creates no loop when --allow-path escapes working directory", async () => {
    const { readdir, mkdir } = await import("node:fs/promises");
    const directory = await mkdtemp(join(tmpdir(), "martin-run-path-proof-"));
    try {
      const runsDir = join(directory, ".martin-runs");
      await mkdir(runsDir, { recursive: true });
      const prevRunsDir = process.env.MARTIN_RUNS_DIR;
      process.env.MARTIN_RUNS_DIR = runsDir;
      try {
        const result = await executeCli([
          "run", "Fix the config",
          "--engine", "claude",
          "--cwd", directory,
          "--verify", NOOP_VERIFIER,
          "--proof",
          "--allow-path", "../outside",
        ]);
        expect(result.exitCode).not.toBe(0);
        const combined = result.stdout + result.stderr;
        expect(combined).toMatch(/escapes the working directory|Governed run preflight blocked/i);
        const runsEntries = await readdir(runsDir).catch(() => [] as string[]);
        expect(runsEntries.filter((e) => e.startsWith("loop_"))).toHaveLength(0);
      } finally {
        if (prevRunsDir === undefined) delete process.env.MARTIN_RUNS_DIR;
        else process.env.MARTIN_RUNS_DIR = prevRunsDir;
      }
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  // Live mode: path check blocks before the provider adapter is invoked
  // Uses a stub adapter that records whether it was called.  If the path
  // check fires first, the stub is never reached.
  it("live mode — path check fires before provider adapter is invoked", async () => {
    const { readdir, mkdir } = await import("node:fs/promises");
    const directory = await mkdtemp(join(tmpdir(), "martin-run-path-live-"));
    try {
      let adapterCallCount = 0;
      __setRunAdapterOverrideForTests(
        createStubDirectProviderAdapter({
          providerId: "test-spy",
          model: "spy",
          responder: (request) => {
            adapterCallCount++;
            return {
              status: "completed",
              summary: "spy adapter",
              usage: { actualUsd: 0, tokensIn: 0, tokensOut: 0, provenance: "actual" },
              verification: {
                passed: true,
                summary: "spy passed",
                binding: { runId: request.loopId, attemptId: request.attemptId, workspaceId: request.workspaceId, cwd: request.context.repoRoot ?? directory, commands: ["true"] },
                steps: [{ command: "true", launched: true, completed: true, crashed: false, exitCode: 0, timedOut: false }],
              },
            } as const;
          },
        })
      );

      const runsDir = join(directory, ".martin-runs");
      await mkdir(runsDir, { recursive: true });
      const prevRunsDir = process.env.MARTIN_RUNS_DIR;
      const prevLive = process.env.MARTIN_LIVE;
      process.env.MARTIN_RUNS_DIR = runsDir;
      process.env.MARTIN_LIVE = "true";
      try {
        const result = await executeCli([
          "run", "Fix the config",
          "--engine", "claude",
          "--cwd", directory,
          "--verify", NOOP_VERIFIER,
          "--allow-path", "../outside",
        ]);
        // Path check fires before provider launch → non-zero exit
        expect(result.exitCode).not.toBe(0);
        // Stub adapter must never have been called
        expect(adapterCallCount).toBe(0);
        // No loop record created
        const runsEntries = await readdir(runsDir).catch(() => [] as string[]);
        expect(runsEntries.filter((e) => e.startsWith("loop_"))).toHaveLength(0);
      } finally {
        if (prevRunsDir === undefined) delete process.env.MARTIN_RUNS_DIR;
        else process.env.MARTIN_RUNS_DIR = prevRunsDir;
        if (prevLive === undefined) delete process.env.MARTIN_LIVE;
        else process.env.MARTIN_LIVE = prevLive;
      }
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });
});
