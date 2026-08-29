/**
 * Eight-exit evaluator tests — deterministic, pure, no I/O.
 *
 * Naming convention: test names that reference EXIT_PRECEDENCE include the
 * rationale comment from exits.ts so the reason is preserved alongside the
 * assertion (A2 fix).
 */

import { describe, expect, it } from "vitest";

import type { ExitPolicyV1, ExitSnapshotV1, ExitSignalV1, ExternalExitEvent } from "@martin/contracts";
import {
  createDefaultExitPolicy,
  evaluateExitPolicy,
  hashProgressState,
  toLegacyExitDecision,
  validateExitPolicy
} from "../src/exits";

// ─── Helpers ────────────────────────────────────────────────────────────────

const NOW_MS = 1_700_000_000_000;
const START_MS = NOW_MS - 60_000; // 60 s elapsed

function makePolicy(overrides: Partial<ExitPolicyV1> = {}): ExitPolicyV1 {
  return {
    schemaVersion: "exit-policy/1",
    goal: { verifierRequired: false, minimumScore: 0 },
    turns: { max: 10 },
    budget: { maxUsd: 10, maxTokens: 100_000 },
    wallClock: { maxElapsedMs: 30 * 60 * 1000 },
    progress: { windowSize: 3, unchangedStateLimit: 3 },
    errors: { maxConsecutive: 3 },
    humanInterrupt: { enabled: true },
    externalEvent: { enabled: true },
    ...overrides
  };
}

function makeSnapshot(overrides: Partial<ExitSnapshotV1> = {}): ExitSnapshotV1 {
  return {
    phase: "post_attempt",
    evaluatedAt: new Date(NOW_MS).toISOString(),
    runStartedAtMs: START_MS,
    nowMs: NOW_MS,
    actualUsd: 0,
    tokensUsed: 0,
    turnsUsed: 0,
    consecutiveErrors: 0,
    recentStateHashes: [],
    ...overrides
  };
}

const humanSignal: ExitSignalV1 = {
  schemaVersion: "exit-signal/1",
  runId: "run-001",
  kind: "human_interrupt",
  requestedBy: "operator",
  requestedAt: new Date(NOW_MS).toISOString(),
  reason: "Stop now"
};

const externalEvent: ExternalExitEvent = {
  source: "ci-watcher",
  event: "build_failed",
  disposition: "cancelled",
  observedAt: new Date(NOW_MS).toISOString()
};

// ─── Single-exit triggers ────────────────────────────────────────────────────

