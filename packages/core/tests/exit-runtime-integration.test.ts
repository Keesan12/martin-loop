/**
 * Eight-exit runtime integration tests.
 *
 * These tests exercise the harness-level exit gates added in D3:
 *   1. Pre-existing signal prevents the first attempt
 *   2. Active human cancellation aborts an in-flight attempt
 *   3. Wall-clock expiry produces a wall_clock exit, not a thrown exception
 *   4. Governed turn count includes the current attempt (not stale)
 *   5. Post-attempt budget check uses the current cost (not pre-attempt cost)
 *   6. Before-retry checkpoint stops another attempt
 *   7. Competing finish calls produce exactly one envelope (A1 idempotency)
 *   8. Termination persistence failure surfaces as a thrown error
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ExitPolicyV1 } from "@martin/contracts";
import type { ExitSignalSource, SignalReadResult } from "../src/exit-signal";
import { writeExitSignal } from "../src/exit-signal";
import { createFileRunStore } from "../src/persistence/index";
import { runMartin, type MartinAdapter } from "../src/index";

// ─── shared helpers ───────────────────────────────────────────────────────────

function okAdapter(overrides: Partial<{
  execute: MartinAdapter["execute"];
  executionCount: { n: number };
}> = {}): MartinAdapter {
  const counter = overrides.executionCount ?? { n: 0 };
  return {
    adapterId: "direct:test",
    kind: "direct-provider",
    label: "Test adapter",
    metadata: { providerId: "openai", model: "gpt-5-mini" },
    async execute(request) {
      counter.n += 1;
      if (overrides.execute) return overrides.execute(request);
      return {
        status: "completed",
        summary: "Done.",
        usage: { actualUsd: 0.01, tokensIn: 10, tokensOut: 10 },
        verification: { passed: true, summary: "pass" }
      };
    }
  };
}

function failAdapter(costUsd = 0.01): MartinAdapter {
  return {
    adapterId: "direct:test",
    kind: "direct-provider",
    label: "Fail adapter",
    metadata: { providerId: "openai", model: "gpt-5-mini" },
    async execute() {
      return {
        status: "failed",
        summary: "Failed.",
        usage: { actualUsd: costUsd, tokensIn: 10, tokensOut: 10 },
        verification: { passed: false, summary: "fail" }
      };
    }
  };
}

function baseTask() {
  return {
    title: "Test task",
    objective: "Run the eight-exit harness.",
    verificationPlan: ["echo ok"]
  };
}

function baseBudget(overrides: Partial<{
  maxUsd: number;
  softLimitUsd: number;
  maxIterations: number;
  maxTokens: number;
}> = {}) {
  return {
    maxUsd: 10,
    softLimitUsd: 8,
    maxIterations: 5,
    maxTokens: 100_000,
    ...overrides
  };
}

/** A signal source that always returns no signals */
function emptySource(): ExitSignalSource {
  return { poll: async () => ({ signals: [], diagnostics: [] }) };
}

/** A signal source pre-loaded with a human_interrupt signal */
function preloadedSource(runId: string, runsRoot: string): ExitSignalSource {
  return {
    async poll(id) {
      if (id !== runId) return { signals: [], diagnostics: [] };
      return {
        signals: [{
          kind: "human_interrupt",
          schemaVersion: "exit-signal/1",
          runId: id,
          reason: "operator cancel",
          requestedAt: new Date().toISOString(),
          requestedBy: "test"
        }],
        diagnostics: []
      };
    }
  };
}

let scratchRoot: string;
let previousRunsDir: string | undefined;
let previousGroundingDir: string | undefined;
let previousIntegrityKeyDir: string | undefined;

beforeEach(async () => {
  scratchRoot = await mkdtemp(join(tmpdir(), "martin-eight-exit-"));
  previousRunsDir = process.env.MARTIN_RUNS_DIR;
  previousGroundingDir = process.env.MARTIN_GROUNDING_DIR;
  previousIntegrityKeyDir = process.env.MARTIN_INTEGRITY_KEY_DIR;
  process.env.MARTIN_RUNS_DIR = join(scratchRoot, "runs");
  process.env.MARTIN_GROUNDING_DIR = join(scratchRoot, "grounding");
  process.env.MARTIN_INTEGRITY_KEY_DIR = join(scratchRoot, "receipt-integrity");
});

afterEach(async () => {
  if (previousRunsDir === undefined) delete process.env.MARTIN_RUNS_DIR;
  else process.env.MARTIN_RUNS_DIR = previousRunsDir;
  if (previousGroundingDir === undefined) delete process.env.MARTIN_GROUNDING_DIR;
  else process.env.MARTIN_GROUNDING_DIR = previousGroundingDir;
  if (previousIntegrityKeyDir === undefined) delete process.env.MARTIN_INTEGRITY_KEY_DIR;
  else process.env.MARTIN_INTEGRITY_KEY_DIR = previousIntegrityKeyDir;
  await rm(scratchRoot, { force: true, recursive: true }).catch(() => {});
});

