import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createLoopRecord } from "@martin/contracts";
import { describe, expect, it, vi } from "vitest";

import { getStatusTool } from "../src/tools/get-status.js";
import { inspectLoopTool } from "../src/tools/inspect-loop.js";
import { martinDoctorTool } from "../src/tools/doctor.js";
import { martinGetVerificationResultsTool } from "../src/tools/get-verification-results.js";
import { martinListRunsTool } from "../src/tools/list-runs.js";
import { martinPreflightTool } from "../src/tools/preflight.js";
import { runLoopTool } from "../src/tools/run-loop.js";
import { martinTriageRunsTool } from "../src/tools/triage-runs.js";
import { recordMcpWorkflowStep } from "../src/workflow-state.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeLoopRecord(overrides: { costUsd?: number; avoidedUsd?: number } = {}) {
  const loop = createLoopRecord({
    workspaceId: "ws_test",
    projectId: "proj_test",
    task: {
      title: "Fix the off-by-one",
      objective: "Correct counter.ts",
      verificationPlan: ["pnpm test"]
    },
    budget: {
      maxUsd: 10,
      softLimitUsd: 6,
      maxIterations: 3,
      maxTokens: 10_000
    },
    cost: {
      actualUsd: overrides.costUsd ?? 1.5,
      avoidedUsd: overrides.avoidedUsd ?? 0,
      tokensIn: 400,
      tokensOut: 200
    }
  });

  return loop;
}

async function withRunsRoot<T>(fn: (runsRoot: string) => Promise<T>): Promise<T> {
  const previousRunsRoot = process.env.MARTIN_RUNS_DIR;
  const runsRoot = await mkdtemp(join(tmpdir(), "martin-mcp-runs-"));
  process.env.MARTIN_RUNS_DIR = runsRoot;
  try {
    return await fn(runsRoot);
  } finally {
    if (previousRunsRoot === undefined) {
      delete process.env.MARTIN_RUNS_DIR;
    } else {
      process.env.MARTIN_RUNS_DIR = previousRunsRoot;
    }

    await rm(runsRoot, { recursive: true, force: true }).catch(() => {});
  }
}

async function primeRunGate(
  runsRoot: string,
  workingDirectory: string,
  objective: string,
  verificationPlan: string[] = []
): Promise<void> {
  await recordMcpWorkflowStep({
    runsRoot,
    step: "doctor",
    workingDirectory,
    engine: "claude"
  });
  await recordMcpWorkflowStep({
    runsRoot,
    step: "plan",
    workingDirectory,
    objective
  });
  await recordMcpWorkflowStep({
    runsRoot,
    step: "preflight",
    workingDirectory,
    objective,
    engine: "claude",
    verificationPlan
  });
}

// ---------------------------------------------------------------------------
// martin_status
// ---------------------------------------------------------------------------