describe("evaluateExitPolicy — individual exit triggers", () => {
  it("fires goal_met when result is completed, verification passed, and score meets minimum", () => {
    const policy = makePolicy({ goal: { verifierRequired: true, minimumScore: 0.8 } });
    const snap = makeSnapshot({
      result: { status: "completed", verificationPassed: true, verifierScore: 0.9 }
    });
    const ev = evaluateExitPolicy(policy, snap);
    expect(ev.shouldExit).toBe(true);
    expect(ev.primary).toBe("goal_met");
  });

  it("does not fire goal_met when verifierRequired and verification did not pass", () => {
    const policy = makePolicy({ goal: { verifierRequired: true, minimumScore: 0 } });
    const snap = makeSnapshot({
      result: { status: "completed", verificationPassed: false, verifierScore: 0.9 }
    });
    const ev = evaluateExitPolicy(policy, snap);
    expect(ev.matched).not.toContain("goal_met");
  });

  it("does not fire goal_met when score is below minimumScore", () => {
    const policy = makePolicy({ goal: { verifierRequired: false, minimumScore: 0.95 } });
    const snap = makeSnapshot({
      result: { status: "completed", verificationPassed: true, verifierScore: 0.8 }
    });
    const ev = evaluateExitPolicy(policy, snap);
    expect(ev.matched).not.toContain("goal_met");
  });

  it("fires wall_clock when elapsed time exceeds maxElapsedMs", () => {
    const policy = makePolicy({ wallClock: { maxElapsedMs: 30_000 } }); // 30 s
    const snap = makeSnapshot({ nowMs: START_MS + 31_000 }); // 31 s elapsed
    const ev = evaluateExitPolicy(policy, snap);
    expect(ev.shouldExit).toBe(true);
    expect(ev.primary).toBe("wall_clock");
  });

  it("fires wall_clock when nowMs is at or past a deadlineAt timestamp", () => {
    const deadline = new Date(NOW_MS - 1).toISOString();
    const policy = makePolicy({ wallClock: { maxElapsedMs: 99 * 60_000, deadlineAt: deadline } });
    const snap = makeSnapshot();
    const ev = evaluateExitPolicy(policy, snap);
    expect(ev.matched).toContain("wall_clock");
  });

  it("fires budget_cap when actualUsd reaches maxUsd", () => {
    const policy = makePolicy({ budget: { maxUsd: 5, maxTokens: 1_000_000 } });
    const snap = makeSnapshot({ actualUsd: 5 });
    const ev = evaluateExitPolicy(policy, snap);
    expect(ev.shouldExit).toBe(true);
    expect(ev.primary).toBe("budget_cap");
  });

  it("fires budget_cap when tokensUsed reaches maxTokens", () => {
    const policy = makePolicy({ budget: { maxUsd: 100, maxTokens: 500 } });
    const snap = makeSnapshot({ tokensUsed: 500 });
    const ev = evaluateExitPolicy(policy, snap);
    expect(ev.matched).toContain("budget_cap");
  });

  it("does not create a token budget exit when no token cap is configured", () => {
    const policy = createDefaultExitPolicy({
      maxIterations: 3,
      maxUsd: 10,
      softLimitUsd: 7
    });
    const ev = evaluateExitPolicy(policy, makeSnapshot({ tokensUsed: 50_000_000 }));

    expect(policy.budget.maxTokens).toBeUndefined();
    expect(ev.matched).not.toContain("budget_cap");
  });

  it("fires turn_cap when turnsUsed reaches max", () => {
    const policy = makePolicy({ turns: { max: 5 } });
    const snap = makeSnapshot({ turnsUsed: 5 });
    const ev = evaluateExitPolicy(policy, snap);
    expect(ev.shouldExit).toBe(true);
    expect(ev.primary).toBe("turn_cap");
  });

  it("fires error_threshold when consecutiveErrors reaches maxConsecutive", () => {
    const policy = makePolicy({ errors: { maxConsecutive: 3 } });
    const snap = makeSnapshot({ consecutiveErrors: 3 });
    const ev = evaluateExitPolicy(policy, snap);
    expect(ev.shouldExit).toBe(true);
    expect(ev.primary).toBe("error_threshold");
  });

  it("fires no_progress when the rolling window is full of identical hashes", () => {
    const hash = hashProgressState({ value: "stuck" });
    const policy = makePolicy({ progress: { windowSize: 3, unchangedStateLimit: 3 } });
    const snap = makeSnapshot({ recentStateHashes: [hash, hash, hash] });
    const ev = evaluateExitPolicy(policy, snap);
    expect(ev.shouldExit).toBe(true);
    expect(ev.primary).toBe("no_progress");
  });

  it("fires no_progress via trajectoryStop when shouldStop is true", () => {
    const policy = makePolicy();
    const snap = makeSnapshot({
      trajectoryStop: { shouldStop: true, reason: "Trajectory stalled" }
    });
    const ev = evaluateExitPolicy(policy, snap);
    expect(ev.matched).toContain("no_progress");
  });

  it("fires human_interrupt when a signal is present and humanInterrupt is enabled", () => {
    const policy = makePolicy();
    const snap = makeSnapshot({ humanInterrupt: humanSignal });
    const ev = evaluateExitPolicy(policy, snap);
    expect(ev.shouldExit).toBe(true);
    expect(ev.primary).toBe("human_interrupt");
  });

  it("fires external_event when an event is present and externalEvent is enabled", () => {
    const policy = makePolicy();
    const snap = makeSnapshot({ externalEvent });
    const ev = evaluateExitPolicy(policy, snap);
    expect(ev.shouldExit).toBe(true);
    expect(ev.primary).toBe("external_event");
  });
});

