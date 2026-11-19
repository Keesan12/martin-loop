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

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, expect, it } from "vitest";

import { createFileRunStore, makeLedgerEvent, runMartin, type MartinAdapter } from "../src/index";
import {
  resolveReceiptIntegrityTransactionPath,
  verifyReceiptIntegrityFromFiles,
  writeReceiptIntegrityTransaction
} from "../src/persistence/index";
import { resolvePersistenceLeasePath } from "../src/persistence/lease.js";

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

it("checkpoints provider settlement before later lifecycle work and remains idempotent", async () => {
  const runsRoot = join(scratchRoot, "runs");
  await mkdir(runsRoot, { recursive: true });
  const store = createFileRunStore({ runsRoot });
  let checkpointReached!: () => void;
  let releaseCheckpoint!: () => void;
  const reached = new Promise<void>((resolve) => { checkpointReached = resolve; });
  const release = new Promise<void>((resolve) => { releaseCheckpoint = resolve; });
  let capturedRunId: string | undefined;
  let capturedSettlement: Parameters<NonNullable<typeof store.commitAttemptSettlement>> | undefined;

  const trackedStore: typeof store = {
    ...store,
    async commitAttemptSettlement(runId, attemptIndex, loop, artifacts, ledgerEvents) {
      capturedRunId = runId;
      capturedSettlement = [runId, attemptIndex, loop, artifacts, ledgerEvents];
      await store.commitAttemptSettlement!(runId, attemptIndex, loop, artifacts, ledgerEvents);
      await store.commitAttemptSettlement!(runId, attemptIndex, loop, artifacts, ledgerEvents);
      checkpointReached();
      await release;
    }
  };
  const adapter: MartinAdapter = {
    adapterId: "direct:settlement-checkpoint",
    kind: "direct-provider",
    label: "Settlement checkpoint adapter",
    metadata: { providerId: "openai", model: "gpt-5-mini" },
    async execute() {
      return {
        status: "completed",
        summary: "Provider settled.",
        usage: { actualUsd: 0.25, tokensIn: 10, tokensOut: 5 },
        verification: { passed: true, summary: "pass" }
      };
    }
  };

  const runPromise = runMartin({
    workspaceId: "ws-settlement",
    projectId: "proj-settlement",
    task: { title: "Checkpoint settlement", objective: "Persist provider settlement coherently.", verificationPlan: [] },
    budget: { maxUsd: 10, softLimitUsd: 8, maxIterations: 1, maxTokens: 100_000 },
    adapter,
    store: trackedStore
  });

  await reached;
  expect(capturedRunId).toBeDefined();
  const runId = capturedRunId!;
  const loopRecordPath = join(runsRoot, runId, "loop-record.json");
  const ledgerPath = join(runsRoot, runId, "ledger.jsonl");
  const persisted = JSON.parse(await readFile(loopRecordPath, "utf8")) as {
    attempts: unknown[];
    cost: { actualUsd: number };
  };
  const ledger = (await readFile(ledgerPath, "utf8"))
    .split(/\r?\n/u)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { kind: string });
  const integrity = await verifyReceiptIntegrityFromFiles({ runId, runsRoot, loopRecordPath, ledgerPath });

  expect(persisted.attempts).toHaveLength(1);
  expect(persisted.cost.actualUsd).toBe(0.25);
  expect(ledger.filter((event) => event.kind === "patch.generated")).toHaveLength(1);
  expect(ledger.filter((event) => event.kind === "budget.settled")).toHaveLength(1);
  expect(integrity.state).toBe("verified");

  releaseCheckpoint();
  await runPromise;

  expect(capturedSettlement).toBeDefined();
  const retryStore = createFileRunStore({ runsRoot });
  const finalLoopRaw = await readFile(loopRecordPath, "utf8");
  const artifactPath = join(runsRoot, runId, "artifacts", "attempt-001", "compiled-context.json");
  const finalArtifactRaw = await readFile(artifactPath, "utf8");
  await rm(artifactPath);
  await retryStore.commitAttemptSettlement!(...capturedSettlement!);
  expect(await readFile(loopRecordPath, "utf8")).toBe(finalLoopRaw);
  expect(await readFile(artifactPath, "utf8")).toBe(finalArtifactRaw);
  await writeFile(artifactPath, "newer verification-owned artifact\n", "utf8");
  await retryStore.commitAttemptSettlement!(...capturedSettlement!);
  expect(await readFile(artifactPath, "utf8")).toBe("newer verification-owned artifact\n");
  await expect(verifyReceiptIntegrityFromFiles({ runId, runsRoot, loopRecordPath, ledgerPath }))
    .resolves.toMatchObject({ state: "verified" });
});

