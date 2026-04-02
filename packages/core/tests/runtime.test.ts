import { describe, expect, it } from "vitest";

import { createLoopRecord, type LoopAttempt } from "@martin/contracts";

import {
  classifyFailure,
  compilePromptPacket,
  distillContext,
  evaluateAttemptPolicy,
  evaluateCostGovernor,
  inferExit,
  runMartin,
  type CostGovernorState,
  type MartinAdapter,
  type MartinAdapterRequest
} from "../src/index.js";

describe("distillContext", () => {
  it("keeps the latest attempts and exposes the remaining budget envelope", () => {
    const loop = createLoopRecord({
      workspaceId: "ws_ops",
      projectId: "proj_runtime",
      task: {
        title: "Repair the direct provider adapter",
        objective: "Restore adapter reliability without burning the weekly budget.",
        verificationPlan: ["pnpm --filter @martin/core test", "pnpm --filter @martin/core build"]
      },
      budget: {
        maxUsd: 20,
        softLimitUsd: 12,
        maxIterations: 4,
        maxTokens: 1_000
      },
      cost: {
        actualUsd: 6,
        avoidedUsd: 0,
        tokensIn: 420,
        tokensOut: 180
      },
      attempts: [
        attempt({
          attemptId: "att_1",
          index: 1,
          summary: "Expanded scope instead of fixing the failing adapter.",
          failureClass: "scope_creep",
          intervention: "tighten_task"
        }),
        attempt({
          attemptId: "att_2",
          index: 2,
          summary: "Re-ran the same plan and missed verification again.",
          failureClass: "verification_failure",
          intervention: "run_verifier"
        }),
        attempt({
          attemptId: "att_3",
          index: 3,
          summary: "Changed the wrong condition and kept the bug alive.",
          failureClass: "logic_error",
          intervention: "change_model"
        })
      ]
    });

    const context = distillContext(loop, { maxRecentAttempts: 2 });

    expect(context.recentAttempts.map((item) => item.attemptId)).toEqual(["att_2", "att_3"]);
    expect(context.constraints.remainingBudgetUsd).toBe(14);
    expect(context.constraints.remainingIterations).toBe(1);
    expect(context.constraints.remainingTokens).toBe(400);
    expect(context.focus).toContain("Restore adapter reliability");
  });
});

describe("compilePromptPacket", () => {
  it("rebuilds a minimal deterministic packet from structured request state", () => {
    const packet = compilePromptPacket({
      loopId: "loop_1",
      attemptId: "att_2",
      context: {
        taskTitle: "Fix runtime",
        objective: "Fix the failing runtime adapter without touching the dashboard.",
        verificationPlan: ["pnpm --filter @martin/core test"],
        allowedPaths: ["packages/core/**"],
        deniedPaths: ["apps/**"],
        acceptanceCriteria: ["core tests pass"],
        focus: "Fix the adapter and keep the patch narrow.",
        remainingBudgetUsd: 4.2,
        remainingIterations: 2,
        remainingTokens: 1200
      },
      previousAttempts: [
        attempt({
          attemptId: "att_1",
          index: 1,
          summary: "Touched apps/control-plane and still failed tests.",
          failureClass: "scope_creep",
          intervention: "tighten_task"
        })
      ]
    });

    expect(packet.contract.allowedPaths).toEqual(["packages/core/**"]);
    expect(packet.contract.deniedPaths).toEqual(["apps/**"]);
    expect(packet.priorFailurePatterns).toContain("scope_creep:tighten_task");
    expect(packet.guidance).toContain("Only modify files directly required to satisfy the contract.");
    expect(packet.attemptNumber).toBe(2);
  });
});

