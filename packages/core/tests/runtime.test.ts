import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createLoopRecord, type LoopAttempt } from "@martin/contracts";

import {
  classifyFailure,
  compilePromptPacket,
  createFileRunStore,
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

  it("rejects an attempt during budget preflight before the adapter runs and records the ledger source", async () => {
    const runsRoot = await mkdtemp(join(tmpdir(), "martin-preflight-"));
    const store = createFileRunStore({ runsRoot });
    let adapterExecutions = 0;

    const adapter: MartinAdapter = {
      adapterId: "direct:preflight-test",
      kind: "direct-provider",
      label: "Preflight test adapter",
      metadata: {
        providerId: "openai",
        model: "gpt-5-mini"
      },
      async execute() {
        adapterExecutions += 1;

        return {
          status: "completed",
          summary: "This should never run when preflight rejects the attempt.",
          usage: {
            actualUsd: 0.1,
            tokensIn: 10,
            tokensOut: 10
          },
          verification: {
            passed: true,
            summary: "Unexpected success"
          }
        };
      }
    };

    const result = await runMartin({
      workspaceId: "ws_ops",
      projectId: "proj_runtime",
      task: {
        title: "Repair the runtime adapter",
        objective:
          "Keep this objective intentionally long so a low budget preflight estimate must reject before execution occurs and the adapter is never called.",
        verificationPlan: ["pnpm --filter @martin/core test"]
      },
      budget: {
        maxUsd: 0.01,
        softLimitUsd: 0.005,
        maxIterations: 2,
        maxTokens: 2_000
      },
      adapter,
      store,
      now: createTimestampSource([
        "2026-04-02T12:00:00.000Z",
        "2026-04-02T12:00:01.000Z",
        "2026-04-02T12:00:02.000Z"
      ]),
      idFactory: createIdFactory()
    });

    const ledger = await readFile(join(runsRoot, result.loop.loopId, "ledger.jsonl"), "utf8");

    expect(adapterExecutions).toBe(0);
    expect(result.loop.attempts).toHaveLength(0);
    expect(result.decision.lifecycleState).toBe("budget_exit");
    expect(ledger).toContain('"attempt.rejected"');
    expect(ledger).toContain('"source":"budget_preflight"');
  });

  it("emits safety.violations_found before run.exited when the command leash blocks execution", async () => {
    const runsRoot = await mkdtemp(join(tmpdir(), "martin-safety-command-"));
    const store = createFileRunStore({ runsRoot });
    let adapterExecutions = 0;

    const adapter: MartinAdapter = {
      adapterId: "direct:safety-command",
      kind: "direct-provider",
      label: "Safety command adapter",
      metadata: {
        providerId: "openai",
        model: "gpt-5-mini"
      },
      async execute() {
        adapterExecutions += 1;
        return {
          status: "completed",
          summary: "Unexpectedly executed.",
          usage: {
            actualUsd: 0.1,
            tokensIn: 10,
            tokensOut: 10
          },
          verification: {
            passed: true,
            summary: "Unexpected verification pass"
          }
        };
      }
    };

    const result = await runMartin({
      workspaceId: "ws_ops",
      projectId: "proj_runtime",
      task: {
        title: "Repair the runtime adapter",
        objective: "Never run destructive verifier commands.",
        verificationPlan: ["pnpm --filter @martin/core test", "rm -rf ."]
      },
      budget: {
        maxUsd: 10,
        softLimitUsd: 8,
        maxIterations: 2,
        maxTokens: 2_000
      },
      adapter,
      store,
      now: createTimestampSource([
        "2026-04-02T13:00:00.000Z",
        "2026-04-02T13:00:01.000Z",
        "2026-04-02T13:00:02.000Z"
      ]),
      idFactory: createIdFactory()
    });

    const ledger = await readLedger(runsRoot, result.loop.loopId);
    const safetyIndex = ledger.findIndex((entry) => entry.kind === "safety.violations_found");
    const exitIndex = ledger.findIndex((entry) => entry.kind === "run.exited");

    expect(adapterExecutions).toBe(0);
    expect(result.decision.lifecycleState).toBe("human_escalation");
    expect(safetyIndex).toBeGreaterThanOrEqual(0);
    expect(exitIndex).toBeGreaterThan(safetyIndex);
    expect(ledger[safetyIndex]?.payload).toMatchObject({
      surface: "command",
      blocked: true
    });
    expect(ledger[safetyIndex]?.payload.violations).toEqual(
      expect.arrayContaining(["rm -rf ."])
    );
  });

  it("discards the attempt and exits with human escalation when filesystem leash is violated", async () => {
    const runsRoot = await mkdtemp(join(tmpdir(), "martin-safety-filesystem-"));
    const repoRoot = join(runsRoot, "repo");
    await mkdir(repoRoot, { recursive: true });
    await writeFile(join(repoRoot, ".gitkeep"), "", "utf8");
    const store = createFileRunStore({ runsRoot });

    const adapter: MartinAdapter = {
      adapterId: "agent-cli:filesystem-block",
      kind: "agent-cli",
      label: "Filesystem block adapter",
      metadata: {
        providerId: "claude",
        model: "claude-sonnet-4-6"
      },
      async execute() {
        return {
          status: "completed",
          summary: "Produced a patch that touched a forbidden file.",
          usage: {
            actualUsd: 0.3,
            tokensIn: 60,
            tokensOut: 30
          },
          verification: {
            passed: true,
            summary: "pnpm test passed"
          },
          execution: {
            changedFiles: ["apps/control-plane/page.tsx"],
            diffStats: {
              filesChanged: 1,
              addedLines: 4,
              deletedLines: 1
            }
          }
        };
      }
    };

    const result = await runMartin({
      workspaceId: "ws_ops",
      projectId: "proj_runtime",
      task: {
        title: "Repair the runtime adapter",
        objective: "Keep changes confined to the core package.",
        verificationPlan: ["pnpm --filter @martin/core test"],
        repoRoot,
        allowedPaths: ["packages/core/**"]
      },
      budget: {
        maxUsd: 10,
        softLimitUsd: 8,
        maxIterations: 2,
        maxTokens: 2_000
      },
      adapter,
      store,
      now: createTimestampSource([
        "2026-04-02T13:10:00.000Z",
        "2026-04-02T13:10:01.000Z",
        "2026-04-02T13:10:02.000Z",
        "2026-04-02T13:10:03.000Z",
        "2026-04-02T13:10:04.000Z",
        "2026-04-02T13:10:05.000Z",
        "2026-04-02T13:10:06.000Z"
      ]),
      idFactory: createIdFactory()
    });

    const ledger = await readLedger(runsRoot, result.loop.loopId);
    const safetyEvent = ledger.find((entry) => entry.kind === "safety.violations_found");

    expect(result.loop.attempts).toHaveLength(1);
    expect(result.decision.lifecycleState).toBe("human_escalation");
    expect(ledger.map((entry) => entry.kind)).toContain("attempt.discarded");
    expect(safetyEvent?.payload).toMatchObject({
      surface: "filesystem",
      blocked: true,
      attemptIndex: 1
    });
  });

  it("rotates to the next adapter when switch_adapter is selected", async () => {
    let primaryExecutions = 0;
    let fallbackExecutions = 0;

    const primaryAdapter: MartinAdapter = {
      adapterId: "agent-cli:claude-primary",
      kind: "agent-cli",
      label: "Primary CLI adapter",
      metadata: {
        providerId: "claude",
        model: "claude-sonnet-4-6"
      },
      async execute() {
        primaryExecutions += 1;
        return {
          status: "failed",
          summary: "pnpm was missing from PATH in the CLI runner.",
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
        };
      }
    };

    const fallbackAdapter: MartinAdapter = {
      adapterId: "direct:openai:gpt-5-mini",
      kind: "direct-provider",
      label: "Fallback direct adapter",
      metadata: {
        providerId: "openai",
        model: "gpt-5-mini"
      },
      async execute() {
        fallbackExecutions += 1;
        return {
          status: "completed",
          summary: "Recovered with the fallback adapter and passed verification.",
          usage: {
            actualUsd: 0.4,
            tokensIn: 80,
            tokensOut: 60
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
        objective: "Use a fallback adapter if the primary environment is missing tooling.",
        verificationPlan: ["pnpm --filter @martin/core test"]
      },
      budget: {
        maxUsd: 10,
        softLimitUsd: 8,
        maxIterations: 3,
        maxTokens: 2_000
      },
      adapter: primaryAdapter,
      fallbackAdapters: [fallbackAdapter],
      now: createTimestampSource([
        "2026-04-02T13:20:00.000Z",
        "2026-04-02T13:20:01.000Z",
        "2026-04-02T13:20:02.000Z",
        "2026-04-02T13:20:03.000Z",
        "2026-04-02T13:20:04.000Z",
        "2026-04-02T13:20:05.000Z",
        "2026-04-02T13:20:06.000Z",
        "2026-04-02T13:20:07.000Z",
        "2026-04-02T13:20:08.000Z"
      ]),
      idFactory: createIdFactory()
    });

    expect(primaryExecutions).toBe(1);
    expect(fallbackExecutions).toBe(1);
    expect(result.loop.status).toBe("completed");
    expect(result.loop.attempts.map((attemptRecord) => attemptRecord.adapterId)).toEqual([
      "agent-cli:claude-primary",
      "direct:openai:gpt-5-mini"
    ]);
  });

  it("appends grounding.violations_found to ledger when patch references unindexed files", async () => {
    const { mkdtemp: mkdtempFs, mkdir: mkdirFs, writeFile: writeFileFs } = await import("node:fs/promises");
    const { tmpdir: tmpdirOs } = await import("node:os");
    const { join: joinPath } = await import("node:path");

    // Create a minimal repo for grounding — only src/real.ts exists in the index
    const repoRoot = await mkdtempFs(joinPath(tmpdirOs(), "martin-runtime-grounding-"));
    await mkdirFs(joinPath(repoRoot, "src"), { recursive: true });
    await writeFileFs(joinPath(repoRoot, "src", "real.ts"), "export const x = 1;", "utf8");

    const ledgerEvents: import("../src/index.js").LedgerEvent[] = [];
    const store: import("../src/index.js").RunStore = {
      initRun: async () => {},
      updateState: async () => {},
      appendLedger: async (_, event) => {
        ledgerEvents.push(event);
      },
      writeAttemptArtifacts: async () => {}
    };

    await runMartin({
      workspaceId: "ws-test",
      projectId: "proj-test",
      task: {
        title: "Test grounding scan",
        objective: "Check that grounding violations are persisted",
        verificationPlan: ["echo ok"],
        repoRoot,
        allowedPaths: ["src/**"]
      },
      budget: { maxUsd: 10, softLimitUsd: 8, maxIterations: 1, maxTokens: 100_000 },
      adapter: {
        adapterId: "stub",
        kind: "direct-provider",
        label: "Stub",
        metadata: { providerId: "stub", model: "stub" },
        execute: async () => ({
          status: "completed",
          summary: "done",
          usage: { actualUsd: 0.01, tokensIn: 100, tokensOut: 50 },
          verification: { passed: true, summary: "tests pass" },
          execution: {
            // Reference a file that does not exist in the grounding index
            changedFiles: ["src/ghost-new-file.ts"]
          }
        })
      },
      store
    });

    // ghost-new-file.ts is not in the grounding index, so violations_found should be logged
    const groundingEvent = ledgerEvents.find((e) => e.kind === "grounding.violations_found");
    expect(groundingEvent).toBeDefined();
    expect((groundingEvent?.payload as Record<string, unknown>)?.violationCount).toBeGreaterThan(0);
  });

  it("writes consistent admission and settlement ledger payloads across mixed adapter types", async () => {
    const runsRoot = await mkdtemp(join(tmpdir(), "martin-adapter-ledger-"));
    const store = createFileRunStore({ runsRoot });

    const cliAdapter: MartinAdapter = {
      adapterId: "agent-cli:codex",
      kind: "agent-cli",
      label: "Codex CLI adapter",
      metadata: {
        providerId: "codex",
        model: "codex",
        transport: "cli",
        capabilities: {
          preflight: true,
          usageSettlement: false,
          diffArtifacts: true,
          structuredErrors: true,
          cachingSignals: false
        }
      },
      async execute() {
        return {
          status: "failed",
          summary: "codex was unavailable in this environment.",
          usage: {
            actualUsd: 0.08,
            estimatedUsd: 0.08,
            tokensIn: 90,
            tokensOut: 20,
            provenance: "estimated"
          },
          verification: {
            passed: false,
            summary: "codex command not found"
          },
          failure: {
            message: "ENOENT: codex command not found"
          }
        };
      }
    };

    const directAdapter: MartinAdapter = {
      adapterId: "direct:openai:gpt-5-mini",
      kind: "direct-provider",
      label: "OpenAI direct adapter",
      metadata: {
        providerId: "openai",
        model: "gpt-5-mini",
        transport: "http",
        capabilities: {
          preflight: true,
          usageSettlement: true,
          diffArtifacts: false,
          structuredErrors: true,
          cachingSignals: false
        }
      },
      async execute() {
        return {
          status: "completed",
          summary: "Recovered via the direct provider path.",
          usage: {
            actualUsd: 0.32,
            tokensIn: 70,
            tokensOut: 55,
            provenance: "actual"
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
        objective: "Keep ledger payloads stable across CLI and direct adapters.",
        verificationPlan: ["pnpm --filter @martin/core test"]
      },
      budget: {
        maxUsd: 10,
        softLimitUsd: 8,
        maxIterations: 3,
        maxTokens: 2_000
      },
      adapter: cliAdapter,
      fallbackAdapters: [directAdapter],
      store,
      now: createTimestampSource([
        "2026-04-02T13:30:00.000Z",
        "2026-04-02T13:30:01.000Z",
        "2026-04-02T13:30:02.000Z",
        "2026-04-02T13:30:03.000Z",
        "2026-04-02T13:30:04.000Z",
        "2026-04-02T13:30:05.000Z",
        "2026-04-02T13:30:06.000Z",
        "2026-04-02T13:30:07.000Z",
        "2026-04-02T13:30:08.000Z"
      ]),
      idFactory: createIdFactory()
    });

    const ledger = await readLedger(runsRoot, result.loop.loopId);
    const admitted = ledger.filter((entry) => entry.kind === "attempt.admitted");
    const settled = ledger.filter((entry) => entry.kind === "budget.settled");

    expect(admitted).toHaveLength(2);
    expect(settled).toHaveLength(2);
    expect(admitted[0]?.payload).toMatchObject({
      adapterId: "agent-cli:codex",
      transport: "cli",
      providerId: "codex"
    });
    expect(admitted[1]?.payload).toMatchObject({
      adapterId: "direct:openai:gpt-5-mini",
      transport: "http",
      providerId: "openai"
    });
    expect(settled[0]?.payload).toMatchObject({
      provenance: "estimated"
    });
    expect(settled[1]?.payload).toMatchObject({
      provenance: "actual"
    });
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

async function readLedger(
  runsRoot: string,
  runId: string
): Promise<Array<{ kind: string; payload: Record<string, unknown> }>> {
  const contents = await readFile(join(runsRoot, runId, "ledger.jsonl"), "utf8");
  return contents
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { kind: string; payload: Record<string, unknown> });
}
