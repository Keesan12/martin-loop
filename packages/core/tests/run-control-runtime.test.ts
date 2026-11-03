import { describe, expect, it, vi } from "vitest";

import { runMartin, type MartinAdapter } from "../src/index.js";

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("cooperative run controls", () => {
  it("does not launch an adapter while a durable pause is awaiting its matching continue", async () => {
    let continued = false;
    let finishAttempt!: () => void;
    const mayFinish = new Promise<void>((resolve) => { finishAttempt = resolve; });
    const execute = vi.fn<MartinAdapter["execute"]>(async () => {
      await mayFinish;
      return {
        status: "completed",
        summary: "completed after continue",
        verification: { passed: true, summary: "verified" },
        usage: { actualUsd: 0, tokensIn: 0, tokensOut: 0 }
      };
    });
    const pause = {
      controlId: "ctl_pause_1",
      loopId: "loop_controlled",
      action: "pause" as const,
      requestedAt: "2026-10-29T12:00:00.000Z",
      principal: "local_mcp_client" as const,
      receiptHash: "1".repeat(64)
    };
    const applications: Array<{ action: string; controlId: string }> = [];
    let pauseApplied!: () => void;
    const applied = new Promise<void>((resolve) => { pauseApplied = resolve; });
    const runControlSource = {
      async poll() {
        return continued
          ? {
              pause: undefined,
              continuedBy: {
                controlId: "ctl_continue_1",
                loopId: "loop_controlled",
                action: "continue" as const,
                expectedPreviousControlId: pause.controlId,
                requestedAt: "2026-10-29T12:00:01.000Z",
                principal: "local_mcp_client" as const,
                receiptHash: "2".repeat(64)
              }
            }
          : { pause };
      },
      async recordApplication(application: { action: string; controlId: string }) {
        applications.push(application);
        if (application.action === "pause_applied") pauseApplied();
      }
    };
    const adapter: MartinAdapter = {
      adapterId: "direct:controlled",
      kind: "direct-provider",
      label: "Controlled test adapter",
      execute,
      metadata: {
        providerId: "test",
        transport: "http",
        capabilities: { workspaceMutations: false }
      }
    };

    const run = runMartin({
      workspaceId: "ws",
      projectId: "proj",
      task: {
        title: "controlled run",
        objective: "prove pause behavior",
        verificationPlan: []
      },
      budget: { maxUsd: 1, softLimitUsd: 0.8, maxIterations: 1 },
      adapter,
      idFactory: (prefix) => prefix === "loop" ? "loop_controlled" : `${prefix}_test`,
      runControlSource,
      runControlPollIntervalMs: 5
    } as Parameters<typeof runMartin>[0]);

    await applied;
    const launchesBeforeContinue = execute.mock.calls.length;
    continued = true;
    finishAttempt();
    await run;

    expect(launchesBeforeContinue).toBe(0);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(applications.map(({ action }) => action)).toEqual(["pause_applied", "continue_applied"]);
  });

  it("applies a mid-attempt pause only at the next safe attempt boundary", async () => {
    let pauseRequested = false;
    let continued = false;
    let firstStarted!: () => void;
    let finishFirst!: () => void;
    const firstAttemptStarted = new Promise<void>((resolve) => { firstStarted = resolve; });
    const mayFinishFirst = new Promise<void>((resolve) => { finishFirst = resolve; });
    let firstSignal: AbortSignal | undefined;
    let callCount = 0;
    const execute = vi.fn<MartinAdapter["execute"]>(async (request) => {
      callCount += 1;
      if (callCount === 1) {
        firstSignal = request.signal;
        firstStarted();
        await mayFinishFirst;
        return {
          status: "failed",
          summary: "retry required",
          verification: { passed: false, summary: "not yet verified" },
          usage: { actualUsd: 0, tokensIn: 0, tokensOut: 0 }
        };
      }
      return {
        status: "completed",
        summary: "completed after continue",
        verification: { passed: true, summary: "verified" },
        usage: { actualUsd: 0, tokensIn: 0, tokensOut: 0 }
      };
    });
    const pause = {
      controlId: "ctl_pause_mid_attempt",
      loopId: "loop_mid_attempt_control",
      action: "pause" as const,
      requestedAt: "2026-10-29T12:00:00.000Z",
      principal: "local_mcp_client" as const,
      receiptHash: "3".repeat(64)
    };
    const applications: string[] = [];
    const source = {
      async poll() {
        if (!pauseRequested) return {};
        if (!continued) return { pause };
        return {
          continuedBy: {
            controlId: "ctl_continue_mid_attempt",
            loopId: pause.loopId,
            action: "continue" as const,
            expectedPreviousControlId: pause.controlId,
            requestedAt: "2026-10-29T12:00:01.000Z",
            principal: "local_mcp_client" as const,
            receiptHash: "4".repeat(64)
          }
        };
      },
      async recordApplication(application: { action: string }) {
        applications.push(application.action);
      }
    };
    const adapter: MartinAdapter = {
      adapterId: "direct:controlled",
      kind: "direct-provider",
      label: "Controlled test adapter",
      execute,
      metadata: {
        providerId: "test",
        transport: "http",
        capabilities: { workspaceMutations: false }
      }
    };

    const run = runMartin({
      workspaceId: "ws",
      projectId: "proj",
      task: { title: "controlled retry", objective: "pause between attempts", verificationPlan: [] },
      budget: { maxUsd: 1, softLimitUsd: 0.8, maxIterations: 2 },
      adapter,
      idFactory: (prefix) => prefix === "loop" ? pause.loopId : `${prefix}_${callCount}`,
      runControlSource: source,
      runControlPollIntervalMs: 5
    } as Parameters<typeof runMartin>[0]);

    await firstAttemptStarted;
    pauseRequested = true;
    finishFirst();
    await delay(30);
    const launchesWhilePaused = execute.mock.calls.length;
    const abortedWhilePaused = firstSignal?.aborted;
    continued = true;
    await run;

    expect(launchesWhilePaused).toBe(1);
    expect(abortedWhilePaused).toBe(false);
    expect(execute).toHaveBeenCalledTimes(2);
    expect(applications).toEqual(["pause_applied", "continue_applied"]);
  });

  it("releases a paused waiter when cancellation becomes authoritative", async () => {
    const pause = {
      controlId: "ctl_pause_cancelled",
      loopId: "loop_pause_cancelled",
      action: "pause" as const,
      requestedAt: "2026-10-29T12:00:00.000Z",
      principal: "local_mcp_client" as const,
      receiptHash: "5".repeat(64)
    };
    let cancelled = false;
    let pauseApplied!: () => void;
    const applied = new Promise<void>((resolve) => { pauseApplied = resolve; });
    const execute = vi.fn<MartinAdapter["execute"]>();
    const run = runMartin({
      workspaceId: "ws",
      projectId: "proj",
      task: { title: "cancel paused run", objective: "cancel safely", verificationPlan: [] },
      budget: { maxUsd: 1, softLimitUsd: 0.8, maxIterations: 1 },
      adapter: {
        adapterId: "direct:never-launched",
        kind: "direct-provider",
        label: "Never launched test adapter",
        execute,
        metadata: { providerId: "test", transport: "http", capabilities: { workspaceMutations: false } }
      },
      idFactory: (prefix) => prefix === "loop" ? pause.loopId : `${prefix}_test`,
      runControlSource: {
        // Mirrors the production file source: cancellation is authoritative
        // and clears the cooperative pause/continue snapshot.
        async poll() { return cancelled ? {} : { pause }; },
        async recordApplication(application: { action: string }) {
          if (application.action === "pause_applied") pauseApplied();
        }
      },
      runControlPollIntervalMs: 5,
      exitSignalPollIntervalMs: 5,
      exitSignalSource: {
        async poll(runId: string) {
          return cancelled
            ? {
                signals: [{
                  schemaVersion: "exit-signal/1" as const,
                  kind: "human_interrupt" as const,
                  runId,
                  requestedAt: "2026-10-29T12:00:01.000Z",
                  requestedBy: "operator",
                  reason: "cancel paused run"
                }],
                diagnostics: []
              }
            : { signals: [], diagnostics: [] };
        }
      }
    } as Parameters<typeof runMartin>[0]);

    await applied;
    cancelled = true;
    const result = await run;

    expect(execute).not.toHaveBeenCalled();
    expect(result.decision.lifecycleState).toBe("human_escalation");
    expect(result.decision.reason).toMatch(/cancel paused run|human_interrupt/iu);
  });

  it("continues enforcing the wall-clock budget while paused", async () => {
    const execute = vi.fn<MartinAdapter["execute"]>();
    const result = await runMartin({
      workspaceId: "ws",
      projectId: "proj",
      task: { title: "bounded pause", objective: "keep wall clock authoritative", verificationPlan: [] },
      budget: { maxUsd: 1, softLimitUsd: 0.8, maxIterations: 1 },
      adapter: {
        adapterId: "direct:never-launched",
        kind: "direct-provider",
        label: "Never launched test adapter",
        execute,
        metadata: { providerId: "test", transport: "http", capabilities: { workspaceMutations: false } }
      },
      runControlSource: {
        async poll(runId: string) {
          return {
            pause: {
              controlId: "ctl_wall_clock_pause",
              loopId: runId,
              action: "pause" as const,
              requestedAt: "2026-10-29T12:00:00.000Z",
              principal: "local_mcp_client" as const,
              receiptHash: "6".repeat(64)
            }
          };
        },
        async recordApplication() {}
      },
      runControlPollIntervalMs: 5,
      exitPolicy: { wallClock: { maxElapsedMs: 25 } }
    } as Parameters<typeof runMartin>[0]);

    expect(execute).not.toHaveBeenCalled();
    expect(result.decision.lifecycleState).toBe("wall_clock");
  });

  it("fails closed before provider launch when durable control state is corrupt", async () => {
    const execute = vi.fn<MartinAdapter["execute"]>();
    const run = runMartin({
      workspaceId: "ws",
      projectId: "proj",
      task: { title: "corrupt control", objective: "fail closed", verificationPlan: [] },
      budget: { maxUsd: 1, softLimitUsd: 0.8, maxIterations: 1 },
      adapter: {
        adapterId: "direct:never-launched",
        kind: "direct-provider",
        label: "Never launched test adapter",
        execute,
        metadata: { providerId: "test", transport: "http", capabilities: { workspaceMutations: false } }
      },
      runControlSource: {
        async poll() { throw new Error("Run control receipt integrity check failed."); },
        async recordApplication() {}
      }
    } as Parameters<typeof runMartin>[0]);

    await expect(run).rejects.toThrow("Run control receipt integrity check failed.");
    expect(execute).not.toHaveBeenCalled();
  });
});
