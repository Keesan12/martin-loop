import { describe, expect, it } from "vitest";

import {
  appendLoopEvent,
  buildPortfolioSnapshot,
  createLoopRecord
} from "../src/index.js";

describe("buildPortfolioSnapshot", () => {
  it("aggregates spend, savings, active loops, failures, and average exit time", () => {
    const runningLoop = appendLoopEvent(
      createLoopRecord(
        {
          workspaceId: "ws_finance",
          projectId: "proj_saas",
          task: {
            title: "Reduce flaky CI failures",
            objective: "Stop re-running expensive loops on non-deterministic tests.",
            verificationPlan: ["pnpm test"]
          },
          cost: {
            actualUsd: 6,
            avoidedUsd: 15,
            tokensIn: 4_000,
            tokensOut: 1_000
          }
        },
        {
          now: "2026-03-27T14:00:00.000Z",
          idFactory: (prefix) => `${prefix}_100`
        }
      ),
      {
        type: "failure.classified",
        payload: {
          failureClass: "verification_failure"
        },
        lifecycleState: "running"
      },
      {
        now: "2026-03-27T14:03:00.000Z",
        idFactory: (prefix) => `${prefix}_101`
      }
    );

    const completedLoop = appendLoopEvent(
      createLoopRecord(
        {
          workspaceId: "ws_finance",
          projectId: "proj_saas",
          status: "completed",
          lifecycleState: "completed",
          task: {
            title: "Patch the diff sanitizer",
            objective: "Close a runaway diff loop before budget spill.",
            verificationPlan: ["pnpm test", "pnpm build"]
          },
          cost: {
            actualUsd: 4,
            avoidedUsd: 18,
            tokensIn: 2_000,
            tokensOut: 600
          }
        },
        {
          now: "2026-03-27T13:00:00.000Z",
          idFactory: (prefix) => `${prefix}_200`
        }
      ),
      {
        type: "run.completed",
        payload: {
          exitReason: "hard_complete"
        },
        lifecycleState: "completed"
      },
      {
        now: "2026-03-27T13:05:00.000Z",
        idFactory: (prefix) => `${prefix}_201`
      }
    );

    const snapshot = buildPortfolioSnapshot([runningLoop, completedLoop]);

    expect(snapshot.totalActualUsd).toBe(10);
    expect(snapshot.totalAvoidedUsd).toBe(33);
    expect(snapshot.activeLoops).toBe(1);
    expect(snapshot.optimizedLoops).toBe(2);
    expect(snapshot.failuresCaught).toBe(1);
    expect(snapshot.averageExitSeconds).toBe(300);
  });
});
