// SPDX-FileCopyrightText: MartinLoop contributors
//
// SPDX-License-Identifier: Apache-2.0

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createLoopRecord } from "@martin/contracts";

import { martinEvalTool } from "../src/tools/eval.js";

async function withRunsRoot<T>(fn: (runsRoot: string) => Promise<T>): Promise<T> {
  const previousRunsRoot = process.env.MARTIN_RUNS_DIR;
  const runsRoot = await mkdtemp(join(tmpdir(), "martin-mcp-eval-"));
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

describe("martinEvalTool", () => {
  it("degrades to insufficient evidence when change observation mismatches repo truth", async () => {
    await withRunsRoot(async (runsRoot) => {
      const loop = {
        ...createLoopRecord({
          workspaceId: "ws_eval",
          projectId: "proj_eval",
          task: {
            title: "Evaluate a run",
            objective: "Decide if the run is safe to promote.",
            verificationPlan: ["pnpm test"],
            allowedPaths: ["src/**"]
          }
        }),
        loopId: "loop_eval_observation_mismatch",
        status: "completed",
        lifecycleState: "completed",
        attempts: [
          {
            attemptId: "att_eval",
            index: 1,
            adapterId: "direct:test",
            model: "gpt-5-mini",
            startedAt: "2026-06-07T11:00:00.000Z",
            completedAt: "2026-06-07T11:01:00.000Z"
          }
        ],
        events: [
          {
            eventId: "evt_obs",
            type: "observation.reconciled",
            timestamp: "2026-06-07T11:01:00.000Z",
            lifecycleState: "running",
            payload: {
              attemptId: "att_eval",
              attemptIndex: 1,
              observation: {
                status: "mismatch",
                summary: "Adapter-reported changes differed from repo observation.",
                adapterReported: { available: true, changedFiles: [] },
                repoObserved: { available: true, changedFiles: ["src/real.ts"] },
                effectiveChangedFiles: ["src/real.ts"],
                matchedFiles: [],
                adapterOnlyFiles: [],
                repoOnlyFiles: ["src/real.ts"]
              }
            }
          },
          {
            eventId: "evt_verify",
            type: "verification.completed",
            timestamp: "2026-06-07T11:01:01.000Z",
            lifecycleState: "completed",
            payload: {
              attemptId: "att_eval",
              attemptIndex: 1,
              passed: true,
              summary: "Verification passed."
            }
          }
        ]
      };

      await mkdir(join(runsRoot, loop.loopId), { recursive: true });
      await writeFile(join(runsRoot, loop.loopId, "loop-record.json"), JSON.stringify(loop), "utf8");

      const result = await martinEvalTool({ loopId: loop.loopId });

      expect(result.grade).toBe("insufficient_evidence");
      expect(result.checks.diffDiscipline).toBe("failed");
      expect(result.checks.regressionRisk).toBe("warning");
      expect(result.warnings).toContain(
        "Change observation mismatch: adapter-reported files differ from repo-observed files."
      );
    });
  });
});
