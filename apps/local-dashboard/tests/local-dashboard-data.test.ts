import { describe, expect, it } from "vitest";
import {
  createEmptyOperatorData,
  mapRunArtifactsToDashboardData
} from "../data/live-run-data.js";

describe("local operator dashboard data", () => {
  it("returns an honest empty state when no runs have been persisted", () => {
    const empty = createEmptyOperatorData();

    expect(empty.currentRun.title).toBe("No runs yet");
    expect(empty.seedLabel).toBe("No runs yet");
    expect(empty.replayResume.nextAction).toContain("Start a run");
  });

  it("maps persisted run artifacts into real dashboard data", () => {
    const mapped = mapRunArtifactsToDashboardData({
      contract: {
        runId: "loop_123",
        workspaceId: "ws_martin",
        projectId: "proj_finops",
        task: {
          title: "Repair flaky CI",
          objective: "Restore a passing test gate.",
          verificationPlan: ["pnpm test"]
        },
        budget: {
          maxUsd: 8,
          softLimitUsd: 5,
          maxIterations: 3,
          maxTokens: 20000
        },
        createdAt: "2026-04-02T10:00:00.000Z"
      },
      state: {
        phase: "VERIFY",
        activeModel: "gpt-5.4-mini"
      },
      ledger: [
        {
          kind: "attempt.admitted",
          runId: "loop_123",
          attemptIndex: 1,
          timestamp: "2026-04-02T10:00:01.000Z",
          payload: {
            adapterId: "agent:codex",
            model: "gpt-5.4-mini"
          }
        },
        {
          kind: "patch.generated",
          runId: "loop_123",
          attemptIndex: 1,
          timestamp: "2026-04-02T10:00:20.000Z",
          payload: {
            summary: "Applied a targeted CI fix."
          }
        },
        {
          kind: "verification.completed",
          runId: "loop_123",
          attemptIndex: 1,
          timestamp: "2026-04-02T10:00:40.000Z",
          payload: {
            passed: true,
            summary: "pnpm test passed."
          }
        },
        {
          kind: "budget.settled",
          runId: "loop_123",
          attemptIndex: 1,
          timestamp: "2026-04-02T10:00:41.000Z",
          payload: {
            actualUsd: 1.5,
            estimatedUsd: 1.7,
            tokensIn: 320,
            tokensOut: 140,
            model: "gpt-5.4-mini"
          }
        },
        {
          kind: "run.exited",
          runId: "loop_123",
          timestamp: "2026-04-02T10:00:42.000Z",
          payload: {
            lifecycleState: "completed",
            reason: "Task verified."
          }
        }
      ]
    });

    expect(mapped.currentRun.loopId).toBe("loop_123");
    expect(mapped.currentRun.state).toBe("completed");
    expect(mapped.budget.spentUsd).toBe(1.5);
    expect(mapped.verifier.lastGate.status).toBe("passed");
    expect(mapped.benchmarkLab.summary[0]?.value).toBe("$1.50");
  });
});
