import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  compileAndPersistContext,
  createFileRunStore,
  makeLedgerEvent,
  resolveRunsRoot,
  resolveReceiptIntegrityPath,
  verifyReceiptIntegrityFromFiles,
  writeReceiptIntegrityMaterial
} from "../src/index";

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

  it("writes leash.json when leash artifacts are provided for an attempt", async () => {
    const runsRoot = await mkdtemp(join(tmpdir(), "martin-artifact-leash-"));
    const store = createFileRunStore({ runsRoot });

    await store.initRun({
      runId: "run_art_leash_001",
      workspaceId: "ws_a",
      projectId: "proj_a",
      task: { title: "T", objective: "O", verificationPlan: [] },
      budget: { maxUsd: 1, softLimitUsd: 0.5, maxIterations: 1, maxTokens: 1000 },
      createdAt: "2026-04-01T00:00:00.000Z"
    });

    await store.writeAttemptArtifacts("run_art_leash_001", 1, {
      compiledContext: { test: "compiled_packet" },
      leash: {
        surface: "dependency",
        blocked: true,
        profile: "strict_local",
        violations: [
          {
            kind: "dependency_approval_required",
            file: "package.json"
          }
        ]
      }
    });

    const leash = JSON.parse(
      await readFile(
        join(runsRoot, "run_art_leash_001", "artifacts", "attempt-001", "leash.json"),
        "utf8"
      )
    );

    expect(leash.surface).toBe("dependency");
    expect(leash.profile).toBe("strict_local");
    expect(leash.violations[0]?.kind).toBe("dependency_approval_required");
  });

  it("writes patch-score.json and patch-decision.json when patch truth artifacts are provided", async () => {
    const runsRoot = await mkdtemp(join(tmpdir(), "martin-artifact-patch-"));
    const store = createFileRunStore({ runsRoot });

    await store.initRun({
      runId: "run_art_patch_001",
      workspaceId: "ws_a",
      projectId: "proj_a",
      task: { title: "T", objective: "O", verificationPlan: [] },
      budget: { maxUsd: 1, softLimitUsd: 0.5, maxIterations: 1, maxTokens: 1000 },
      createdAt: "2026-04-01T00:00:00.000Z"
    });

    await store.writeAttemptArtifacts("run_art_patch_001", 1, {
      compiledContext: { test: "compiled_packet" },
      patchScore: {
        score: 0.91,
        verifierScore: 1,
        verifierDelta: 0.8,
        groundingViolationCount: 0,
        scopeViolationCount: 0,
        safetyViolationCount: 0,
        changedFileCount: 1,
        diffRiskScore: 0.1,
        noveltyScore: 0.9,
        costUsd: 0.24,
        reasonCodes: ["verifier_passed"]
      },
      patchDecision: {
        decision: "KEEP",
        summary: "Verifier passed with grounded, scope-compliant changes.",
        reasonCodes: ["verifier_passed"]
      }
    });

    const patchScore = JSON.parse(
      await readFile(
        join(runsRoot, "run_art_patch_001", "artifacts", "attempt-001", "patch-score.json"),
        "utf8"
      )
    );
    const patchDecision = JSON.parse(
      await readFile(
        join(runsRoot, "run_art_patch_001", "artifacts", "attempt-001", "patch-decision.json"),
        "utf8"
      )
    );

    expect(patchScore.score).toBe(0.91);
    expect(patchScore.reasonCodes).toContain("verifier_passed");
    expect(patchDecision.decision).toBe("KEEP");
    expect(patchDecision.reasonCodes).toContain("verifier_passed");
  });

  it("writes rollback-boundary.json and rollback-outcome.json when rollback artifacts are provided", async () => {
    const runsRoot = await mkdtemp(join(tmpdir(), "martin-artifact-rollback-"));
    const store = createFileRunStore({ runsRoot });

    await store.initRun({
      runId: "run_art_rollback_001",
      workspaceId: "ws_a",
      projectId: "proj_a",
      task: { title: "T", objective: "O", verificationPlan: [] },
      budget: { maxUsd: 1, softLimitUsd: 0.5, maxIterations: 1, maxTokens: 1000 },
      createdAt: "2026-04-01T00:00:00.000Z"
    });

    await store.writeAttemptArtifacts("run_art_rollback_001", 1, {
      compiledContext: { test: "compiled_packet" },
      rollbackBoundary: {
        strategy: "git_head_plus_snapshot",
        capturedAt: "2026-04-03T17:30:00.000Z",
        headRef: "abc123",
        trackedDirtyFiles: ["src/real.ts"],
        untrackedFiles: ["notes.md"],
        snapshots: [
          {
            path: "src/real.ts",
            existed: true,
            encoding: "base64",
            contentBase64: "ZXhwb3J0IGNvbnN0IHJlYWwgPSAyOwo="
          }
        ]
      },
      rollbackOutcome: {
        attempted: true,
        status: "restored",
        restoredAt: "2026-04-03T17:30:02.000Z",
        decision: "DISCARD",
        before: {
          trackedDirtyFiles: ["src/real.ts", "src/ghost-new-file.ts"],
          untrackedFiles: ["notes.md", "src/ghost-new-file.ts"]
        },
        after: {
          trackedDirtyFiles: ["src/real.ts"],
          untrackedFiles: ["notes.md"]
        },
        restoredFiles: ["src/real.ts"],
        deletedFiles: ["src/ghost-new-file.ts"]
      }
    });

    const rollbackBoundary = JSON.parse(
      await readFile(
        join(
          runsRoot,
          "run_art_rollback_001",
          "artifacts",
          "attempt-001",
          "rollback-boundary.json"
        ),
        "utf8"
      )
    );
    const rollbackOutcome = JSON.parse(
      await readFile(
        join(
          runsRoot,
          "run_art_rollback_001",
          "artifacts",
          "attempt-001",
          "rollback-outcome.json"
        ),
        "utf8"
      )
    );

    expect(rollbackBoundary.strategy).toBe("git_head_plus_snapshot");
    expect(rollbackBoundary.trackedDirtyFiles).toContain("src/real.ts");
    expect(rollbackOutcome.status).toBe("restored");
    expect(rollbackOutcome.deletedFiles).toContain("src/ghost-new-file.ts");
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

describe("receipt integrity persistence", () => {
  it("writes receipt-integrity keys with restricted permissions where the platform supports POSIX modes", async () => {
    const runsRoot = await mkdtemp(join(tmpdir(), "martin-integrity-"));
    const runId = `run_integrity_${Date.now()}`;
    const rootHash = createHash("sha256").update(runsRoot).digest("hex").slice(0, 16);
    const keyDir = join(homedir(), ".martin", "receipt-integrity", rootHash);
    const keyPath = join(keyDir, `${runId}.key`);

    try {
      await writeReceiptIntegrityMaterial({
        runId,
        runsRoot,
        loopRecord: {
          loopId: runId,
          workspaceId: "ws_test",
          projectId: "proj_test",
          status: "completed",
          lifecycleState: "completed",
          task: {
            title: "Integrity test",
            objective: "Write receipt integrity key material.",
            verificationPlan: []
          },
          budget: { maxUsd: 1, softLimitUsd: 0.5, maxIterations: 1, maxTokens: 1000 },
          cost: {
            actualUsd: 0,
            estimatedUsd: 0,
            avoidedUsd: 0,
            tokensIn: 0,
            tokensOut: 0,
            provenance: "actual"
          },
          artifacts: [],
          attempts: [],
          events: [],
          metadata: {},
          createdAt: "2026-06-07T00:00:00.000Z",
          updatedAt: "2026-06-07T00:00:00.000Z"
        },
        ledgerEntries: []
      });

      const keyStats = await stat(keyPath);
      expect(keyStats.isFile()).toBe(true);

      if (process.platform !== "win32") {
        const keyDirStats = await stat(keyDir);
        expect(keyDirStats.mode & 0o777).toBe(0o700);
        expect(keyStats.mode & 0o777).toBe(0o600);
      }
    } finally {
      await rm(runsRoot, { recursive: true, force: true });
      await rm(keyDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  it("fails closed when the persisted ledger contains malformed JSON", async () => {
    const runsRoot = await mkdtemp(join(tmpdir(), "martin-integrity-parse-"));
    const runId = "run_integrity_parse";
    const runDir = join(runsRoot, runId);
    const loopRecordPath = join(runDir, "loop-record.json");
    const ledgerPath = join(runDir, "ledger.jsonl");
    const loopRecord: Parameters<typeof writeReceiptIntegrityMaterial>[0]["loopRecord"] = {
      loopId: runId,
      workspaceId: "ws_test",
      projectId: "proj_test",
      status: "completed",
      lifecycleState: "completed",
      task: {
        title: "Integrity parse test",
        objective: "Detect malformed ledger entries.",
        verificationPlan: []
      },
      budget: { maxUsd: 1, softLimitUsd: 0.5, maxIterations: 1, maxTokens: 1000 },
      cost: {
        actualUsd: 0,
        estimatedUsd: 0,
        avoidedUsd: 0,
        tokensIn: 0,
        tokensOut: 0,
        provenance: "actual"
      },
      artifacts: [],
      attempts: [],
      events: [],
      metadata: {},
      createdAt: "2026-06-07T00:00:00.000Z",
      updatedAt: "2026-06-07T00:00:00.000Z"
    };
    const ledgerEntries = [
      makeLedgerEvent({
        kind: "run.exited",
        runId,
        payload: { status: "completed" },
        timestamp: "2026-06-07T00:00:01.000Z"
      })
    ];

    try {
      await createFileRunStore({ runsRoot }).initRun({
        runId,
        workspaceId: "ws_test",
        projectId: "proj_test",
        task: {
          title: "Integrity parse test",
          objective: "Detect malformed ledger entries.",
          verificationPlan: []
        },
        budget: { maxUsd: 1, softLimitUsd: 0.5, maxIterations: 1, maxTokens: 1000 },
        createdAt: "2026-06-07T00:00:00.000Z"
      });
      await writeFile(loopRecordPath, `${JSON.stringify(loopRecord, null, 2)}\n`, "utf8");
      await writeFile(ledgerPath, `${JSON.stringify(ledgerEntries[0])}\n`, "utf8");
      await writeReceiptIntegrityMaterial({
        runId,
        runsRoot,
        loopRecord,
        ledgerEntries
      });
      const malformedLedger = "{not-json\n";
      await writeFile(ledgerPath, malformedLedger, "utf8");
      const integrityPath = resolveReceiptIntegrityPath(runsRoot, runId);
      const integrityMaterial = JSON.parse(await readFile(integrityPath, "utf8")) as {
        ledgerSha256: string;
      };
      integrityMaterial.ledgerSha256 = createHash("sha256").update(malformedLedger).digest("hex");
      await writeFile(integrityPath, `${JSON.stringify(integrityMaterial, null, 2)}\n`, "utf8");

      await expect(
        verifyReceiptIntegrityFromFiles({
          runId,
          runsRoot,
          loopRecordPath,
          ledgerPath
        })
      ).resolves.toMatchObject({
        state: "tamper_detected",
        reason: "ledger_entry_parse_error"
      });
    } finally {
      await rm(runsRoot, { recursive: true, force: true });
    }
  });
});
