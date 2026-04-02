import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  compileAndPersistContext,
  createFileRunStore,
  makeLedgerEvent,
  resolveRunsRoot
} from "../src/index.js";

describe("makeLedgerEvent", () => {
  it("produces a well-formed LedgerEvent with all required fields", () => {
    const event = makeLedgerEvent({
      kind: "contract.created",
      runId: "run_abc",
      payload: { workspaceId: "ws_1" },
      timestamp: "2026-04-01T00:00:00.000Z"
    });

    expect(event.kind).toBe("contract.created");
    expect(event.runId).toBe("run_abc");
    expect(event.timestamp).toBe("2026-04-01T00:00:00.000Z");
    expect(event.payload.workspaceId).toBe("ws_1");
  });

  it("uses current time when no timestamp provided", () => {
    const before = Date.now();
    const event = makeLedgerEvent({
      kind: "run.exited",
      runId: "run_xyz",
      payload: { status: "exited" }
    });
    const after = Date.now();

    const eventTime = new Date(event.timestamp).getTime();
    expect(eventTime).toBeGreaterThanOrEqual(before);
    expect(eventTime).toBeLessThanOrEqual(after);
  });
});

describe("FileRunStore", () => {
  it("writes contract.json on initRun and it is readable", async () => {
    const runsRoot = await mkdtemp(join(tmpdir(), "martin-store-"));
    const store = createFileRunStore({ runsRoot });

    await store.initRun({
      runId: "run_test_001",
      workspaceId: "ws_test",
      projectId: "proj_test",
      task: {
        title: "Test run",
        objective: "Verify persistence.",
        verificationPlan: ["pnpm test"]
      },
      budget: { maxUsd: 5, softLimitUsd: 3, maxIterations: 3, maxTokens: 10000 },
      createdAt: "2026-04-01T00:00:00.000Z"
    });

    const contract = JSON.parse(
      await readFile(join(runsRoot, "run_test_001", "contract.json"), "utf8")
    );
    expect(contract.runId).toBe("run_test_001");
    expect(contract.task.title).toBe("Test run");
  });

  it("appends to ledger.jsonl and each line is valid JSON", async () => {
    const runsRoot = await mkdtemp(join(tmpdir(), "martin-ledger-"));
    const store = createFileRunStore({ runsRoot });

    await store.initRun({
      runId: "run_ledger_001",
      workspaceId: "ws_l",
      projectId: "proj_l",
      task: { title: "T", objective: "O", verificationPlan: [] },
      budget: { maxUsd: 1, softLimitUsd: 0.5, maxIterations: 1, maxTokens: 1000 },
      createdAt: "2026-04-01T00:00:00.000Z"
    });

    const event1 = makeLedgerEvent({
      kind: "attempt.admitted",
      runId: "run_ledger_001",
      attemptIndex: 1,
      payload: { attemptId: "att_1" },
      timestamp: "2026-04-01T00:01:00.000Z"
    });
    const event2 = makeLedgerEvent({
      kind: "run.exited",
      runId: "run_ledger_001",
      payload: { status: "completed" },
      timestamp: "2026-04-01T00:02:00.000Z"
    });

    await store.appendLedger("run_ledger_001", event1);
    await store.appendLedger("run_ledger_001", event2);

    const ledger = await readFile(
      join(runsRoot, "run_ledger_001", "ledger.jsonl"),
      "utf8"
    );
    const lines = ledger.trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0] ?? "{}").kind).toBe("attempt.admitted");
    expect(JSON.parse(lines[1] ?? "{}").kind).toBe("run.exited");
  });

  it("writes compiled-context.json to the attempt artifact directory", async () => {
    const runsRoot = await mkdtemp(join(tmpdir(), "martin-artifact-"));
    const store = createFileRunStore({ runsRoot });

    await store.initRun({
      runId: "run_art_001",
      workspaceId: "ws_a",
      projectId: "proj_a",
      task: { title: "T", objective: "O", verificationPlan: [] },
      budget: { maxUsd: 1, softLimitUsd: 0.5, maxIterations: 1, maxTokens: 1000 },
      createdAt: "2026-04-01T00:00:00.000Z"
    });

    await store.writeAttemptArtifacts("run_art_001", 1, {
      compiledContext: { test: "compiled_packet" },
      diff: "--- a/foo.ts\n+++ b/foo.ts\n@@ -1 +1 @@\n-old\n+new"
    });

    const compiledCtx = JSON.parse(
      await readFile(
        join(runsRoot, "run_art_001", "artifacts", "attempt-001", "compiled-context.json"),
        "utf8"
      )
    );
    const diff = await readFile(
      join(runsRoot, "run_art_001", "artifacts", "attempt-001", "diff.patch"),
      "utf8"
    );

    expect(compiledCtx.test).toBe("compiled_packet");
    expect(diff).toContain("-old");
  });
});

describe("compileAndPersistContext", () => {
  it("returns a PromptPacket and writes compiled-context.json when store is provided", async () => {
    const runsRoot = await mkdtemp(join(tmpdir(), "martin-compiler-"));
    const store = createFileRunStore({ runsRoot });

    await store.initRun({
      runId: "run_compile_001",
      workspaceId: "ws_c",
      projectId: "proj_c",
      task: { title: "T", objective: "O", verificationPlan: [] },
      budget: { maxUsd: 1, softLimitUsd: 0.5, maxIterations: 1, maxTokens: 1000 },
      createdAt: "2026-04-01T00:00:00.000Z"
    });

    const result = await compileAndPersistContext(
      {
        loopId: "run_compile_001",
        attemptId: "att_1",
        context: {
          taskTitle: "Fix the bug",
          objective: "Fix the runtime adapter.",
          verificationPlan: ["pnpm test"],
          allowedPaths: ["packages/core/**"],
          focus: "Fix the adapter.",
          remainingBudgetUsd: 3,
          remainingIterations: 2,
          remainingTokens: 5000
        },
        previousAttempts: []
      },
      { attemptIndex: 1, store, now: "2026-04-01T00:00:00.000Z" }
    );

    expect(result.packet.attemptNumber).toBe(1);
    expect(result.packet.contract.allowedPaths).toEqual(["packages/core/**"]);

    // compiled-context.json written to disk
    const ctx = JSON.parse(
      await readFile(
        join(runsRoot, "run_compile_001", "artifacts", "attempt-001", "compiled-context.json"),
        "utf8"
      )
    );
    expect(ctx.attemptNumber).toBe(1);

    // prompt.compiled ledger event appended
    const ledger = await readFile(
      join(runsRoot, "run_compile_001", "ledger.jsonl"),
      "utf8"
    );
    expect(ledger).toContain('"prompt.compiled"');
  });

  it("returns packet without writing to disk when no store is provided", async () => {
    const result = await compileAndPersistContext(
      {
        loopId: "run_nostore",
        attemptId: "att_1",
        context: {
          taskTitle: "T",
          objective: "O.",
          verificationPlan: [],
          focus: "Fix it.",
          remainingBudgetUsd: 5,
          remainingIterations: 3,
          remainingTokens: 10000
        },
        previousAttempts: []
      },
      { attemptIndex: 1 }
    );

    expect(result.packet).toBeDefined();
    expect(result.packet.attemptNumber).toBe(1);
    // No store — no side effects, no error
  });
});