// ─── Disabled exits ──────────────────────────────────────────────────────────

describe("evaluateExitPolicy — disabled exits are ignored", () => {
  it("does not fire human_interrupt when humanInterrupt.enabled is false", () => {
    const policy = makePolicy({ humanInterrupt: { enabled: false } });
    const snap = makeSnapshot({ humanInterrupt: humanSignal });
    const ev = evaluateExitPolicy(policy, snap);
    expect(ev.matched).not.toContain("human_interrupt");
  });

  it("does not fire external_event when externalEvent.enabled is false", () => {
    const policy = makePolicy({ externalEvent: { enabled: false } });
    const snap = makeSnapshot({ externalEvent });
    const ev = evaluateExitPolicy(policy, snap);
    expect(ev.matched).not.toContain("external_event");
  });
});

// ─── A3: Sub-window no-progress guard ────────────────────────────────────────

describe("evaluateExitPolicy — A3: no_progress requires a FULL window of identical hashes", () => {
  it("does not fire no_progress when fewer hashes than unchangedStateLimit are identical", () => {
    const hash = hashProgressState({ value: "stuck" });
    // windowSize=3 unchangedStateLimit=3, but only 2 hashes present
    const policy = makePolicy({ progress: { windowSize: 3, unchangedStateLimit: 3 } });
    const snap = makeSnapshot({ recentStateHashes: [hash, hash] });
    const ev = evaluateExitPolicy(policy, snap);
    expect(ev.matched).not.toContain("no_progress");
    expect(ev.shouldExit).toBe(false);
  });

  it("does not fire no_progress when the last N hashes differ", () => {
    const h1 = hashProgressState({ value: "a" });
    const h2 = hashProgressState({ value: "b" });
    const h3 = hashProgressState({ value: "a" });
    const policy = makePolicy({ progress: { windowSize: 3, unchangedStateLimit: 3 } });
    const snap = makeSnapshot({ recentStateHashes: [h1, h2, h3] });
    const ev = evaluateExitPolicy(policy, snap);
    expect(ev.matched).not.toContain("no_progress");
  });

  it("fires no_progress only when the last unchangedStateLimit hashes are all identical", () => {
    const stale = hashProgressState({ value: "old" });
    const stuck = hashProgressState({ value: "stuck" });
    // 4 hashes: [stale, stuck, stuck, stuck] — last 3 are identical
    const policy = makePolicy({ progress: { windowSize: 3, unchangedStateLimit: 3 } });
    const snap = makeSnapshot({ recentStateHashes: [stale, stuck, stuck, stuck] });
    const ev = evaluateExitPolicy(policy, snap);
    expect(ev.matched).toContain("no_progress");
  });
});

// ─── A2: EXIT_PRECEDENCE — named with rationale ───────────────────────────────

