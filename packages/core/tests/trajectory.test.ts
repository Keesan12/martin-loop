import { describe, expect, it } from "vitest";

import {
  assessTrajectory,
  decideCircuitBreak,
  evaluateAttemptPolicy,
  type MartinAdapterRequest
} from "../src/index.js";

describe("trajectory heuristics", () => {
  it("blocks oscillating loops before another attempt is spent", () => {
    const decision = decideCircuitBreak({
      objective: "Repair the runtime budget guard without touching release automation.",
      verificationPlan: ["pnpm --filter @martin/core test"],
      remainingIterations: 2,
      attempts: [
        { index: 1, failureClass: "logic_error", summary: "Patched the wrong runtime branch." },
        { index: 2, failureClass: "verification_failure", summary: "Patched the assertion but verification still failed." },
        { index: 3, failureClass: "logic_error", summary: "Returned to the wrong runtime branch again." }
      ]
    });

    expect(decision.shouldStop).toBe(true);
    expect(decision.assessment.status).toBe("stalled");
    expect(decision.assessment.signals.map((signal) => signal.code)).toContain("failure_oscillation");
    expect(decision.recommendedIntervention).toBe("escalate_human");
  });

  it("flags objective drift when repeated attempts stop overlapping the original task", () => {
    const assessment = assessTrajectory({
      objective: "Fix the auth verifier and keep the patch inside src/auth.",
      verificationPlan: ["pnpm test --filter auth"],
      attempts: [
        {
          index: 1,
          summary: "Tweaked dashboard charts and navigation spacing instead of fixing auth verifier state.",
          failureClass: "scope_creep"
        },
        {
          index: 2,
          summary: "Kept changing dashboard layouts and sidebar polish while auth verifier remained broken.",
          failureClass: "scope_creep"
        }
      ]
    });

    expect(assessment.status).toBe("drifting");
    expect(assessment.signals.map((signal) => signal.code)).toContain("objective_drift");
    expect(assessment.recommendedIntervention).toBe("tighten_task");
  });

  it("threads trajectory assessment through attempt admission", () => {
    const request: MartinAdapterRequest = {
      loopId: "loop_trajectory",
      workspaceId: "ws_trajectory",
      attemptId: "att_004",
      context: {
        taskTitle: "Repair the runtime guard",
        objective: "Repair the runtime guard without touching release automation.",
        verificationPlan: ["pnpm --filter @martin/core test"],
        focus: "Repair the runtime guard.",
        remainingBudgetUsd: 4,
        remainingIterations: 2,
        remainingTokens: 1200
      },
      previousAttempts: [
        {
          attemptId: "att_001",
          index: 1,
          adapterId: "codex-cli",
          model: "gpt-5-codex",
          startedAt: "2026-06-07T17:00:00.000Z",
          summary: "Patched the wrong runtime branch.",
          failureClass: "logic_error"
        },
        {
          attemptId: "att_002",
          index: 2,
          adapterId: "codex-cli",
          model: "gpt-5-codex",
          startedAt: "2026-06-07T17:05:00.000Z",
          summary: "Patched the assertion but verification still failed.",
          failureClass: "verification_failure"
        },
        {
          attemptId: "att_003",
          index: 3,
          adapterId: "codex-cli",
          model: "gpt-5-codex",
          startedAt: "2026-06-07T17:10:00.000Z",
          summary: "Returned to the wrong runtime branch again.",
          failureClass: "logic_error"
        }
      ]
    };

    const decision = evaluateAttemptPolicy({
      request,
      projectedUsd: 0.3
    });

    expect(decision.allowed).toBe(false);
    expect(decision.trajectoryAssessment?.status).toBe("stalled");
    expect(decision.circuitBreakDecision?.shouldStop).toBe(true);
    expect(decision.recommendedIntervention).toBe("escalate_human");
  });
});
