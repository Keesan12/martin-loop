import { describe, expect, it } from "vitest";

import { createLoopRecord } from "../../packages/contracts/src/index.js";
import {
  type BenchmarkSuite,
  runBenchmarkSuite
} from "../src/index.js";

describe("runBenchmarkSuite", () => {
  it("aggregates runner output into a benchmark report", async () => {
    const suite: BenchmarkSuite = {
      suiteId: "smoke",
      label: "Smoke",
      description: "Small benchmark suite for the CLI surface.",
      baselineAdapter: "ralphy",
      cases: [
        {
          caseId: "repair-ci",
          label: "Repair flaky CI",
          task: {
            title: "Repair flaky CI",
            objective: "Stabilize the verification gate.",
            verificationPlan: ["pnpm test"]
          },
          budget: {
            maxIterations: 3,
            maxTokens: 20000,
            maxUsd: 8,
            softLimitUsd: 4
          },
          baseline: {
            adapterId: "ralphy",
            model: "gpt-5-mini",
            strategy: "single-loop"
          },
          tags: ["ci"]
        },
        {
          caseId: "inspect-loop",
          label: "Inspect budget pressure",
          task: {
            title: "Inspect budget pressure",
            objective: "Summarize the latest loop budget risk.",
            verificationPlan: ["pnpm test"]
          },
          budget: {
            maxIterations: 2,
            maxTokens: 12000,
            maxUsd: 6,
            softLimitUsd: 3
          },
          baseline: {
            adapterId: "ralphy",
            model: "gpt-5-mini",
            strategy: "single-loop"
          },
          tags: ["inspection"]
        }
      ]
    };

    const timestamps = [
      "2026-03-27T16:00:00.000Z",
      "2026-03-27T16:00:10.000Z"
    ];

    const report = await runBenchmarkSuite(
      suite,
      async (benchmarkCase) => {
        if (benchmarkCase.caseId === "repair-ci") {
          return {
            caseId: benchmarkCase.caseId,
            status: "passed",
            durationMs: 32,
            notes: ["Recovered the verification plan."],
            loop: createLoopRecord(
              {
                workspaceId: "ws_bench",
                projectId: "proj_cli",
                status: "completed",
                lifecycleState: "completed",
                task: benchmarkCase.task,
                budget: benchmarkCase.budget,
                cost: {
                  actualUsd: 2,
                  avoidedUsd: 5,
                  tokensIn: 1500,
                  tokensOut: 550
                }
              },
              {
                now: "2026-03-27T16:00:00.000Z",
                idFactory: (prefix) => `${prefix}_001`
              }
            )
          };
        }

        return {
          caseId: benchmarkCase.caseId,
          status: "failed",
          durationMs: 48,
          notes: ["Timed out while waiting for the runtime."]
        };
      },
      {
        now: () => timestamps.shift() ?? "2026-03-27T16:00:10.000Z"
      }
    );

    expect(report.startedAt).toBe("2026-03-27T16:00:00.000Z");
    expect(report.finishedAt).toBe("2026-03-27T16:00:10.000Z");
    expect(report.summary.totalCases).toBe(2);
    expect(report.summary.passedCases).toBe(1);
    expect(report.summary.failedCases).toBe(1);
    expect(report.summary.totalDurationMs).toBe(80);
    expect(report.summary.totalActualUsd).toBe(2);
    expect(report.summary.totalAvoidedUsd).toBe(5);
    expect(report.summary.passRate).toBe(50);
  });
});