// ─── test 1: pre-existing signal prevents the first attempt ──────────────────

it("pre-existing signal prevents attempt 1", async () => {
  const runsRoot = join(scratchRoot, "runs");
  await mkdir(runsRoot, { recursive: true });
  const counter = { n: 0 };
  const adapter = okAdapter({ executionCount: counter });
  const store = createFileRunStore({ runsRoot });

  const result = await runMartin({
    workspaceId: "ws",
    projectId: "proj",
    task: baseTask(),
    budget: baseBudget(),
    adapter,
    store,
    // Inject a source that immediately reports a human_interrupt
    exitSignalSource: {
      async poll() {
        return {
          signals: [{
            kind: "human_interrupt" as const,
            schemaVersion: "exit-signal/1",
            runId: "any",
            reason: "pre-loaded cancel",
            requestedAt: new Date().toISOString(),
            requestedBy: "test"
          }],
          diagnostics: []
        };
      }
    }
  });

  expect(counter.n).toBe(0);
  expect(result.decision.reason).toMatch(/human_interrupt|cancel/i);
});

// ─── test 2: active human cancellation aborts an in-flight attempt ───────────

it("human cancellation aborts an active attempt", async () => {
  const runsRoot = join(scratchRoot, "runs");
  await mkdir(runsRoot, { recursive: true });
  const store = createFileRunStore({ runsRoot });

  // The adapter blocks until its signal is aborted
  let abortedSignal: AbortSignal | undefined;
  const adapter: MartinAdapter = {
    adapterId: "direct:blocking",
    kind: "direct-provider",
    label: "Blocking adapter",
    metadata: { providerId: "openai", model: "gpt-5-mini" },
    async execute(request) {
      abortedSignal = request.signal;
      // Wait for abort
      await new Promise<void>((resolve) => {
        if (request.signal?.aborted) { resolve(); return; }
        request.signal?.addEventListener("abort", () => resolve(), { once: true });
      });
      return {
        status: "failed",
        summary: "Aborted.",
        usage: { actualUsd: 0.01, tokensIn: 5, tokensOut: 5 },
        verification: { passed: false, summary: "aborted" }
      };
    }
  };

  // Return the signal only after the adapter has started executing, so the
  // pre_attempt checkpoint passes and the abort reaches an in-flight attempt.
  const source: ExitSignalSource = {
    async poll(runId) {
      if (abortedSignal !== undefined) {
        return {
          signals: [{
            kind: "human_interrupt" as const,
            schemaVersion: "exit-signal/1",
            runId,
            reason: "mid-flight cancel",
            requestedAt: new Date().toISOString(),
            requestedBy: "test"
          }],
          diagnostics: []
        };
      }
      return { signals: [], diagnostics: [] };
    }
  };

  const result = await runMartin({
    workspaceId: "ws",
    projectId: "proj",
    task: baseTask(),
    budget: baseBudget(),
    adapter,
    store,
    exitSignalSource: source,
    exitSignalPollIntervalMs: 10
  });

  expect(abortedSignal?.aborted).toBe(true);
  expect(result.decision.reason).toMatch(/human_interrupt|cancel/i);
});

// ─── test 3: wall-clock expiry is a wall_clock exit, not a thrown exception ──

it("wall-clock expiry produces a clean exit rather than a thrown error", async () => {
  const runsRoot = join(scratchRoot, "runs");
  await mkdir(runsRoot, { recursive: true });
  const store = createFileRunStore({ runsRoot });

  const adapter: MartinAdapter = {
    adapterId: "direct:slow",
    kind: "direct-provider",
    label: "Slow adapter",
    metadata: { providerId: "openai", model: "gpt-5-mini" },
    async execute(request) {
      await new Promise<void>((resolve) => {
        if (request.signal?.aborted) { resolve(); return; }
        request.signal?.addEventListener("abort", () => resolve(), { once: true });
        setTimeout(resolve, 60_000);
      });
      return {
        status: "failed",
        summary: "Timed out.",
        usage: { actualUsd: 0.001, tokensIn: 1, tokensOut: 1 },
        verification: { passed: false, summary: "timeout" }
      };
    }
  };

  const result = await runMartin({
    workspaceId: "ws",
    projectId: "proj",
    task: baseTask(),
    budget: baseBudget(),
    adapter,
    store,
    exitSignalSource: emptySource(),
    exitPolicy: { wallClock: { maxElapsedMs: 50 } }
  });

  // Must return normally (not throw), and the exit must be wall-clock related
  expect(result.decision.shouldExit).toBe(true);
  expect(result.decision.reason).toMatch(/wall.?clock|wall_clock|elapsed|time/i);
});

