/**
 * Regression test for incident #125: attempt.started not persisted before provider wait.
 *
 * Root cause: `attempt.started` was appended to the in-memory loop object but
 * `persistLoopRecordIfSupported` was never called before `executingAdapter.execute()`
 * blocked. A status query issued during the provider wait read the previous persisted
 * snapshot and saw `attempts: 0` and no in-progress state, causing callers to
 * incorrectly launch a concurrent recovery run.
 *
 * Fix: persist the loop record immediately after appending `attempt.started`, before
 * calling the blocking adapter.
 *
 * This test verifies:
 * 1. The stable loop ID exists on disk before the adapter finishes.
 * 2. The persisted loop-record.json already contains an `attempt.started` event
 *    while the adapter is still blocking.
 * 3. The run is non-terminal during the provider wait (no termination envelope).
 * 4. After the adapter completes, the final persisted state reflects the real outcome.
 */

import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, expect, it } from "vitest";

import { createFileRunStore, runMartin, type MartinAdapter } from "../src/index";

// ─── helpers ──────────────────────────────────────────────────────────────────

let scratchRoot: string;
let previousRunsDir: string | undefined;
let previousGroundingDir: string | undefined;
let previousIntegrityKeyDir: string | undefined;

beforeEach(async () => {
  scratchRoot = await mkdtemp(join(tmpdir(), "martin-125-regression-"));
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

// ─── regression: attempt.started must be persisted before blocking provider ──

it("persists attempt.started state before the blocking provider call so status queries see an active attempt", async () => {
  const runsRoot = join(scratchRoot, "runs");
  await mkdir(runsRoot, { recursive: true });
  const store = createFileRunStore({ runsRoot });

  // Capture the loop ID once the run initialises it.
  let capturedLoopId: string | undefined;

  // Synchronisation: the adapter signals when it has started blocking,
  // then waits for the test to release it.
  let adapterStartedResolve!: () => void;
  let adapterReleaseResolve!: () => void;

  const adapterStarted = new Promise<void>((r) => { adapterStartedResolve = r; });
  const adapterRelease = new Promise<void>((r) => { adapterReleaseResolve = r; });

  const blockingAdapter: MartinAdapter = {
    adapterId: "direct:blocking-125",
    kind: "direct-provider",
    label: "Blocking adapter (incident-125 regression)",
    metadata: { providerId: "openai", model: "gpt-5-mini" },
    async execute() {
      // Signal that we are inside the blocking provider call.
      adapterStartedResolve();
      // Block until the test releases us.
      await adapterRelease;
      return {
        status: "completed",
        summary: "Released.",
        usage: { actualUsd: 0.01, tokensIn: 10, tokensOut: 10 },
        verification: { passed: true, summary: "pass" }
      };
    }
  };

  // Wrap the store so we can capture the loop ID from the first writeLoopRecord call.
  const trackedStore: typeof store = {
    ...store,
    async writeLoopRecord(runId, loop) {
      capturedLoopId ??= runId;
      return store.writeLoopRecord!(runId, loop);
    }
  };

  // Start the run without awaiting — it will block inside the adapter.
  const runPromise = runMartin({
    workspaceId: "ws-125",
    projectId: "proj-125",
    task: {
      title: "Regression: #125",
      objective: "Prove attempt.started is persisted before adapter blocks.",
      verificationPlan: ["echo ok"]
    },
    budget: { maxUsd: 10, softLimitUsd: 8, maxIterations: 5, maxTokens: 100_000 },
    adapter: blockingAdapter,
    store: trackedStore
  });

  // Wait until the adapter is blocking (i.e., attempt.started has been emitted
  // and — after the fix — already flushed to disk).
  await adapterStarted;

  // ── assertion window: adapter is blocking, run is in-flight ────────────────

  // The loop ID must have been assigned (stable handle exists before completion).
  expect(capturedLoopId).toBeDefined();
  const loopId = capturedLoopId!;

  // Read the persisted loop-record.json directly — this is exactly what a
  // concurrent status query would read during the provider wait window.
  const loopRecordPath = join(runsRoot, loopId, "loop-record.json");
  const raw = await readFile(loopRecordPath, "utf8").catch(() => null);

  // The file must exist — the stable run handle is already on disk.
  expect(raw, "loop-record.json must exist while adapter is blocking").not.toBeNull();

  const persisted = JSON.parse(raw!) as {
    loopId: string;
    status: string;
    lifecycleState: string;
    attempts: Array<{ attemptId?: string }>;
    events: Array<{ type: string; payload: Record<string, unknown> }>;
  };

  // The loop ID in the file matches the one we captured.
  expect(persisted.loopId).toBe(loopId);

  // While blocking: completed attempts list must be empty (attempt not yet finished).
  expect(persisted.attempts.length, "attempts list must be empty while adapter is executing").toBe(0);

  // The persisted events must already include attempt.started — this is the race fix.
  // Without the fix this snapshot lacked attempt.started, so callers saw attempts=0
  // with no in-progress signal and launched a duplicate recovery run.
  const startedEvents = persisted.events.filter((e) => e.type === "attempt.started");
  expect(startedEvents.length, "persisted events must include attempt.started before adapter completes").toBe(1);

  // The active attemptId from the event is not yet in the completed attempts list —
  // confirming the status surface correctly exposes an in-flight attempt.
  const activeAttemptId = startedEvents[0]!.payload["attemptId"] as string;
  expect(typeof activeAttemptId).toBe("string");

  // The run must not be terminal yet (status is still "running", not "completed").
  expect(persisted.status, "run status must be running during provider wait").toBe("running");

  // ── release adapter and verify final state ──────────────────────────────────

  adapterReleaseResolve();
  const finalResult = await runPromise;

  // Exact decision contract: fake adapter returns status=completed + verification.passed=true
  // with budget intact and no signals → governed exit must be status=completed.
  expect(finalResult.decision.status, "final decision.status must be completed").toBe("completed");
  expect(finalResult.decision.lifecycleState, "final lifecycleState must be completed").toBe("completed");
  // Exactly one attempt was admitted and completed.
  expect(finalResult.loop.attempts.length, "exactly one attempt must be recorded").toBe(1);

  // Verify the final persisted state is consistent with the in-memory result.
  const finalRaw = await readFile(loopRecordPath, "utf8");
  const finalPersisted = JSON.parse(finalRaw) as {
    status: string;
    lifecycleState: string;
    attempts: Array<{ attemptId?: string }>;
    events: Array<{ type: string; payload: Record<string, unknown> }>;
  };

  // The persisted status matches the in-memory decision — receipt is truthful.
  expect(finalPersisted.status, "persisted status must match decision").toBe("completed");
  expect(finalPersisted.attempts.length, "persisted attempts must record the one completed attempt").toBe(1);

  // The attempt.completed event is present — no stale active-attempt in the record.
  const completedEvents = finalPersisted.events.filter((e) => e.type === "attempt.completed");
  expect(completedEvents.length, "persisted events must include attempt.completed").toBe(1);

  // The completed attempt ID matches the one we observed as active mid-run.
  const completedAttemptId = completedEvents[0]!.payload["attemptId"] as string;
  expect(completedAttemptId, "completed attemptId must match the in-flight attemptId").toBe(activeAttemptId);

  // No stale active-attempt remains: the attempt in the events list is now
  // also in the completed attempts array, so activeAttemptId would not be exposed.
  const completedIds = new Set(finalPersisted.attempts.map((a) => a.attemptId));
  expect(completedIds.has(activeAttemptId), "in-flight attempt must appear in completed list after run ends").toBe(true);
});