describe("getStatusTool", () => {
  it("returns correct loop metadata and cost state from inline JSON", async () => {
    const loop = makeLoopRecord({ costUsd: 3 });
    const result = await getStatusTool({ loopJson: JSON.stringify(loop) });

    expect(result.loopId).toBe(loop.loopId);
    expect(result.status).toBe("queued");
    expect(result.lifecycleState).toBe("created");
    expect(result.attempts).toBe(0);
    expect(result.costUsd).toBe(3);
    expect(result.pressure).toBe("healthy");
    expect(result.shouldStop).toBe(false);
    expect(result.remainingBudgetUsd).toBeCloseTo(7);
    expect(result.source).toBe("inline:loopJson");
    expect(result.budget.maxUsd).toBe(10);
    expect(result.inspection.loop.loopId).toBe(loop.loopId);
  });

  it("reports soft_limit pressure when cost exceeds soft limit", async () => {
    const loop = makeLoopRecord({ costUsd: 7 });
    const result = await getStatusTool({ loopJson: JSON.stringify(loop) });

    expect(result.pressure).toBe("soft_limit");
    expect(result.shouldStop).toBe(false);
  });

  it("reports hard_limit and shouldStop when cost exceeds maxUsd", async () => {
    const loop = makeLoopRecord({ costUsd: 11 });
    const result = await getStatusTool({ loopJson: JSON.stringify(loop) });

    expect(result.pressure).toBe("hard_limit");
    expect(result.shouldStop).toBe(true);
  });

  it("throws on invalid JSON", async () => {
    await expect(getStatusTool({ loopJson: "not valid json" })).rejects.toThrow();
  });

  it("accepts inline JSON without task metadata", async () => {
    const result = await getStatusTool({
      loopJson: JSON.stringify({
        loopId: "loop_inline_minimal",
        status: "queued",
        lifecycleState: "created",
        attempts: [],
        budget: {
          maxUsd: 5,
          softLimitUsd: 3,
          maxIterations: 2,
          maxTokens: 1000
        },
        cost: {
          actualUsd: 1.25,
          avoidedUsd: 0,
          tokensIn: 20,
          tokensOut: 10
        }
      })
    });

    expect(result.loopId).toBe("loop_inline_minimal");
    expect(result.inspection.loop.title).toBe("loop_inline_minimal");
    expect(result.inspection.loop.objective).toBe("Loop record summary");
  });

  it("loads the latest loop record from a JSONL file", async () => {
    await withRunsRoot(async (runsRoot) => {
      const older = {
        ...makeLoopRecord({ costUsd: 1 }),
        createdAt: "2026-05-01T00:00:00.000Z",
        updatedAt: "2026-05-01T00:00:00.000Z"
      };
      const newer = {
        ...makeLoopRecord({ costUsd: 4 }),
        createdAt: "2026-05-02T00:00:00.000Z",
        updatedAt: "2026-05-02T00:00:00.000Z"
      };
      const file = join(runsRoot, "workspace.jsonl");
      await writeFile(file, `${JSON.stringify(older)}\n${JSON.stringify(newer)}\n`, "utf8");

      const result = await getStatusTool({ file });

      expect(result.loopId).toBe(newer.loopId);
      expect(result.costUsd).toBe(4);
      expect(result.source).toBe(file);
    });
  });

  it("loads the latest run from the configured runs root", async () => {
    await withRunsRoot(async (runsRoot) => {
      const older = {
        ...makeLoopRecord({ costUsd: 2 }),
        createdAt: "2026-05-01T00:00:00.000Z",
        updatedAt: "2026-05-01T00:00:00.000Z"
      };
      const newer = {
        ...makeLoopRecord({ costUsd: 5 }),
        createdAt: "2026-05-03T00:00:00.000Z",
        updatedAt: "2026-05-03T00:00:00.000Z"
      };
      await mkdir(join(runsRoot, older.loopId), { recursive: true });
      await mkdir(join(runsRoot, newer.loopId), { recursive: true });
      await writeFile(join(runsRoot, older.loopId, "loop-record.json"), JSON.stringify(older), "utf8");
      await writeFile(join(runsRoot, newer.loopId, "loop-record.json"), JSON.stringify(newer), "utf8");

      const result = await getStatusTool({ latest: true });

      expect(result.loopId).toBe(newer.loopId);
      expect(result.costUsd).toBe(5);
    });
  });

  it("still loads the latest healthy run when the runs root also contains a broken loop record", async () => {
    await withRunsRoot(async (runsRoot) => {
      const healthy = {
        ...makeLoopRecord({ costUsd: 5 }),
        createdAt: "2026-05-03T00:00:00.000Z",
        updatedAt: "2026-05-03T00:00:00.000Z"
      };
      await mkdir(join(runsRoot, healthy.loopId), { recursive: true });
      await mkdir(join(runsRoot, "loop_broken"), { recursive: true });
      await writeFile(join(runsRoot, healthy.loopId, "loop-record.json"), JSON.stringify(healthy), "utf8");
      await writeFile(join(runsRoot, "loop_broken", "loop-record.json"), "{not-json", "utf8");

      const result = await getStatusTool({ latest: true });

      expect(result.loopId).toBe(healthy.loopId);
      expect(result.costUsd).toBe(5);
    });
  });

  it("loads a canonical loop record by loopId", async () => {
    await withRunsRoot(async (runsRoot) => {
      const loop = makeLoopRecord({ costUsd: 2.75 });
      await mkdir(join(runsRoot, loop.loopId), { recursive: true });
      await writeFile(join(runsRoot, loop.loopId, "loop-record.json"), JSON.stringify(loop), "utf8");

      const result = await getStatusTool({ loopId: loop.loopId });

      expect(result.loopId).toBe(loop.loopId);
      expect(result.costUsd).toBe(2.75);
    });
  });
});

// ---------------------------------------------------------------------------
// martin_inspect
// ---------------------------------------------------------------------------