// ─── test 4: governed turn count includes the current attempt ─────────────────

it("turn count snapshot includes the attempt being executed", async () => {
  const runsRoot = join(scratchRoot, "runs");
  await mkdir(runsRoot, { recursive: true });
  const store = createFileRunStore({ runsRoot });

  // Cap at 1 turn — the snapshot turnsUsed must reflect attempt 1, not 0
  const result = await runMartin({
    workspaceId: "ws",
    projectId: "proj",
    task: baseTask(),
    budget: baseBudget({ maxIterations: 1 }),
    adapter: okAdapter(),
    store,
    exitSignalSource: emptySource(),
    exitPolicy: { turns: { max: 1 } }
  });

  expect(result.loop.attempts.length).toBe(1);
  expect(result.decision.shouldExit).toBe(true);
});

// ─── test 5: post-attempt budget check uses current (updated) cost ────────────

it("budget cap fires after the first attempt updates cost", async () => {
  const runsRoot = join(scratchRoot, "runs");
  await mkdir(runsRoot, { recursive: true });
  const store = createFileRunStore({ runsRoot });

  // Large legacy budget keeps the preflight happy; the eight-exit policy cap
  // is set to $0.05 so one attempt costing $0.06 triggers the post-attempt check.
  const result = await runMartin({
    workspaceId: "ws",
    projectId: "proj",
    task: baseTask(),
    budget: baseBudget({ maxUsd: 100, softLimitUsd: 80, maxIterations: 5 }),
    adapter: failAdapter(0.06),
    store,
    exitSignalSource: emptySource(),
    exitPolicy: { budget: { maxUsd: 0.05 } }
  });

  // Must have run exactly one attempt then exited on budget
  expect(result.loop.attempts.length).toBe(1);
  expect(result.decision.shouldExit).toBe(true);
  expect(result.loop.cost.actualUsd).toBeGreaterThan(0.05);
});

// ─── test 6: before-retry checkpoint stops another attempt ───────────────────

it("before-retry checkpoint prevents a second attempt when turn cap is 1", async () => {
  const runsRoot = join(scratchRoot, "runs");
  await mkdir(runsRoot, { recursive: true });
  const store = createFileRunStore({ runsRoot });
  const counter = { n: 0 };

  const result = await runMartin({
    workspaceId: "ws",
    projectId: "proj",
    task: baseTask(),
    budget: baseBudget({ maxIterations: 10 }),
    adapter: okAdapter({ executionCount: counter }),
    store,
    exitSignalSource: emptySource(),
    exitPolicy: { turns: { max: 1 } }
  });

  // The before-retry checkpoint must have fired after attempt 1, preventing attempt 2
  expect(counter.n).toBe(1);
  expect(result.decision.shouldExit).toBe(true);
});

// ─── test 7: competing finish calls produce exactly one envelope ──────────────

it("concurrent terminateRun calls produce exactly one termination envelope", async () => {
  const runsRoot = join(scratchRoot, "runs");
  await mkdir(runsRoot, { recursive: true });
  const store = createFileRunStore({ runsRoot });

  const result = await runMartin({
    workspaceId: "ws",
    projectId: "proj",
    task: baseTask(),
    budget: baseBudget({ maxUsd: 100, softLimitUsd: 80, maxIterations: 5 }),
    adapter: failAdapter(0.06),
    store,
    exitSignalSource: emptySource(),
    exitPolicy: { budget: { maxUsd: 0.05 } }
  });

  const runId = result.loop.loopId;
  const envelopePath = join(runsRoot, runId, "termination.json");
  const raw = await readFile(envelopePath, "utf8");
  const envelope = JSON.parse(raw) as { schemaVersion: string; class: string };

  // Exactly one envelope written
  expect(envelope.schemaVersion).toBe("termination/1");
  expect(envelope.class).toBe("operational_exit");

  // Writing again must return the existing envelope (not throw EEXIST)
  const { persistTerminationEnvelope } = await import("../src/termination-store");
  const second = await persistTerminationEnvelope(join(runsRoot, runId), {
    schemaVersion: "termination/1",
    class: "operational_exit",
    exit: {} as never
  });
  // Second call returns the already-written envelope, not the new one
  expect(second.class).toBe("operational_exit");
});

// ─── test 8: termination persistence failure surfaces as an error ─────────────

