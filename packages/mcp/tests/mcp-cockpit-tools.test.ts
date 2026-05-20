import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { appendLoopEvent, createLoopRecord } from "@martin/contracts";
import { describe, expect, it } from "vitest";

import { getAttemptTool } from "../src/tools/get-attempt.js";
import { getRunTool } from "../src/tools/get-run.js";
import { getVerificationResultsTool } from "../src/tools/get-verification-results.js";
import { listRunsTool } from "../src/tools/list-runs.js";
import { runDossierTool } from "../src/tools/run-dossier.js";

async function withRunsRoot<T>(fn: (runsRoot: string) => Promise<T>): Promise<T> {
  const runsRoot = await mkdtemp(join(tmpdir(), "martin-mcp-tools-"));
  const previousRunsRoot = process.env.MARTIN_RUNS_DIR;
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

async function writeLoop(runsRoot: string) {
  const initial = createLoopRecord({
    loopId: "loop_cockpit",
    workspaceId: "ws_test",
    projectId: "proj_test",
    task: {
      title: "Harden MCP cockpit",
      objective: "Expose read-only run evidence",
      verificationPlan: ["pnpm test"]
    },
    budget: {
      maxUsd: 5,
      softLimitUsd: 3,
      maxIterations: 2,
      maxTokens: 8000
    },
    cost: {
      actualUsd: 1.25,
      avoidedUsd: 0.5,
      tokensIn: 400,
      tokensOut: 150
    },
    attempts: [
      {
        attemptId: "attempt_1",
        index: 1,
        adapterId: "stub",
        model: "test-model",
        startedAt: "2026-05-20T15:00:00.000Z",
        completedAt: "2026-05-20T15:02:00.000Z",
        summary: "First verifier pass."
      }
    ],
    createdAt: "2026-05-20T15:00:00.000Z",
    updatedAt: "2026-05-20T15:03:00.000Z"
  });

  const loop = appendLoopEvent(initial, {
    type: "verification.completed",
    lifecycleState: "completed",
    timestamp: "2026-05-20T15:03:00.000Z",
    payload: { passed: true, summary: "pnpm test passed." }
  });

  await mkdir(join(runsRoot, loop.loopId), { recursive: true });
  await writeFile(join(runsRoot, loop.loopId, "loop-record.json"), JSON.stringify(loop), "utf8");
  return loop;
}

describe("0.2.0 read-only cockpit tools", () => {
  it("lists runs with cost and pressure summaries", async () => {
    await withRunsRoot(async (runsRoot) => {
      await writeLoop(runsRoot);

      const result = await listRunsTool({});

      expect(result.runs).toHaveLength(1);
      expect(result.runs[0]?.loopId).toBe("loop_cockpit");
      expect(result.runs[0]?.pressure).toBe("healthy");
      expect(result.runs[0]?.costUsd).toBe(1.25);
    });
  });

  it("loads a run attempt verification result and dossier without mutating state", async () => {
    await withRunsRoot(async (runsRoot) => {
      await writeLoop(runsRoot);

      const run = await getRunTool({ loopId: "loop_cockpit" });
      const attempt = await getAttemptTool({ loopId: "loop_cockpit", attemptIndex: 1 });
      const verification = await getVerificationResultsTool({ loopId: "loop_cockpit" });
      const dossier = await runDossierTool({ loopId: "loop_cockpit" });

      expect(run.task.objective).toBe("Expose read-only run evidence");
      expect(attempt.summary).toBe("First verifier pass.");
      expect(verification.results[0]?.passed).toBe(true);
      expect(dossier.sections.map((section) => section.kind)).toEqual([
        "summary",
        "task",
        "budget",
        "attempts",
        "verification"
      ]);
    });
  });
});
