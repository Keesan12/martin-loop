import { describe, expect, it } from "vitest";

import {
  appendLoopEvent,
  createLoopRecord,
  validateTelemetryBatch
} from "../src/index.js";
import type { TerminationEnvelopeV1 } from "../src/index.js";

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

// ─── D5: Termination envelope receipt integration ───────────────────────────

const FIXTURE_ENVELOPE: TerminationEnvelopeV1 = {
  schemaVersion: "termination/1",
  class: "operational_exit",
  exit: {
    schemaVersion: "exit-evaluation/1",
    policyVersion: "exit-policy/1",
    shouldExit: true,
    primary: "wall_clock",
    matched: ["wall_clock"],
    phase: "post_attempt",
    evaluatedAt: "2026-07-29T00:00:00.000Z",
    matches: [
      {
        kind: "wall_clock",
        reason: "Wall-clock limit reached (3600s).",
        evidence: {}
      }
    ]
  }
};

const BASE_DRAFT = {
  workspaceId: "ws_d5",
  projectId: "proj_termination",
  task: {
    title: "D5 termination receipt test",
    objective: "Prove envelope survives create→read round-trip.",
    verificationPlan: ["vitest run"]
  }
};

describe("D5 — terminationEnvelope on LoopRecord", () => {
  it("createLoopRecord round-trips terminationEnvelope from draft", () => {
    const loop = createLoopRecord(
      { ...BASE_DRAFT, terminationEnvelope: FIXTURE_ENVELOPE },
      { now: "2026-07-29T00:00:00.000Z", idFactory: (p) => `${p}_d5` }
    );
    expect(loop.terminationEnvelope).toEqual(FIXTURE_ENVELOPE);
    expect(loop.terminationEnvelope?.class).toBe("operational_exit");
  });

  it("createLoopRecord without terminationEnvelope leaves field absent", () => {
    const loop = createLoopRecord(BASE_DRAFT, {
      now: "2026-07-29T00:00:00.000Z",
      idFactory: (p) => `${p}_d5`
    });
    expect(loop.terminationEnvelope).toBeUndefined();
  });

  it("appendLoopEvent with run.terminated produces exited status", () => {
    const loop = createLoopRecord(BASE_DRAFT, {
      now: "2026-07-29T00:00:00.000Z",
      idFactory: (p) => `${p}_d5`
    });
    const terminated = appendLoopEvent(
      loop,
      {
        type: "run.terminated",
        lifecycleState: "wall_clock",
        payload: { selectedExit: "wall_clock", matchedExits: ["wall_clock"] }
      },
      { now: "2026-07-29T00:01:00.000Z", idFactory: (p) => `${p}_d5t` }
    );
    expect(terminated.status).toBe("exited");
    expect(terminated.lifecycleState).toBe("wall_clock");
    expect(terminated.events).toHaveLength(1);
    expect(terminated.events[0]?.type).toBe("run.terminated");
  });

  it("appendLoopEvent preserves terminationEnvelope through spread", () => {
    const loopWithEnvelope = createLoopRecord(
      { ...BASE_DRAFT, terminationEnvelope: FIXTURE_ENVELOPE },
      { now: "2026-07-29T00:00:00.000Z", idFactory: (p) => `${p}_d5` }
    );
    const updated = appendLoopEvent(
      loopWithEnvelope,
      { type: "run.terminated", lifecycleState: "wall_clock", payload: {} },
      { now: "2026-07-29T00:01:00.000Z", idFactory: (p) => `${p}_d5t` }
    );
    expect(updated.terminationEnvelope).toEqual(FIXTURE_ENVELOPE);
  });
});

describe("D5 — new LoopLifecycleState values", () => {
  it.each([
    ["wall_clock", "wall_clock"],
    ["error_threshold", "error_threshold"],
    ["external_event", "external_event"]
  ] as const)(
    "appendLoopEvent accepts lifecycleState %s and preserves it",
    (lifecycleState, _expectedLifecycleState) => {
      const loop = createLoopRecord(BASE_DRAFT, {
        now: "2026-07-29T00:00:00.000Z",
        idFactory: (p) => `${p}_d5`
      });
      const result = appendLoopEvent(
        loop,
        { type: "run.terminated", lifecycleState, payload: {} },
        { now: "2026-07-29T00:01:00.000Z", idFactory: (p) => `${p}_lc` }
      );
      expect(result.lifecycleState).toBe(lifecycleState);
      expect(result.status).toBe("exited");
    }
  );
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