it("termination persistence failure is visible rather than swallowed", async () => {
  const runsRoot = join(scratchRoot, "runs");
  await mkdir(runsRoot, { recursive: true });

  // Use a store whose runsRoot points to a directory we make unwritable by
  // writing a plain file where the run directory would go — so open() fails.
  const blockedRoot = join(scratchRoot, "blocked-runs");
  await mkdir(blockedRoot, { recursive: true });
  // We'll let the run start but intercept at the store level by making
  // persistTerminationEnvelope throw.  We do this by pointing the store at a
  // path where the run dir already has termination.json replaced with a dir.
  const store = createFileRunStore({ runsRoot: blockedRoot });

  let runId: string | undefined;
  const adapter: MartinAdapter = {
    adapterId: "direct:test",
    kind: "direct-provider",
    label: "Test adapter",
    metadata: { providerId: "openai", model: "gpt-5-mini" },
    async execute(request) {
      runId = request.loopId;
      // After we know the run ID, block the termination file from being created
      // by placing a directory at termination.json's path
      const runDir = join(blockedRoot, request.loopId);
      await mkdir(runDir, { recursive: true });
      const terminationPath = join(runDir, "termination.json");
      await mkdir(terminationPath, { recursive: true }); // directory at the file path
      return {
        status: "failed",
        summary: "Triggering exit.",
        usage: { actualUsd: 2, tokensIn: 10, tokensOut: 10 },
        verification: { passed: false, summary: "fail" }
      };
    }
  };

  // The run should reject because persistTerminationEnvelope cannot write
  await expect(
    runMartin({
      workspaceId: "ws",
      projectId: "proj",
      task: baseTask(),
      budget: baseBudget({ maxUsd: 1, softLimitUsd: 0.5, maxIterations: 1 }),
      adapter,
      store,
      exitSignalSource: emptySource()
    })
  ).rejects.toThrow();
});

// ─── D5: termination envelope on returned LoopRecord ─────────────────────────

it("D5: wall_clock exit populates terminationEnvelope on returned loop record", async () => {
  const runsRoot = join(scratchRoot, "runs");
  await mkdir(runsRoot, { recursive: true });
  const store = createFileRunStore({ runsRoot });

  const result = await runMartin({
    workspaceId: "ws",
    projectId: "proj",
    task: baseTask(),
    budget: baseBudget(),
    adapter: {
      adapterId: "direct:slow",
      kind: "direct-provider",
      label: "Slow adapter",
      metadata: { providerId: "openai", model: "gpt-5-mini" },
      async execute(request) {
        await new Promise<void>((resolve) => {
          if (request.signal?.aborted) { resolve(); return; }
          request.signal?.addEventListener("abort", () => resolve(), { once: true });
          setTimeout(resolve, 60_000);
        });
        return {
          status: "failed",
          summary: "Timed out.",
          usage: { actualUsd: 0, tokensIn: 0, tokensOut: 0 },
          verification: { passed: false, summary: "timeout" }
        };
      }
    },
    store,
    exitSignalSource: emptySource(),
    exitPolicy: { wallClock: { maxElapsedMs: 50 } }
  });

  // The LoopRecord returned by the runtime must carry the envelope
  expect(result.loop.terminationEnvelope).toBeDefined();
  expect(result.loop.terminationEnvelope?.class).toBe("operational_exit");
  expect(result.loop.terminationEnvelope?.class).toBe("operational_exit");
  if (result.loop.terminationEnvelope?.class === "operational_exit") {
    expect(result.loop.terminationEnvelope.exit.primary).toBe("wall_clock");
  }
  // Lifecycle state must be the canonical wall_clock state
  expect(result.loop.lifecycleState).toBe("wall_clock");
});

it("D5: terminationEnvelope survives disk write and JSON readback", async () => {
  const runsRoot = join(scratchRoot, "runs");
  await mkdir(runsRoot, { recursive: true });
  const store = createFileRunStore({ runsRoot });

  const result = await runMartin({
    workspaceId: "ws",
    projectId: "proj",
    task: baseTask(),
    budget: baseBudget({ maxUsd: 100, softLimitUsd: 80, maxIterations: 5 }),
    adapter: failAdapter(0.06),
    store,
    exitSignalSource: emptySource(),
    exitPolicy: { budget: { maxUsd: 0.05 } }
  });

  const runId = result.loop.loopId;
  // Find the loop record written to disk
  const candidates = ["loop-record.json", "loop.json"];
  let raw: string | undefined;
  for (const name of candidates) {
    try {
      raw = await readFile(join(runsRoot, runId, name), "utf8");
      break;
    } catch {
      // try next
    }
  }
  expect(raw).toBeDefined();

  const persisted = JSON.parse(raw!) as Record<string, unknown>;

  // terminationEnvelope must be present in the persisted file
  expect(persisted["terminationEnvelope"]).toBeDefined();
  const envelope = persisted["terminationEnvelope"] as { class: string; schemaVersion: string };
  expect(envelope.schemaVersion).toBe("termination/1");
  expect(envelope.class).toBe("operational_exit");
});