describe("inspectLoopTool", () => {
  it("reads a single loop record file and returns portfolio snapshot", async () => {
    await withRunsRoot(async (runsRoot) => {
      const loop = makeLoopRecord({ costUsd: 2.5, avoidedUsd: 1 });
      const file = join(runsRoot, "loop_001", "loop-record.json");
      await mkdir(join(runsRoot, "loop_001"), { recursive: true });
      await writeFile(file, JSON.stringify(loop), "utf8");

      const result = await inspectLoopTool({ file });

      expect(result.source).toBe(file);
      expect(result.loopCount).toBe(1);
      expect(result.portfolio.totalActualUsd).toBe(2.5);
      expect(result.portfolio.totalAvoidedUsd).toBe(1);
      expect(result.portfolio.totalTokensIn).toBe(400);
      expect(result.latestRun?.loopId).toBe(loop.loopId);
      expect(result.recentRuns).toHaveLength(1);
      expect(result.inspection.sourceKind).toBe("file");
    });
  });

  it("reads an array of loop records", async () => {
    await withRunsRoot(async (runsRoot) => {
      const loops = [makeLoopRecord({ costUsd: 1 }), makeLoopRecord({ costUsd: 2 })];
      const file = join(runsRoot, "aggregate", "loops.json");
      await mkdir(join(runsRoot, "aggregate"), { recursive: true });
      await writeFile(file, JSON.stringify(loops), "utf8");

      const result = await inspectLoopTool({ file });

      expect(result.loopCount).toBe(2);
      expect(result.portfolio.totalActualUsd).toBe(3);
    });
  });

  it("reads legacy JSONL loop records", async () => {
    await withRunsRoot(async (runsRoot) => {
      const loops = [makeLoopRecord({ costUsd: 1 }), makeLoopRecord({ costUsd: 2 })];
      const file = join(runsRoot, "aggregate.jsonl");
      await writeFile(file, `${JSON.stringify(loops[0])}\n${JSON.stringify(loops[1])}\n`, "utf8");

      const result = await inspectLoopTool({ file });

      expect(result.loopCount).toBe(2);
      expect(result.portfolio.totalActualUsd).toBe(3);
    });
  });

  it("defaults to the Martin run store when no selector is provided", async () => {
    await withRunsRoot(async (runsRoot) => {
      const loop = makeLoopRecord({ costUsd: 2.5, avoidedUsd: 0.5 });
      await mkdir(join(runsRoot, loop.loopId), { recursive: true });
      await writeFile(join(runsRoot, loop.loopId, "loop-record.json"), JSON.stringify(loop), "utf8");

      const result = await inspectLoopTool({});

      expect(result.source).toBe(runsRoot);
      expect(result.loopCount).toBe(1);
      expect(result.portfolio.totalActualUsd).toBe(2.5);
      expect(result.inspection.sourceKind).toBe("runs_root");
      expect(result.warnings).toEqual([]);
    });
  });

  it("skips unreadable loop records in a runs-root inspection and reports warnings", async () => {
    await withRunsRoot(async (runsRoot) => {
      const loop = makeLoopRecord({ costUsd: 2.5, avoidedUsd: 0.5 });
      await mkdir(join(runsRoot, loop.loopId), { recursive: true });
      await mkdir(join(runsRoot, "loop_broken"), { recursive: true });
      await writeFile(join(runsRoot, loop.loopId, "loop-record.json"), JSON.stringify(loop), "utf8");
      await writeFile(join(runsRoot, "loop_broken", "loop-record.json"), "{not-json", "utf8");

      const result = await inspectLoopTool({});

      expect(result.loopCount).toBe(1);
      expect(result.latestRun?.loopId).toBe(loop.loopId);
      expect(result.warnings).toContain("Skipped unreadable loop record for 'loop_broken'.");
    });
  });

  it("degrades missing explicit runsDir diagnostics instead of rejecting the path", async () => {
    await withRunsRoot(async (runsRoot) => {
      const missingRunsRoot = join(runsRoot, "missing");

      const inspected = await inspectLoopTool({ runsDir: missingRunsRoot });
      const listed = await martinListRunsTool({ runsDir: missingRunsRoot });

      expect(inspected.source).toBe(missingRunsRoot);
      expect(inspected.loopCount).toBe(0);
      expect(inspected.warnings).toContain(
        "Configured Martin runs root is missing or unreadable; no loop records could be inspected."
      );
      expect(listed.runsRoot).toBe(missingRunsRoot);
      expect(listed.loopCount).toBe(0);
      expect(listed.warnings).toContain(
        "Configured Martin runs root is missing or unreadable; no loop records could be inspected."
      );
    });
  });

  it("rejects files outside the Martin run store", async () => {
    await withRunsRoot(async () => {
      const file = join(tmpdir(), `martin-outside-${Date.now()}.json`);
      await writeFile(file, JSON.stringify(makeLoopRecord()), "utf8");

      await expect(inspectLoopTool({ file })).rejects.toThrow("Invalid file.");
    });
  });
});

// ---------------------------------------------------------------------------
// martin_doctor / martin_preflight
// ---------------------------------------------------------------------------