describe("evaluateExitPolicy — A2 EXIT_PRECEDENCE: human authority outranks all", () => {
  it("human_interrupt beats external_event — external authority cannot override direct human intervention", () => {
    const policy = makePolicy();
    const snap = makeSnapshot({
      humanInterrupt: humanSignal,
      externalEvent
    });
    const ev = evaluateExitPolicy(policy, snap);
    expect(ev.primary).toBe("human_interrupt");
    expect(ev.matched).toContain("external_event");
    expect(ev.matched).toContain("human_interrupt");
  });

  it("human_interrupt beats goal_met — human authority cannot be argued away by a successful result", () => {
    const policy = makePolicy({ goal: { verifierRequired: false, minimumScore: 0 } });
    const snap = makeSnapshot({
      humanInterrupt: humanSignal,
      result: { status: "completed", verificationPassed: true, verifierScore: 1 }
    });
    const ev = evaluateExitPolicy(policy, snap);
    expect(ev.primary).toBe("human_interrupt");
  });

  it("external_event beats goal_met when both fire simultaneously", () => {
    const policy = makePolicy({ goal: { verifierRequired: false, minimumScore: 0 } });
    const snap = makeSnapshot({
      externalEvent,
      result: { status: "completed", verificationPassed: true, verifierScore: 1 }
    });
    const ev = evaluateExitPolicy(policy, snap);
    expect(ev.primary).toBe("external_event");
  });

  it("wall_clock beats goal_met — governance time limit outranks verified success (ML-003)", () => {
    const policy = makePolicy({
      goal: { verifierRequired: false, minimumScore: 0 },
      wallClock: { maxElapsedMs: 1 } // already elapsed
    });
    const snap = makeSnapshot({
      result: { status: "completed", verificationPassed: true, verifierScore: 1 }
    });
    const ev = evaluateExitPolicy(policy, snap);
    expect(ev.primary).toBe("wall_clock");
    expect(ev.matched).toContain("goal_met");
  });

  it("wall_clock beats budget_cap — wall-clock is the most urgent resource exit", () => {
    // wallClock fires (60 s elapsed > 1 ms max) and budget fires (actualUsd 2 > max 1);
    // wall_clock must be primary.
    const policy = makePolicy({
      wallClock: { maxElapsedMs: 1 },
      budget: { maxUsd: 1, maxTokens: 100_000 }
    });
    const snap = makeSnapshot({ actualUsd: 2 });
    const ev = evaluateExitPolicy(policy, snap);
    expect(ev.primary).toBe("wall_clock");
    expect(ev.matched).toContain("budget_cap");
  });

  it("budget_cap beats turn_cap — dollar/token exhaustion is more urgent than iteration count", () => {
    // Both budget and turn fire; budget_cap must be primary.
    const policy = makePolicy({
      budget: { maxUsd: 1, maxTokens: 100_000 },
      turns: { max: 1 }
    });
    const snap = makeSnapshot({ actualUsd: 2, turnsUsed: 2 });
    const ev = evaluateExitPolicy(policy, snap);
    expect(ev.primary).toBe("budget_cap");
    expect(ev.matched).toContain("turn_cap");
  });
});

describe("evaluateExitPolicy — multiple simultaneous exits report all matched kinds", () => {
  it("returns all matched kinds in the matched array", () => {
    const policy = makePolicy({
      turns: { max: 1 },
      errors: { maxConsecutive: 1 },
      budget: { maxUsd: 1, maxTokens: 100_000 }
    });
    const snap = makeSnapshot({ turnsUsed: 2, consecutiveErrors: 2, actualUsd: 2 });
    const ev = evaluateExitPolicy(policy, snap);
    expect(ev.matched).toContain("turn_cap");
    expect(ev.matched).toContain("error_threshold");
    expect(ev.matched).toContain("budget_cap");
    expect(ev.matched.length).toBeGreaterThanOrEqual(3);
  });
});

// ─── No-exit case ────────────────────────────────────────────────────────────

describe("evaluateExitPolicy — no exit fires when all thresholds are safe", () => {
  it("returns shouldExit false when nothing is triggered", () => {
    const policy = makePolicy();
    const snap = makeSnapshot();
    const ev = evaluateExitPolicy(policy, snap);
    expect(ev.shouldExit).toBe(false);
    expect(ev.primary).toBeUndefined();
    expect(ev.matched).toHaveLength(0);
  });
});

// ─── validateExitPolicy ──────────────────────────────────────────────────────