it("recovers an authenticated partial checkpoint and rejects a forged journal", async () => {
  const runsRoot = join(scratchRoot, "runs");
  await mkdir(runsRoot, { recursive: true });
  const store = createFileRunStore({ runsRoot });
  const adapter: MartinAdapter = {
    adapterId: "direct:transaction-recovery",
    kind: "direct-provider",
    label: "Transaction recovery adapter",
    metadata: { providerId: "openai", model: "gpt-5-mini" },
    async execute() {
      return {
        status: "completed",
        summary: "done",
        usage: { actualUsd: 0.1, tokensIn: 1, tokensOut: 1 },
        verification: { passed: true, summary: "pass" }
      };
    }
  };
  const result = await runMartin({
    workspaceId: "ws-recovery",
    projectId: "proj-recovery",
    task: { title: "Recover checkpoint", objective: "Recover a partial durable transaction.", verificationPlan: [] },
    budget: { maxUsd: 1, softLimitUsd: 1, maxIterations: 1, maxTokens: 1_000 },
    adapter,
    store
  });
  const runId = result.loop.loopId;
  const loopRecordPath = join(runsRoot, runId, "loop-record.json");
  const ledgerPath = join(runsRoot, runId, "ledger.jsonl");
  const ledgerEntries = (await readFile(ledgerPath, "utf8"))
    .split(/\r?\n/u)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const targetLoop = { ...result.loop, updatedAt: "2026-11-11T23:59:00.000Z" };
  const targetLedger = [
    ...ledgerEntries,
    makeLedgerEvent({ kind: "run.diagnostic", runId, payload: { recovered: true } })
  ];
  await writeReceiptIntegrityTransaction({
    runId,
    runsRoot,
    targetLoopRecord: targetLoop,
    targetLedgerEntries: targetLedger,
    createdAt: targetLoop.updatedAt
  });
  await writeFile(ledgerPath, `${targetLedger.map((event) => JSON.stringify(event)).join("\n")}\n`, "utf8");
  const [recovered] = await Promise.all([
    verifyReceiptIntegrityFromFiles({ runId, runsRoot, loopRecordPath, ledgerPath }),
    store.appendLedger(
      runId,
      makeLedgerEvent({ kind: "run.diagnostic", runId, payload: { queuedAfterRecovery: true } })
    )
  ]);
  expect(recovered.state).toBe("verified");
  expect(JSON.parse(await readFile(loopRecordPath, "utf8")).updatedAt).toBe(targetLoop.updatedAt);
  expect(await readFile(ledgerPath, "utf8")).toContain('"queuedAfterRecovery":true');

  const forgedTarget = { ...targetLoop, updatedAt: "2026-11-12T00:00:00.000Z" };
  const validLoopRaw = await readFile(loopRecordPath, "utf8");
  await writeFile(loopRecordPath, "{}\n", "utf8");
  await expect(writeReceiptIntegrityTransaction({
    runId,
    runsRoot,
    targetLoopRecord: forgedTarget,
    targetLedgerEntries: targetLedger,
    createdAt: forgedTarget.updatedAt
  })).rejects.toThrow(/receipt_transaction_base_untrusted:tamper_detected/u);
  await writeFile(loopRecordPath, validLoopRaw, "utf8");

  await writeReceiptIntegrityTransaction({
    runId,
    runsRoot,
    targetLoopRecord: forgedTarget,
    targetLedgerEntries: targetLedger,
    createdAt: forgedTarget.updatedAt
  });
  const transactionPath = resolveReceiptIntegrityTransactionPath(runsRoot, runId);
  const forged = JSON.parse(await readFile(transactionPath, "utf8"));
  forged.signatureHmacSha256 = "0".repeat(64);
  await writeFile(transactionPath, `${JSON.stringify(forged, null, 2)}\n`, "utf8");

  const rejected = await verifyReceiptIntegrityFromFiles({ runId, runsRoot, loopRecordPath, ledgerPath });
  expect(rejected).toMatchObject({ state: "tamper_detected", reason: "receipt_transaction_signature_mismatch" });
});

it("serializes two independent file stores without losing concurrent ledger events", async () => {
  const runsRoot = join(scratchRoot, "runs");
  await mkdir(runsRoot, { recursive: true });
  const firstStore = createFileRunStore({ runsRoot });
  const secondStore = createFileRunStore({ runsRoot });
  const adapter: MartinAdapter = {
    adapterId: "direct:two-store-race",
    kind: "direct-provider",
    label: "Two-store race adapter",
    metadata: { providerId: "openai", model: "gpt-5-mini" },
    async execute() {
      return {
        status: "completed",
        summary: "done",
        usage: { actualUsd: 0.1, tokensIn: 1, tokensOut: 1 },
        verification: { passed: true, summary: "pass" }
      };
    }
  };
  const result = await runMartin({
    workspaceId: "ws-race",
    projectId: "proj-race",
    task: { title: "Serialize writers", objective: "Preserve both concurrent events.", verificationPlan: [] },
    budget: { maxUsd: 1, softLimitUsd: 1, maxIterations: 1, maxTokens: 1_000 },
    adapter,
    store: firstStore
  });
  const runId = result.loop.loopId;
  const staleLockPath = resolvePersistenceLeasePath(runsRoot, runId);
  await writeFile(staleLockPath, `${JSON.stringify({
    type: "acquire",
    token: "dead-owner",
    pid: 999_999,
    acquiredAt: "2020-01-01T00:00:00.000Z"
  })}\n`, "utf8");
  await Promise.all([
    firstStore.appendLedger(runId, makeLedgerEvent({ kind: "run.diagnostic", runId, payload: { writer: "first" } })),
    secondStore.appendLedger(runId, makeLedgerEvent({ kind: "run.diagnostic", runId, payload: { writer: "second" } }))
  ]);

  const loopRecordPath = join(runsRoot, runId, "loop-record.json");
  const ledgerPath = join(runsRoot, runId, "ledger.jsonl");
  const ledgerRaw = await readFile(ledgerPath, "utf8");
  expect(ledgerRaw.match(/"writer":"first"/gu)).toHaveLength(1);
  expect(ledgerRaw.match(/"writer":"second"/gu)).toHaveLength(1);
  await expect(verifyReceiptIntegrityFromFiles({ runId, runsRoot, loopRecordPath, ledgerPath }))
    .resolves.toMatchObject({ state: "verified" });
});