describe("martinDoctorTool", () => {
  it("reports run-store visibility in proof mode without requiring live CLIs", async () => {
    await withRunsRoot(async (runsRoot) => {
      const originalEnv = process.env.MARTIN_LIVE;
      process.env.MARTIN_LIVE = "false";

      try {
        const loop = makeLoopRecord({ costUsd: 1.25 });
        await mkdir(join(runsRoot, loop.loopId), { recursive: true });
        await writeFile(join(runsRoot, loop.loopId, "loop-record.json"), JSON.stringify(loop), "utf8");

        const result = await martinDoctorTool({ runsDir: runsRoot, engine: "codex" });

        expect(result.status).toBe("ok");
        expect(result.environment.mode).toBe("proof");
        expect(result.runStore.exists).toBe(true);
        expect(result.runStore.loopCount).toBe(1);
        expect(result.runStore.latestRun?.loopId).toBe(loop.loopId);
        expect(result.requestedEngine).toBe("codex");
      } finally {
        if (originalEnv === undefined) {
          delete process.env.MARTIN_LIVE;
        } else {
          process.env.MARTIN_LIVE = originalEnv;
        }
      }
    });
  });

  it("surfaces degraded run-store warnings instead of failing on broken loop records", async () => {
    await withRunsRoot(async (runsRoot) => {
      const originalEnv = process.env.MARTIN_LIVE;
      process.env.MARTIN_LIVE = "false";

      try {
        const loop = makeLoopRecord({ costUsd: 1.25 });
        await mkdir(join(runsRoot, loop.loopId), { recursive: true });
        await mkdir(join(runsRoot, "loop_broken"), { recursive: true });
        await writeFile(join(runsRoot, loop.loopId, "loop-record.json"), JSON.stringify(loop), "utf8");
        await writeFile(join(runsRoot, "loop_broken", "loop-record.json"), "{not-json", "utf8");

        const result = await martinDoctorTool({ runsDir: runsRoot, engine: "codex" });

        expect(result.status).toBe("degraded");
        expect(result.runStore.loopCount).toBe(1);
        expect(result.warnings).toContain("Skipped unreadable loop record for 'loop_broken'.");
      } finally {
        if (originalEnv === undefined) {
          delete process.env.MARTIN_LIVE;
        } else {
          process.env.MARTIN_LIVE = originalEnv;
        }
      }
    });
  });

  it("degrades missing explicit runsDir health checks instead of rejecting the path", async () => {
    await withRunsRoot(async (runsRoot) => {
      const originalEnv = process.env.MARTIN_LIVE;
      process.env.MARTIN_LIVE = "false";

      try {
        const missingRunsRoot = join(runsRoot, "missing");
        const result = await martinDoctorTool({ runsDir: missingRunsRoot, engine: "codex" });

        expect(result.status).toBe("degraded");
        expect(result.environment.runsRoot).toBe(missingRunsRoot);
        expect(result.runStore.exists).toBe(false);
        expect(result.runStore.loopCount).toBe(0);
        expect(result.warnings).toContain("Configured Martin runs root does not exist yet.");
        expect(result.warnings).toContain(
          "Configured Martin runs root is missing or unreadable; no loop records could be inspected."
        );
      } finally {
        if (originalEnv === undefined) {
          delete process.env.MARTIN_LIVE;
        } else {
          process.env.MARTIN_LIVE = originalEnv;
        }
      }
    });
  });
});

describe("martinPreflightTool", () => {
  it("normalizes run inputs and expected inspection layout without executing work", async () => {
    const originalEnv = process.env.MARTIN_LIVE;
    process.env.MARTIN_LIVE = "false";

    try {
      const result = await martinPreflightTool({
        objective: "Fix the auth regression",
        engine: "codex",
        maxUsd: 3,
        maxIterations: 2,
        verificationPlan: ["pnpm test --filter auth"],
        allowedPaths: ["src/**", "tests/**"]
      });

      expect(result.ok).toBe(true);
      expect(result.readiness.mode).toBe("proof");
      expect(result.normalized.engine).toBe("codex");
      expect(result.normalized.budget.maxUsd).toBe(3);
      expect(result.normalized.budget.maxIterations).toBe(2);
      expect(result.normalized.allowedPaths).toEqual(["src/**", "tests/**"]);
      expect(result.execution.expectedRunLayout.loopRecordPathPattern).toBe(
        "<runsRoot>/<loopId>/loop-record.json"
      );
    } finally {
      if (originalEnv === undefined) {
        delete process.env.MARTIN_LIVE;
      } else {
        process.env.MARTIN_LIVE = originalEnv;
      }
    }
  });
});

// ---------------------------------------------------------------------------
// martin_triage_runs
// ---------------------------------------------------------------------------