describe("evaluateAttemptPolicy", () => {
  it("denies attempts that exceed remaining budget", () => {
    const decision = evaluateAttemptPolicy({
      request: {
        loopId: "loop_policy",
        attemptId: "att_policy",
        context: {
          taskTitle: "Repair runtime",
          objective: "Repair the runtime without touching the dashboard.",
          verificationPlan: ["pnpm test"],
          focus: "Repair runtime",
          remainingBudgetUsd: 0.2,
          remainingIterations: 2,
          remainingTokens: 1000
        },
        previousAttempts: []
      },
      projectedUsd: 0.5
    });

    expect(decision.allowed).toBe(false);
    expect(decision.recommendedIntervention).toBe("stop_loop");
  });

  it("denies oscillating loops instead of blindly retrying", () => {
    const decision = evaluateAttemptPolicy({
      request: {
        loopId: "loop_policy",
        attemptId: "att_policy",
        context: {
          taskTitle: "Repair runtime",
          objective: "Repair the runtime without touching the dashboard.",
          verificationPlan: ["pnpm test"],
          focus: "Repair runtime",
          remainingBudgetUsd: 5,
          remainingIterations: 2,
          remainingTokens: 1000
        },
        previousAttempts: [
          attempt({ attemptId: "a1", index: 1, failureClass: "logic_error" }),
          attempt({ attemptId: "a2", index: 2, failureClass: "verification_failure" }),
          attempt({ attemptId: "a3", index: 3, failureClass: "logic_error" })
        ]
      },
      projectedUsd: 0.3
    });

    expect(decision.allowed).toBe(false);
    expect(decision.recommendedIntervention).toBe("escalate_human");
  });

  it("denies materially repetitive attempts even when the failure label changes", () => {
    const decision = evaluateAttemptPolicy({
      request: {
        loopId: "loop_policy",
        attemptId: "att_policy",
        context: {
          taskTitle: "Repair runtime",
          objective: "Repair the runtime without touching the dashboard.",
          verificationPlan: ["pnpm test"],
          focus: "Repair runtime",
          remainingBudgetUsd: 5,
          remainingIterations: 2,
          remainingTokens: 1000
        },
        previousAttempts: [
          attempt({
            attemptId: "a1",
            index: 1,
            summary: "Changed budget branch and verification still failed on adapter runtime path.",
            failureClass: "logic_error"
          }),
          attempt({
            attemptId: "a2",
            index: 2,
            summary: "Changed budget branch and verification still failed on adapter runtime guard.",
            failureClass: "verification_failure"
          }),
          attempt({
            attemptId: "a3",
            index: 3,
            summary: "Changed budget branch and verification still failed on adapter runtime condition.",
            failureClass: "logic_error"
          })
        ]
      },
      projectedUsd: 0.25
    });

    expect(decision.allowed).toBe(false);
    expect(decision.recommendedIntervention).toBe("escalate_human");
  });
});

describe("classifyFailure", () => {
  it("detects repeated environment mismatches and recommends switching adapters", () => {
    const assessment = classifyFailure({
      attempts: [
        attempt({
          attemptId: "att_1",
          index: 1,
          summary: "pnpm was missing from PATH in the CLI runner.",
          failureClass: "environment_mismatch"
        }),
        attempt({
          attemptId: "att_2",
          index: 2,
          summary: "node was missing from PATH in the CLI runner.",
          failureClass: "environment_mismatch"
        })
      ],
      result: {
        status: "failed",
        summary: "The adapter could not find pnpm in PATH.",
        usage: {
          actualUsd: 0.12,
          tokensIn: 110,
          tokensOut: 45
        },
        verification: {
          passed: false,
          summary: "pnpm command not found"
        },
        failure: {
          message: "ENOENT: pnpm: command not found"
        }
      }
    });

    expect(assessment.failureClass).toBe("environment_mismatch");
    expect(assessment.retryable).toBe(false);
    expect(assessment.recommendedIntervention).toBe("switch_adapter");
  });
});

