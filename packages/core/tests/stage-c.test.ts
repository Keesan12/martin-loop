/**
 * Stage C regression tests.
 *
 * C1 — Safe candidate retention (fail-closed allowlist)
 * C2 — Progress-aware diminishing_returns using REAL verifier evidence
 * C3 — Terminal cleanup: workspace restored when run ends without VERIFIED
 */

import { describe, expect, it } from "vitest";

import { isSafeUnverifiedDiscard } from "../src/policy.js";
import { inferExit } from "../src/policy.js";
import type { MartinAdapterResultLike } from "../src/policy.js";
import type { LoopAttempt } from "@martin/contracts";

// ── C1: isSafeUnverifiedDiscard — FAIL-CLOSED ALLOWLIST ──────────────────────

describe("C1 — isSafeUnverifiedDiscard (fail-closed allowlist)", () => {
  it("returns true for explicitly allowlisted soft codes", () => {
    expect(isSafeUnverifiedDiscard(["verifier_not_improved"])).toBe(true);
    expect(isSafeUnverifiedDiscard(["low_novelty_no_progress"])).toBe(true);
    expect(isSafeUnverifiedDiscard(["large_diff_no_improvement"])).toBe(true);
    expect(isSafeUnverifiedDiscard(["grounding_failure"])).toBe(true);
    expect(isSafeUnverifiedDiscard(["verifier_regressed"])).toBe(true);
    // Multiple allowlisted codes together
    expect(isSafeUnverifiedDiscard(["grounding_failure", "low_novelty_no_progress"])).toBe(true);
  });

  it("returns false for EMPTY reason codes — fail closed when reason unknown", () => {
    // No reason = unknown = do not retain
    expect(isSafeUnverifiedDiscard([])).toBe(false);
  });

  it("returns false when scope_violation present (hard boundary)", () => {
    expect(isSafeUnverifiedDiscard(["scope_violation"])).toBe(false);
    expect(isSafeUnverifiedDiscard(["scope_violation", "grounding_failure"])).toBe(false);
  });

  it("returns false when safety_violation present (hard boundary)", () => {
    expect(isSafeUnverifiedDiscard(["safety_violation"])).toBe(false);
    expect(isSafeUnverifiedDiscard(["safety_violation", "verifier_not_improved"])).toBe(false);
  });

  it("returns false for no_code_change — nothing to retain or repair", () => {
    // There is no useful candidate to preserve when nothing changed
    expect(isSafeUnverifiedDiscard(["no_code_change"])).toBe(false);
  });

  it("returns false for unknown/future reason codes — fail closed by default", () => {
    // A code not in the allowlist must cause rollback, not silent retention
    const unknownCode = "unknown_future_reason" as Parameters<typeof isSafeUnverifiedDiscard>[0][number];
    expect(isSafeUnverifiedDiscard([unknownCode])).toBe(false);
    expect(isSafeUnverifiedDiscard(["grounding_failure", unknownCode])).toBe(false);
  });
});

// ── C2: progress-aware inferExit using REAL evidence ─────────────────────────

function makeAttempt(overrides: Partial<LoopAttempt> = {}): LoopAttempt {
  return {
    attemptId: "att_test",
    index: 1,
    adapterId: "agent-cli:claude",
    startedAt: "2026-10-21T00:00:00.000Z",
    completedAt: "2026-10-21T00:00:30.000Z",
    summary: "attempt",
    ...overrides
  };
}

function makeFailedResult(): MartinAdapterResultLike {
  return {
    status: "completed",
    summary: "done",
    usage: { actualUsd: 0.05, tokensIn: 100, tokensOut: 50 },
    verification: { passed: false, summary: "tests failed" }
  };
}

const noopCostState = {
  shouldStop: false,
  pressure: "healthy" as const,
  remainingBudgetUsd: 9,
  remainingIterations: 4
};

const baseBudget = {
  maxUsd: 10, softLimitUsd: 7, maxIterations: 5
};
const baseCost = {
  actualUsd: 0.1, avoidedUsd: 0, tokensIn: 100, tokensOut: 50, provenance: "actual" as const
};