describe("validateExitPolicy", () => {
  it("throws RangeError when turns.max is zero", () => {
    const policy = makePolicy({ turns: { max: 0 } });
    expect(() => validateExitPolicy(policy)).toThrow(RangeError);
  });

  it("throws RangeError when budget.maxUsd is negative", () => {
    const policy = makePolicy({ budget: { maxUsd: -1, maxTokens: 1000 } });
    expect(() => validateExitPolicy(policy)).toThrow(RangeError);
  });

  it("throws RangeError when unchangedStateLimit exceeds windowSize", () => {
    const policy = makePolicy({ progress: { windowSize: 2, unchangedStateLimit: 3 } });
    expect(() => validateExitPolicy(policy)).toThrow(RangeError);
  });

  it("throws RangeError when minimumScore is outside [0, 1]", () => {
    const policy = makePolicy({ goal: { verifierRequired: false, minimumScore: 1.5 } });
    expect(() => validateExitPolicy(policy)).toThrow(RangeError);
  });

  it("throws RangeError when deadlineAt is not a valid ISO string", () => {
    const policy = makePolicy({ wallClock: { maxElapsedMs: 1000, deadlineAt: "not-a-date" } });
    expect(() => validateExitPolicy(policy)).toThrow(RangeError);
  });
});

// ─── createDefaultExitPolicy ─────────────────────────────────────────────────

describe("createDefaultExitPolicy", () => {
  it("produces a valid policy from a LoopBudget", () => {
    const policy = createDefaultExitPolicy({
      maxIterations: 20,
      maxUsd: 5,
      softLimitUsd: 4,
      maxTokens: 200_000
    });
    expect(() => validateExitPolicy(policy)).not.toThrow();
    expect(policy.turns.max).toBe(20);
    expect(policy.budget.maxUsd).toBe(5);
  });

  it("applies overrides on top of defaults", () => {
    const policy = createDefaultExitPolicy(
      { maxIterations: 10, maxUsd: 5, softLimitUsd: 4, maxTokens: 50_000 },
      { turns: { max: 25 } }
    );
    expect(policy.turns.max).toBe(25);
  });
});

// ─── toLegacyExitDecision ─────────────────────────────────────────────────────

describe("toLegacyExitDecision", () => {
  it("returns running when shouldExit is false", () => {
    const policy = makePolicy();
    const ev = evaluateExitPolicy(policy, makeSnapshot());
    const decision = toLegacyExitDecision(ev);
    expect(decision.shouldExit).toBe(false);
    expect(decision.lifecycleState).toBe("running");
  });

  it("returns completed for goal_met", () => {
    const policy = makePolicy({ goal: { verifierRequired: false, minimumScore: 0 } });
    const snap = makeSnapshot({
      result: { status: "completed", verificationPassed: true, verifierScore: 1 }
    });
    const ev = evaluateExitPolicy(policy, snap);
    const decision = toLegacyExitDecision(ev);
    expect(decision.shouldExit).toBe(true);
    expect(decision.lifecycleState).toBe("completed");
    expect(decision.status).toBe("completed");
  });

  it("returns human_escalation for human_interrupt", () => {
    const policy = makePolicy();
    const snap = makeSnapshot({ humanInterrupt: humanSignal });
    const ev = evaluateExitPolicy(policy, snap);
    const decision = toLegacyExitDecision(ev);
    expect(decision.shouldExit).toBe(true);
    expect(decision.lifecycleState).toBe("human_escalation");
  });

  it("returns budget_exit for budget_cap", () => {
    const policy = makePolicy({ budget: { maxUsd: 1, maxTokens: 100_000 } });
    const snap = makeSnapshot({ actualUsd: 2 });
    const ev = evaluateExitPolicy(policy, snap);
    const decision = toLegacyExitDecision(ev);
    expect(decision.lifecycleState).toBe("budget_exit");
  });

  it("returns diminishing_returns for no_progress", () => {
    const hash = hashProgressState({ done: true });
    const policy = makePolicy({ progress: { windowSize: 3, unchangedStateLimit: 3 } });
    const snap = makeSnapshot({ recentStateHashes: [hash, hash, hash] });
    const ev = evaluateExitPolicy(policy, snap);
    const decision = toLegacyExitDecision(ev);
    expect(decision.lifecycleState).toBe("diminishing_returns");
  });
});