describe("evaluateCostGovernor", () => {
  it("warns at the soft limit before hard-stopping the run", () => {
    const state = evaluateCostGovernor({
      budget: {
        maxUsd: 10,
        softLimitUsd: 8,
        maxIterations: 4,
        maxTokens: 1_000
      },
      cost: {
        actualUsd: 8.5,
        avoidedUsd: 0,
        tokensIn: 310,
        tokensOut: 125
      },
      attemptsUsed: 2
    });

    expect(state.pressure).toBe("soft_limit");
    expect(state.shouldStop).toBe(false);
    expect(state.remainingBudgetUsd).toBeCloseTo(1.5);
    expect(state.recommendedIntervention).toBe("compress_context");
  });
});

describe("inferExit", () => {
  it("stops the loop when the same logic failure keeps repeating", () => {
    const decision = inferExit({
      loop: {
        budget: {
          maxUsd: 20,
          softLimitUsd: 12,
          maxIterations: 4,
          maxTokens: 1_000
        },
        cost: {
          actualUsd: 6,
          avoidedUsd: 0,
          tokensIn: 400,
          tokensOut: 120
        },
        attempts: [
          attempt({
            attemptId: "att_1",
            index: 1,
            summary: "Patched the wrong function.",
            failureClass: "logic_error"
          }),
          attempt({
            attemptId: "att_2",
            index: 2,
            summary: "Patched the wrong function again.",
            failureClass: "logic_error"
          })
        ]
      },
      lastResult: {
        status: "failed",
        summary: "The fix still touches the wrong function.",
        usage: {
          actualUsd: 0.4,
          tokensIn: 80,
          tokensOut: 50
        },
        verification: {
          passed: false,
          summary: "Regression still failing"
        }
      },
      lastFailure: {
        failureClass: "logic_error",
        rationale: "Two recent attempts show the same wrong code path.",
        retryable: true,
        recommendedIntervention: "change_model"
      },
      costState: healthyCostState()
    });

    expect(decision.shouldExit).toBe(true);
    expect(decision.lifecycleState).toBe("diminishing_returns");
    expect(decision.reason).toContain("logic_error");
  });
});