describe("C2 — progress-aware inferExit (real evidence)", () => {
  it("stops when same failureClass AND no measurable improvement (score and step count static)", () => {
    const attempts = [
      makeAttempt({
        index: 1, failureClass: "verification_failure",
        verifierScore: 0, failingVerifierStepCount: 5,
      }),
      makeAttempt({
        index: 2, failureClass: "verification_failure",
        verifierScore: 0, failingVerifierStepCount: 5,  // same count, no improvement
      }),
    ];
    const result = inferExit({
      loop: { budget: baseBudget, cost: baseCost, attempts },
      lastResult: makeFailedResult(),
      lastFailure: { failureClass: "verification_failure", recommendedIntervention: "run_verifier", diagnosticHint: "test failed", retryable: true, rationale: "stall" },
      costState: noopCostState
    });
    expect(result.shouldExit).toBe(true);
    expect(result.lifecycleState).toBe("diminishing_returns");
  });

  it("continues when failingVerifierStepCount decreased — measurable monotonic progress", () => {
    // With a single verifier command (pnpm test), failingVerifierStepCount reflects
    // the number of verifier commands that failed, not individual test assertions.
    // A real host-run can produce failingVerifierStepCount=1 for 12 failing tests.
    // Here we use multi-step verifier scenario for clarity.
    const attempts = [
      makeAttempt({
        index: 1, failureClass: "verification_failure",
        verifierScore: 0, failingVerifierStepCount: 5,
      }),
      makeAttempt({
        index: 2, failureClass: "verification_failure",
        verifierScore: 0, failingVerifierStepCount: 3,  // monotonic improvement
      }),
    ];
    const result = inferExit({
      loop: { budget: baseBudget, cost: baseCost, attempts },
      lastResult: makeFailedResult(),
      lastFailure: { failureClass: "verification_failure", recommendedIntervention: "run_verifier", diagnosticHint: "3 steps still failing", retryable: true, rationale: "partial" },
      costState: noopCostState
    });
    expect(result.shouldExit).toBe(false);
  });

  it("continues when failingVerifierStepCount decreased (2→1) — one failure resolved", () => {
    // Two-command verifier: attempt 1 had both failing, attempt 2 fixed one.
    const attempts = [
      makeAttempt({
        index: 1, failureClass: "verification_failure",
        verifierScore: 0, failingVerifierStepCount: 2,
      }),
      makeAttempt({
        index: 2, failureClass: "verification_failure",
        verifierScore: 0.5, failingVerifierStepCount: 1,
      }),
    ];
    const result = inferExit({
      loop: { budget: baseBudget, cost: baseCost, attempts },
      lastResult: makeFailedResult(),
      lastFailure: { failureClass: "verification_failure", recommendedIntervention: "run_verifier", diagnosticHint: "1 step remaining", retryable: true, rationale: "partial" },
      costState: noopCostState
    });
    expect(result.shouldExit).toBe(false);
  });

  it("continues when verifierScore improved via real step ratio (e.g. 4/5 steps pass)", () => {
    // verifierScore = passing/launched, realistically produced by multi-step verifier
    const attempts = [
      makeAttempt({
        index: 1, failureClass: "verification_failure",
        verifierScore: 0,  // all steps failed
        failingVerifierStepCount: 5
      }),
      makeAttempt({
        index: 2, failureClass: "verification_failure",
        verifierScore: 0.8,  // 4/5 steps pass — real when verifier has multiple commands
        failingVerifierStepCount: 1
      }),
    ];
    const result = inferExit({
      loop: { budget: baseBudget, cost: baseCost, attempts },
      lastResult: makeFailedResult(),
      lastFailure: { failureClass: "verification_failure", recommendedIntervention: "run_verifier", diagnosticHint: "1 step still failing", retryable: true, rationale: "partial" },
      costState: noopCostState
    });
    expect(result.shouldExit).toBe(false);
  });

  it("oscillation (A/B/A) still stops — failure class cycling is not progress", () => {
    const attempts = [
      makeAttempt({ index: 1, failureClass: "verification_failure", verifierScore: 0 }),
      makeAttempt({ index: 2, failureClass: "repo_grounding_failure", verifierScore: 0 }),
      makeAttempt({ index: 3, failureClass: "verification_failure", verifierScore: 0 }),
    ];
    const result = inferExit({
      loop: { budget: baseBudget, cost: { ...baseCost, actualUsd: 0.3, tokensIn: 300, tokensOut: 150 }, attempts },
      lastResult: makeFailedResult(),
      lastFailure: { failureClass: "verification_failure", recommendedIntervention: "run_verifier", diagnosticHint: "oscillating", retryable: true, rationale: "oscillating" },
      costState: noopCostState
    });
    expect(result.shouldExit).toBe(true);
  });

  it("first attempt: never stops immediately on single failure", () => {
    const attempts = [
      makeAttempt({ index: 1, failureClass: "verification_failure", verifierScore: 0, failingVerifierStepCount: 3 }),
    ];
    const result = inferExit({
      loop: { budget: baseBudget, cost: { ...baseCost, actualUsd: 0.05, tokensIn: 50, tokensOut: 25 }, attempts },
      lastResult: makeFailedResult(),
      lastFailure: { failureClass: "verification_failure", recommendedIntervention: "run_verifier", diagnosticHint: "test failed", retryable: true, rationale: "verifier not passed" },
      costState: noopCostState
    });
    expect(result.shouldExit).toBe(false);
  });
});
