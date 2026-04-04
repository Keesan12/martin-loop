import { describe, expect, it } from "vitest";

import {
  appendLoopEvent,
  createLoopRecord,
  validateTelemetryBatch
} from "../src/index.js";

describe("createLoopRecord", () => {
  it("creates a normalized loop record with default lifecycle state", () => {
    const loop = createLoopRecord(
      {
        workspaceId: "ws_ops",
        projectId: "proj_runtime",
        teamId: "team_platform",
        task: {
          title: "Fix regression in payment adapter",
          objective: "Restore the billing adapter without exceeding the project budget.",
          verificationPlan: ["pnpm test", "pnpm build"]
        }
      },
      {
        now: "2026-03-27T15:00:00.000Z",
        idFactory: (prefix) => `${prefix}_001`
      }
    );

    expect(loop.loopId).toBe("loop_001");
    expect(loop.status).toBe("queued");
    expect(loop.lifecycleState).toBe("created");
    expect(loop.budget.maxUsd).toBe(25);
    expect(loop.cost.actualUsd).toBe(0);
    expect(loop.events).toHaveLength(0);
    expect(loop.attempts).toHaveLength(0);
  });
});

describe("appendLoopEvent", () => {
  it("appends an event and updates the last-modified timestamp", () => {
    const loop = createLoopRecord(
      {
        workspaceId: "ws_ops",
        projectId: "proj_runtime",
        task: {
          title: "Repair the flaky test suite",
          objective: "Repair CI without hiding failures.",
          verificationPlan: ["pnpm test"]
        }
      },
      {
        now: "2026-03-27T15:00:00.000Z",
        idFactory: (prefix) => `${prefix}_001`
      }
    );

    const next = appendLoopEvent(
      loop,
      {
        type: "run.started",
        lifecycleState: "running",
        payload: {
          adapterId: "codex-cli",
          note: "Loop picked up by the runtime."
        }
      },
      {
        now: "2026-03-27T15:00:10.000Z",
        idFactory: (prefix) => `${prefix}_002`
      }
    );

    expect(next.events).toHaveLength(1);
    expect(next.events[0]?.eventId).toBe("evt_002");
    expect(next.lifecycleState).toBe("running");
    expect(next.updatedAt).toBe("2026-03-27T15:00:10.000Z");
  });
});

describe("validateTelemetryBatch", () => {
  it("flags missing tenant identifiers and negative spend", () => {
    const result = validateTelemetryBatch({
      workspaceId: "",
      projectId: "proj_runtime",
      loops: [
        {
          loopId: "loop_bad",
          status: "running",
          lifecycleState: "running",
          cost: {
            actualUsd: -2,
            avoidedUsd: 4,
            tokensIn: 100,
            tokensOut: 25
          }
        }
      ]
    });

    expect(result.ok).toBe(false);
    expect(result.errors).toEqual(
      expect.arrayContaining([
        "workspaceId is required",
        "loop[0].cost.actualUsd must be greater than or equal to 0"
      ])
    );
  });
});