describe("martinTriageRunsTool", () => {
  it("prioritizes failed runs that need attention ahead of healthy runs", async () => {
    await withRunsRoot(async (runsRoot) => {
      const failed = {
        ...makeLoopRecord({ costUsd: 4 }),
        loopId: "loop_failed",
        status: "failed",
        lifecycleState: "diminishing_returns",
        updatedAt: "2026-05-16T03:00:00.000Z",
        attempts: [
          {
            attemptId: "att_failed",
            index: 1,
            adapterId: "codex-cli",
            model: "gpt-5-codex",
            summary: "Verification failed",
            failureClass: "verification_failure",
            intervention: "run_verifier"
          }
        ],
        events: [
          {
            eventId: "evt_1",
            timestamp: "2026-05-16T03:01:00.000Z",
            type: "verification.completed",
            lifecycleState: "verifying",
            payload: {
              attemptId: "att_failed",
              passed: false,
              summary: "Regression tests failed."
            }
          }
        ]
      };
      const healthy = {
        ...makeLoopRecord({ costUsd: 1 }),
        loopId: "loop_healthy",
        status: "completed",
        lifecycleState: "completed",
        updatedAt: "2026-05-16T02:00:00.000Z",
        attempts: [
          {
            attemptId: "att_ok",
            index: 1,
            adapterId: "codex-cli",
            model: "gpt-5-codex",
            summary: "All checks passed"
          }
        ],
        events: [
          {
            eventId: "evt_2",
            timestamp: "2026-05-16T02:01:00.000Z",
            type: "verification.completed",
            lifecycleState: "verifying",
            payload: {
              attemptId: "att_ok",
              passed: true,
              summary: "All checks passed."
            }
          }
        ]
      };

      await mkdir(join(runsRoot, failed.loopId), { recursive: true });
      await mkdir(join(runsRoot, healthy.loopId), { recursive: true });
      await writeFile(join(runsRoot, failed.loopId, "loop-record.json"), JSON.stringify(failed), "utf8");
      await writeFile(join(runsRoot, healthy.loopId, "loop-record.json"), JSON.stringify(healthy), "utf8");

      const result = await martinTriageRunsTool({});

      expect(result.evaluatedRuns).toBe(2);
      expect(result.findingCount).toBe(1);
      expect(result.findings[0]?.loop.loopId).toBe("loop_failed");
      expect(result.findings[0]?.severity).toBe("critical");
      expect(result.findings[0]?.reasonCodes).toContain("verification_failed");
    });
  });

  it("includes healthy runs when explicitly requested", async () => {
    await withRunsRoot(async (runsRoot) => {
      const loop = {
        ...makeLoopRecord({ costUsd: 1 }),
        loopId: "loop_healthy_triage",
        status: "completed",
        lifecycleState: "completed",
        attempts: [
          {
            attemptId: "att_ok",
            index: 1,
            adapterId: "codex-cli",
            model: "gpt-5-codex"
          }
        ],
        events: [
          {
            eventId: "evt_1",
            timestamp: "2026-05-16T01:01:00.000Z",
            type: "verification.completed",
            lifecycleState: "verifying",
            payload: {
              attemptId: "att_ok",
              passed: true,
              summary: "Healthy run."
            }
          }
        ]
      };

      await mkdir(join(runsRoot, loop.loopId), { recursive: true });
      await writeFile(join(runsRoot, loop.loopId, "loop-record.json"), JSON.stringify(loop), "utf8");

      const result = await martinTriageRunsTool({ includeHealthy: true });

      expect(result.findingCount).toBe(1);
      expect(result.findings[0]?.reasonCodes).toEqual(["healthy"]);
      expect(result.findings[0]?.severity).toBe("low");
    });
  });

  it("uses ledger verification evidence when the loop record is missing verification events", async () => {
    await withRunsRoot(async (runsRoot) => {
      const loop = {
        ...makeLoopRecord({ costUsd: 2 }),
        loopId: "loop_ledger_only_verification",
        status: "failed",
        lifecycleState: "diminishing_returns",
        attempts: [
          {
            attemptId: "att_ledger",
            index: 1,
            adapterId: "codex-cli",
            model: "gpt-5-codex",
            summary: "Verification failed in ledger only."
          }
        ],
        events: []
      };

      await mkdir(join(runsRoot, loop.loopId), { recursive: true });
      await writeFile(join(runsRoot, loop.loopId, "loop-record.json"), JSON.stringify(loop), "utf8");
      await writeFile(
        join(runsRoot, loop.loopId, "ledger.jsonl"),
        `${JSON.stringify({
          kind: "verification.completed",
          runId: loop.loopId,
          attemptIndex: 1,
          timestamp: "2026-05-16T04:00:00.000Z",
          payload: {
            passed: false,
            summary: "Ledger says verification failed."
          }
        })}\n`,
        "utf8"
      );

      const triage = await martinTriageRunsTool({});
      const verification = await martinGetVerificationResultsTool({ loopId: loop.loopId });

      expect(triage.findings[0]?.loop.loopId).toBe(loop.loopId);
      expect(triage.findings[0]?.reasonCodes).toContain("verification_failed");
      expect(verification.verification.status).toBe("failed");
      expect(verification.verification.latestAttemptIndex).toBe(1);
      expect(verification.verification.summary).toBe("Ledger says verification failed.");
      expect(verification.warnings).toContain(
        "No verification.completed events were found in the loop record; using ledger evidence."
      );
    });
  });

  it("distinguishes unreadable ledger evidence from absent ledger verification evidence", async () => {
    await withRunsRoot(async (runsRoot) => {
      const loop = {
        ...makeLoopRecord({ costUsd: 2 }),
        loopId: "loop_malformed_ledger",
        status: "completed",
        lifecycleState: "completed",
        attempts: [
          {
            attemptId: "att_malformed_ledger",
            index: 1,
            adapterId: "codex-cli",
            model: "gpt-5-codex",
            summary: "Loop record verification is valid."
          }
        ],
        events: [
          {
            eventId: "evt_1",
            timestamp: "2026-05-16T04:00:00.000Z",
            type: "verification.completed",
            lifecycleState: "verifying",
            payload: {
              attemptId: "att_malformed_ledger",
              passed: true,
              summary: "Loop record verification passed."
            }
          }
        ]
      };

      await mkdir(join(runsRoot, loop.loopId), { recursive: true });
      await writeFile(join(runsRoot, loop.loopId, "loop-record.json"), JSON.stringify(loop), "utf8");
      await writeFile(join(runsRoot, loop.loopId, "ledger.jsonl"), "{not-json", "utf8");

      const verification = await martinGetVerificationResultsTool({ loopId: loop.loopId });

      expect(verification.verification.status).toBe("passed");
      expect(verification.warnings).toContain(
        "Verification ledger for 'loop_malformed_ledger' is unreadable; ledger verification evidence is unavailable."
      );
      expect(verification.warnings).not.toContain("No verification.completed ledger events were found for this run.");
    });
  });

  it("reports unavailable verification when the latest attempt has conflicting evidence", async () => {
    await withRunsRoot(async (runsRoot) => {
      const loop = {
        ...makeLoopRecord({ costUsd: 2 }),
        loopId: "loop_conflicting_verification",
        status: "failed",
        lifecycleState: "diminishing_returns",
        attempts: [
          {
            attemptId: "att_conflict",
            index: 1,
            adapterId: "codex-cli",
            model: "gpt-5-codex",
            summary: "Conflicting verification evidence."
          }
        ],
        events: [
          {
            eventId: "evt_1",
            timestamp: "2026-05-16T04:00:00.000Z",
            type: "verification.completed",
            lifecycleState: "verifying",
            payload: {
              attemptId: "att_conflict",
              passed: true,
              summary: "Verifier passed."
            }
          },
          {
            eventId: "evt_2",
            timestamp: "2026-05-16T04:00:00.000Z",
            type: "verification.completed",
            lifecycleState: "verifying",
            payload: {
              attemptId: "att_conflict",
              passed: false,
              summary: "Verifier failed."
            }
          }
        ]
      };

      await mkdir(join(runsRoot, loop.loopId), { recursive: true });
      await writeFile(join(runsRoot, loop.loopId, "loop-record.json"), JSON.stringify(loop), "utf8");

      const verification = await martinGetVerificationResultsTool({ loopId: loop.loopId });

      expect(verification.verification.status).toBe("unavailable");
      expect(verification.warnings).toContain(
        "Verification evidence conflicts for the latest attempt; reporting status as unavailable."
      );
    });
  });

  it("ignores future-dated verification evidence that cannot be trusted", async () => {
    await withRunsRoot(async (runsRoot) => {
      const loop = {
        ...makeLoopRecord({ costUsd: 2 }),
        loopId: "loop_future_verification",
        status: "failed",
        lifecycleState: "diminishing_returns",
        attempts: [
          {
            attemptId: "att_future",
            index: 1,
            adapterId: "codex-cli",
            model: "gpt-5-codex",
            summary: "Future-dated verification evidence should not count."
          }
        ],
        events: [
          {
            eventId: "evt_1",
            timestamp: "2099-05-16T04:00:00.000Z",
            type: "verification.completed",
            lifecycleState: "verifying",
            payload: {
              attemptId: "att_future",
              passed: true,
              summary: "This evidence should be ignored."
            }
          }
        ]
      };

      await mkdir(join(runsRoot, loop.loopId), { recursive: true });
      await writeFile(join(runsRoot, loop.loopId, "loop-record.json"), JSON.stringify(loop), "utf8");

      const verification = await martinGetVerificationResultsTool({ loopId: loop.loopId });

      expect(verification.verification.status).toBe("unavailable");
      expect(verification.verification.eventCount).toBe(1);
      expect(verification.verification).not.toHaveProperty("latestAttemptIndex");
      expect(verification.warnings).toContain(
        "Ignored 1 future-dated verification evidence item(s) that cannot be trusted yet."
      );
    });
  });

  it("skips unreadable run records during triage instead of aborting the whole scan", async () => {
    await withRunsRoot(async (runsRoot) => {
      const healthy = {
        ...makeLoopRecord({ costUsd: 1 }),
        loopId: "loop_triage_survivor",
        status: "failed",
        lifecycleState: "diminishing_returns",
        attempts: [
          {
            attemptId: "att_ok",
            index: 1,
            adapterId: "codex-cli",
            model: "gpt-5-codex",
            summary: "Verification failed"
          }
        ],
        events: [
          {
            eventId: "evt_1",
            timestamp: "2026-05-16T04:01:00.000Z",
            type: "verification.completed",
            lifecycleState: "verifying",
            payload: {
              attemptId: "att_ok",
              passed: false,
              summary: "Still broken."
            }
          }
        ]
      };
      const degraded = {
        ...makeLoopRecord({ costUsd: 2 }),
        loopId: "loop_broken_triage",
        status: "failed",
        lifecycleState: "diminishing_returns",
        attempts: [
          {
            attemptId: "att_bad",
            index: 1,
            adapterId: "codex-cli",
            model: "gpt-5-codex",
            summary: "Unreadable ledger evidence."
          }
        ],
        events: []
      };

      await mkdir(join(runsRoot, healthy.loopId), { recursive: true });
      await mkdir(join(runsRoot, degraded.loopId), { recursive: true });
      await writeFile(join(runsRoot, healthy.loopId, "loop-record.json"), JSON.stringify(healthy), "utf8");
      await writeFile(join(runsRoot, degraded.loopId, "loop-record.json"), JSON.stringify(degraded), "utf8");
      await writeFile(join(runsRoot, degraded.loopId, "ledger.jsonl"), "{not-json", "utf8");

      const triage = await martinTriageRunsTool({});

      expect(triage.findings[0]?.loop.loopId).toBe(healthy.loopId);
      expect(triage.evaluatedRuns).toBeGreaterThanOrEqual(1);
    });
  });

  it("skips malformed loop records before filtered triage touches poisoned attempts", async () => {
    await withRunsRoot(async (runsRoot) => {
      const healthy = {
        ...makeLoopRecord({ costUsd: 1 }),
        loopId: "loop_filtered_survivor",
        status: "failed",
        lifecycleState: "diminishing_returns",
        attempts: [
          {
            attemptId: "att_ok",
            index: 1,
            adapterId: "codex-cli",
            model: "gpt-5-codex",
            summary: "Verification failed"
          }
        ],
        events: [
          {
            eventId: "evt_1",
            timestamp: "2026-05-16T04:01:00.000Z",
            type: "verification.completed",
            lifecycleState: "verifying",
            payload: {
              attemptId: "att_ok",
              passed: false,
              summary: "Still broken."
            }
          }
        ]
      };
      const poisoned = {
        ...makeLoopRecord({ costUsd: 2 }),
        loopId: "loop_filtered_poisoned",
        status: "failed",
        lifecycleState: "diminishing_returns",
        attempts: [null]
      };

      await mkdir(join(runsRoot, healthy.loopId), { recursive: true });
      await mkdir(join(runsRoot, poisoned.loopId), { recursive: true });
      await writeFile(join(runsRoot, healthy.loopId, "loop-record.json"), JSON.stringify(healthy), "utf8");
      await writeFile(join(runsRoot, poisoned.loopId, "loop-record.json"), JSON.stringify(poisoned), "utf8");

      const triage = await martinTriageRunsTool({ adapterId: "codex-cli" });

      expect(triage.findings[0]?.loop.loopId).toBe(healthy.loopId);
      expect(triage.warnings).toContain("Skipped unreadable loop record for 'loop_filtered_poisoned'.");
    });
  });

  it("skips loop records whose discovered run directory resolves through a symlink", async () => {
    await withRunsRoot(async (runsRoot) => {
      const healthy = {
        ...makeLoopRecord({ costUsd: 1 }),
        loopId: "loop_symlink_survivor",
        status: "failed",
        lifecycleState: "diminishing_returns",
        attempts: [
          {
            attemptId: "att_ok",
            index: 1,
            adapterId: "codex-cli",
            model: "gpt-5-codex"
          }
        ],
        events: [
          {
            eventId: "evt_1",
            timestamp: "2026-05-16T04:01:00.000Z",
            type: "verification.completed",
            lifecycleState: "verifying",
            payload: {
              attemptId: "att_ok",
              passed: false,
              summary: "Still broken."
            }
          }
        ]
      };
      const outsideRoot = await mkdtemp(join(tmpdir(), "martin-mcp-triage-outside-"));
      const outsideLoopDirectory = join(outsideRoot, "loop_symlinked");
      const linkedLoopDirectory = join(runsRoot, "loop_symlinked");
      await mkdir(join(runsRoot, healthy.loopId), { recursive: true });
      await mkdir(outsideLoopDirectory, { recursive: true });
      await writeFile(join(runsRoot, healthy.loopId, "loop-record.json"), JSON.stringify(healthy), "utf8");
      await writeFile(join(outsideLoopDirectory, "loop-record.json"), JSON.stringify(healthy), "utf8");

      await symlink(
        outsideLoopDirectory,
        linkedLoopDirectory,
        process.platform === "win32" ? "junction" : "dir"
      );

      try {
        const triage = await martinTriageRunsTool({});

        expect(triage.findings.map((finding) => finding.loop.loopId)).toContain(healthy.loopId);
        expect(triage.findings.map((finding) => finding.loop.loopId)).not.toContain("loop_symlinked");
      } finally {
        await rm(outsideRoot, { recursive: true, force: true }).catch(() => {});
      }
    });
  });
});