describe("runMartin", () => {
  it("records a completed run when the adapter returns a verified result", async () => {
    const timestamps = createTimestampSource([
      "2026-03-27T16:00:00.000Z",
      "2026-03-27T16:00:01.000Z",
      "2026-03-27T16:00:02.000Z",
      "2026-03-27T16:00:03.000Z",
      "2026-03-27T16:00:04.000Z",
      "2026-03-27T16:00:05.000Z"
    ]);

    let requestSeen: MartinAdapterRequest | undefined;

    const adapter: MartinAdapter = {
      adapterId: "direct:test",
      kind: "direct-provider",
      label: "Direct test adapter",
      metadata: {
        providerId: "openai",
        model: "gpt-5-mini"
      },
      async execute(request) {
        requestSeen = request;

        return {
          status: "completed",
          summary: "Produced the expected fix and passed verification.",
          usage: {
            actualUsd: 1.2,
            tokensIn: 220,
            tokensOut: 180
          },
          verification: {
            passed: true,
            summary: "pnpm --filter @martin/core test passed"
          }
        };
      }
    };

    const result = await runMartin({
      workspaceId: "ws_ops",
      projectId: "proj_runtime",
      task: {
        title: "Repair the runtime adapter",
        objective: "Ship a verified runtime fix without exceeding the alpha budget.",
        verificationPlan: ["pnpm --filter @martin/core test"]
      },
      budget: {
        maxUsd: 10,
        softLimitUsd: 6,
        maxIterations: 3,
        maxTokens: 2_000
      },
      adapter,
      now: timestamps,
      idFactory: createIdFactory()
    });

    expect(requestSeen?.context.taskTitle).toBe("Repair the runtime adapter");
    expect(result.loop.status).toBe("completed");
    expect(result.loop.lifecycleState).toBe("completed");
    expect(result.loop.attempts).toHaveLength(1);
    expect(result.loop.cost.actualUsd).toBe(1.2);
    expect(result.loop.events.map((event) => event.type)).toEqual(
      expect.arrayContaining([
        "run.started",
        "attempt.started",
        "attempt.completed",
        "verification.completed",
        "run.completed"
      ])
    );
    expect(result.decision.lifecycleState).toBe("completed");
  });

  it("exits on budget pressure after repeated failed attempts", async () => {
    const timestamps = createTimestampSource([
      "2026-03-27T16:10:00.000Z",
      "2026-03-27T16:10:01.000Z",
      "2026-03-27T16:10:02.000Z",
      "2026-03-27T16:10:03.000Z",
      "2026-03-27T16:10:04.000Z",
      "2026-03-27T16:10:05.000Z",
      "2026-03-27T16:10:06.000Z",
      "2026-03-27T16:10:07.000Z",
      "2026-03-27T16:10:08.000Z",
      "2026-03-27T16:10:09.000Z"
    ]);

    let attemptsSeen = 0;

    const adapter: MartinAdapter = {
      adapterId: "direct:budget-test",
      kind: "direct-provider",
      label: "Budget burn adapter",
      metadata: {
        providerId: "openai",
        model: "gpt-5-mini"
      },
      async execute() {
        attemptsSeen += 1;

        return {
          status: "failed",
          summary: "Spent budget without resolving the regression.",
          usage: {
            actualUsd: 6,
            tokensIn: 100,
            tokensOut: 60
          },
          verification: {
            passed: false,
            summary: "Regression still failing"
          },
          failure: {
            message: "Budget exhausted before the fix stabilized."
          }
        };
      }
    };

    const result = await runMartin({
      workspaceId: "ws_ops",
      projectId: "proj_runtime",
      task: {
        title: "Repair the runtime adapter",
        objective: "Stop the loop when the budget no longer supports a credible attempt.",
        verificationPlan: ["pnpm --filter @martin/core test"]
      },
      budget: {
        maxUsd: 10,
        softLimitUsd: 8,
        maxIterations: 5,
        maxTokens: 2_000
      },
      adapter,
      now: timestamps,
      idFactory: createIdFactory()
    });

    expect(attemptsSeen).toBe(2);
    expect(result.loop.status).toBe("exited");
    expect(result.loop.lifecycleState).toBe("budget_exit");
    expect(result.loop.events.map((event) => event.type)).toContain("budget.updated");
    expect(result.decision.shouldExit).toBe(true);
  });
});

function attempt(overrides: Partial<LoopAttempt> & Pick<LoopAttempt, "attemptId" | "index">): LoopAttempt {
  const nextAttempt: LoopAttempt = {
    attemptId: overrides.attemptId,
    index: overrides.index,
    adapterId: overrides.adapterId ?? "adapter_stub",
    model: overrides.model ?? "gpt-5-mini",
    startedAt: overrides.startedAt ?? "2026-03-27T15:00:00.000Z"
  };

  if (overrides.completedAt) {
    nextAttempt.completedAt = overrides.completedAt;
  }

  if (overrides.summary) {
    nextAttempt.summary = overrides.summary;
  }

  if (overrides.failureClass) {
    nextAttempt.failureClass = overrides.failureClass;
  }

  if (overrides.intervention) {
    nextAttempt.intervention = overrides.intervention;
  }

  return nextAttempt;
}

function healthyCostState(): CostGovernorState {
  return {
    pressure: "healthy",
    shouldStop: false,
    remainingBudgetUsd: 14,
    remainingIterations: 2,
    remainingTokens: 600
  };
}

function createTimestampSource(values: string[]): () => string {
  let index = 0;

  return () => {
    const next = values[index];
    index += 1;

    return next ?? values.at(-1) ?? "2026-03-27T00:00:00.000Z";
  };
}

function createIdFactory(): (prefix: string) => string {
  let sequence = 0;

  return (prefix: string) => {
    sequence += 1;
    return `${prefix}_${String(sequence).padStart(3, "0")}`;
  };
}