// ─── hashProgressState ───────────────────────────────────────────────────────

describe("hashProgressState", () => {
  it("produces a deterministic hex string for a given value", () => {
    const h1 = hashProgressState({ files: ["a.ts", "b.ts"], score: 0.9 });
    const h2 = hashProgressState({ files: ["a.ts", "b.ts"], score: 0.9 });
    expect(h1).toBe(h2);
    expect(h1).toMatch(/^[0-9a-f]{64}$/);
  });

  it("produces different hashes for structurally different values", () => {
    const h1 = hashProgressState({ a: 1 });
    const h2 = hashProgressState({ a: 2 });
    expect(h1).not.toBe(h2);
  });

  it("is key-order-independent (stable JSON)", () => {
    const h1 = hashProgressState({ z: 1, a: 2 });
    const h2 = hashProgressState({ a: 2, z: 1 });
    expect(h1).toBe(h2);
  });

  it("treats arrays as ordered (different order → different hash)", () => {
    const h1 = hashProgressState(["a", "b"]);
    const h2 = hashProgressState(["b", "a"]);
    expect(h1).not.toBe(h2);
  });

  it("handles null, numbers, booleans, and nested objects", () => {
    expect(() => hashProgressState(null)).not.toThrow();
    expect(() => hashProgressState(42)).not.toThrow();
    expect(() => hashProgressState({ nested: { deep: true } })).not.toThrow();
  });
});

// ─── ML-003 governance regression ───────────────────────────────────────────

describe("ML-003 exit precedence regressions", () => {
  it("budget_cap beats goal_met when both conditions are present simultaneously", () => {
    const policy = makePolicy({
      goal: { verifierRequired: true, minimumScore: 0.9 },
      budget: { maxUsd: 1, maxTokens: 10_000 }
    });
    const snapshot = makeSnapshot({
      actualUsd: 1.5,          // hard budget exceeded
      tokensUsed: 5_000,
      turnsUsed: 1,
      result: { status: "completed", verificationPassed: true, verifierScore: 1 }
    });
    const evaluation = evaluateExitPolicy(policy, snapshot);
    expect(evaluation.primary).toBe("budget_cap");
    expect(evaluation.matched).toContain("goal_met");
    const decision = toLegacyExitDecision(evaluation);
    expect(decision.lifecycleState).toBe("budget_exit");
    expect(decision.status).not.toBe("completed");
  });

  it("goal_met wins when goal is achieved on the final permitted iteration (turn_cap suppressed)", () => {
    const policy = makePolicy({
      goal: { verifierRequired: true, minimumScore: 1 },
      turns: { max: 1 }
    });
    const snapshot = makeSnapshot({
      turnsUsed: 1,             // exactly at limit — final allowed iteration
      result: { status: "completed", verificationPassed: true, verifierScore: 1 }
    });
    const evaluation = evaluateExitPolicy(policy, snapshot);
    expect(evaluation.primary).toBe("goal_met");
    expect(evaluation.matched).not.toContain("turn_cap");
    const decision = toLegacyExitDecision(evaluation);
    expect(decision.lifecycleState).toBe("completed");
    expect(decision.status).toBe("completed");
  });

  it("turn_cap fires when iterations exhausted without verified completion", () => {
    const policy = makePolicy({ turns: { max: 3 } });
    const snapshot = makeSnapshot({ turnsUsed: 3 }); // no result/goal
    const evaluation = evaluateExitPolicy(policy, snapshot);
    expect(evaluation.primary).toBe("turn_cap");
    const decision = toLegacyExitDecision(evaluation);
    expect(decision.lifecycleState).toBe("budget_exit");
    expect(decision.status).not.toBe("completed");
  });
});
