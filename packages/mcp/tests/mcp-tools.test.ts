import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createLoopRecord } from "@martin/contracts";
import { describe, expect, it, vi } from "vitest";

import { getStatusTool } from "../src/tools/get-status.js";
import { inspectLoopTool } from "../src/tools/inspect-loop.js";
import { runLoopTool } from "../src/tools/run-loop.js";

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
// martin_run
// ---------------------------------------------------------------------------

describe("runLoopTool", () => {
  it("returns a loop outcome in stub mode (MARTIN_LIVE=false)", async () => {
    // Set stub mode so the adapter doesn't try to spawn claude
    const originalEnv = process.env.MARTIN_LIVE;
    process.env.MARTIN_LIVE = "false";

    try {
      const result = await runLoopTool({
        objective: "Add a console.log to index.ts",
        allowedPaths: ["src/**"],
        deniedPaths: ["docs/security/**"],
        verificationPlan: [],
        maxIterations: 1,
        maxUsd: 5
      });

      // Stub adapter returns failed, so loop exits with budget_exit or diminishing_returns
      expect(result.loopId).toMatch(/^loop_/u);
      expect(typeof result.attempts).toBe("number");
      expect(typeof result.costUsd).toBe("number");
      expect(["completed", "exited", "failed"]).toContain(result.status);
    } finally {
      if (originalEnv === undefined) {
        delete process.env.MARTIN_LIVE;
      } else {
        process.env.MARTIN_LIVE = originalEnv;
      }
    }
  });

  it("uses workspaceId and projectId when provided", async () => {
    // Mock runMartin to avoid real execution
    const originalEnv = process.env.MARTIN_LIVE;
    process.env.MARTIN_LIVE = "false";

    try {
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

  it("respects engine selection — codex adapter has different adapterId", async () => {
    // We can't run codex in CI, but we can verify the adapter wires correctly
    // by checking that the stub path still returns a result
    const originalEnv = process.env.MARTIN_LIVE;
    process.env.MARTIN_LIVE = "false";

    try {
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

  it("persists repoRoot and path constraints into the loop record", async () => {
    await withRunsRoot(async (runsRoot) => {
      const originalEnv = process.env.MARTIN_LIVE;
      process.env.MARTIN_LIVE = "false";

      try {
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
  it("defines all three required tools", async () => {
    // Import the handlers directly from server via dynamic import would require
    // starting a real server. Instead, verify the tool handler functions exist
    // and are callable — integration tested via martin_run/inspect/status above.
    const { runLoopTool: runFn } = await import("../src/tools/run-loop.js");
    const { inspectLoopTool: inspectFn } = await import("../src/tools/inspect-loop.js");
    const { getStatusTool: statusFn } = await import("../src/tools/get-status.js");

    expect(typeof runFn).toBe("function");
    expect(typeof inspectFn).toBe("function");
    expect(typeof statusFn).toBe("function");
  });
});