// ---------------------------------------------------------------------------
// martin_run
// ---------------------------------------------------------------------------

describe("runLoopTool", () => {
  it("blocks martin_run until doctor, plan, and preflight receipts exist", async () => {
    await withRunsRoot(async (runsRoot) => {
      const originalEnv = process.env.MARTIN_LIVE;
      process.env.MARTIN_LIVE = "false";

      try {
        await expect(() =>
          runLoopTool({
            objective: "Add a console.log to index.ts",
            verificationPlan: [],
            maxIterations: 1,
            maxUsd: 5
          })
        ).rejects.toMatchObject({
          code: "policy_blocked"
        });

        await primeRunGate(runsRoot, process.cwd(), "Add a console.log to index.ts", []);

        const result = await runLoopTool({
          objective: "Add a console.log to index.ts",
          allowedPaths: ["src/**"],
          deniedPaths: ["docs/security/**"],
          verificationPlan: [],
          maxIterations: 1,
          maxUsd: 5
        });

        expect(result.loopId).toMatch(/^loop_/u);
        expect(typeof result.attempts).toBe("number");
        expect(result.costUsd).toBe(0);
        expect(result.status).toBe("completed");
        expect(result.verificationPassed).toBe(true);
      } finally {
        if (originalEnv === undefined) {
          delete process.env.MARTIN_LIVE;
        } else {
          process.env.MARTIN_LIVE = originalEnv;
        }
      }
    });
  });

  it("uses workspaceId and projectId when provided", async () => {
    await withRunsRoot(async (runsRoot) => {
      const originalEnv = process.env.MARTIN_LIVE;
      process.env.MARTIN_LIVE = "false";

      try {
        await primeRunGate(runsRoot, process.cwd(), "Fix the bug", []);

        const result = await runLoopTool({
          objective: "Fix the bug",
          workspaceId: "ws_custom",
          projectId: "proj_custom",
          maxIterations: 1
        });

        expect(result.loopId).toBeTruthy();
      } finally {
        if (originalEnv === undefined) {
          delete process.env.MARTIN_LIVE;
        } else {
          process.env.MARTIN_LIVE = originalEnv;
        }
      }
    });
  });

  it("respects engine selection — codex adapter has different adapterId", async () => {
    await withRunsRoot(async (runsRoot) => {
      const originalEnv = process.env.MARTIN_LIVE;
      process.env.MARTIN_LIVE = "false";

      try {
        await recordMcpWorkflowStep({
          runsRoot,
          step: "doctor",
          workingDirectory: process.cwd(),
          engine: "codex"
        });
        await recordMcpWorkflowStep({
          runsRoot,
          step: "plan",
          workingDirectory: process.cwd(),
          objective: "Fix the bug"
        });
        await recordMcpWorkflowStep({
          runsRoot,
          step: "preflight",
          workingDirectory: process.cwd(),
          objective: "Fix the bug",
          engine: "codex",
          verificationPlan: []
        });

        const result = await runLoopTool({
          objective: "Fix the bug",
          engine: "codex",
          maxIterations: 1
        });

        expect(result.loopId).toBeTruthy();
      } finally {
        if (originalEnv === undefined) {
          delete process.env.MARTIN_LIVE;
        } else {
          process.env.MARTIN_LIVE = originalEnv;
        }
      }
    });
  });

  it("persists repoRoot and path constraints into the loop record", async () => {
    await withRunsRoot(async (runsRoot) => {
      const originalEnv = process.env.MARTIN_LIVE;
      process.env.MARTIN_LIVE = "false";

      try {
        await primeRunGate(runsRoot, process.cwd(), "Scope-limited change", []);

        const result = await runLoopTool({
          objective: "Scope-limited change",
          workingDirectory: ".",
          allowedPaths: ["src/**"],
          deniedPaths: ["docs/**"],
          verificationPlan: [],
          maxIterations: 1,
          maxUsd: 1
        });

        const loopRecordPath = join(runsRoot, result.loopId, "loop-record.json");
        const persisted = JSON.parse(await readFile(loopRecordPath, "utf8"));

        expect(persisted.task.repoRoot).toBe(process.cwd());
        expect(persisted.task.allowedPaths).toEqual(["src/**"]);
        expect(persisted.task.deniedPaths).toEqual(["docs/**"]);
        expect(result.inspection.loopRecordPath).toBe(loopRecordPath);
        expect(result.inspection.loop.loopId).toBe(result.loopId);
        expect(result.pressure).toBeTruthy();
      } finally {
        if (originalEnv === undefined) {
          delete process.env.MARTIN_LIVE;
        } else {
          process.env.MARTIN_LIVE = originalEnv;
        }
      }
    });
  });
});

// ---------------------------------------------------------------------------
// Server tool manifest (structural)
// ---------------------------------------------------------------------------

describe("MCP server tool manifest", () => {
  it("defines all required tool handlers", async () => {
    // Import the handlers directly from server via dynamic import would require
    // starting a real server. Instead, verify the tool handler functions exist
    // and are callable — integration tested via martin_run/inspect/status above.
    const { runLoopTool: runFn } = await import("../src/tools/run-loop.js");
    const { inspectLoopTool: inspectFn } = await import("../src/tools/inspect-loop.js");
    const { getStatusTool: statusFn } = await import("../src/tools/get-status.js");
    const { martinDoctorTool: doctorFn } = await import("../src/tools/doctor.js");
    const { martinPreflightTool: preflightFn } = await import("../src/tools/preflight.js");
    const { martinTriageRunsTool: triageFn } = await import("../src/tools/triage-runs.js");

    expect(typeof runFn).toBe("function");
    expect(typeof inspectFn).toBe("function");
    expect(typeof statusFn).toBe("function");
    expect(typeof doctorFn).toBe("function");
    expect(typeof preflightFn).toBe("function");
    expect(typeof triageFn).toBe("function");
  });
});
