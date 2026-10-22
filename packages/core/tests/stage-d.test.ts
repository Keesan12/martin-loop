/**
 * Stage D regression tests.
 *
 * D1 — Task-aware iteration defaults (resolveEffectiveMaxIterations)
 * D2 — Budget viability (evaluateBudgetPreflight: no rigid 25% cap)
 * D5 — MCP verification truth (verifierScore check at call site)
 */

import { describe, expect, it } from "vitest";

import {
  DEFAULT_BUDGET,
  DEFAULT_ITERATIONS_BY_TASK_CLASS,
  resolveEffectiveMaxIterations,
} from "@martin/contracts";
import { evaluateBudgetPreflight } from "../src/policy.js";

// ── D1: Task-aware iteration defaults ─────────────────────────────────────────

describe("D1 — resolveEffectiveMaxIterations (task-class aware defaults)", () => {
  it("no taskClass, no explicit: returns DEFAULT_BUDGET.maxIterations", () => {
    expect(resolveEffectiveMaxIterations({})).toBe(DEFAULT_BUDGET.maxIterations);
  });

  it("taskClass=verification_only: returns 1", () => {
    expect(resolveEffectiveMaxIterations({ taskClass: "verification_only" })).toBe(1);
    expect(DEFAULT_ITERATIONS_BY_TASK_CLASS["verification_only"]).toBe(1);
  });

  it("taskClass=irreversible: returns 1", () => {
    expect(resolveEffectiveMaxIterations({ taskClass: "irreversible" })).toBe(1);
    expect(DEFAULT_ITERATIONS_BY_TASK_CLASS["irreversible"]).toBe(1);
  });

  it("taskClass=reversible_edit: returns 3 (execute + verify + one repair)", () => {
    expect(resolveEffectiveMaxIterations({ taskClass: "reversible_edit" })).toBe(3);
    expect(DEFAULT_ITERATIONS_BY_TASK_CLASS["reversible_edit"]).toBe(3);
  });

  it("mutationMode=read_only without taskClass: returns 1", () => {
    expect(resolveEffectiveMaxIterations({ mutationMode: "read_only" })).toBe(1);
  });

  it("explicit non-default maxIterations: always honored, taskClass ignored", () => {
    // User explicitly passed --max-iterations 10
    expect(resolveEffectiveMaxIterations({ taskClass: "verification_only" }, 10)).toBe(10);
    expect(resolveEffectiveMaxIterations({ taskClass: "irreversible" }, 5)).toBe(5);
    expect(resolveEffectiveMaxIterations({ mutationMode: "read_only" }, 7)).toBe(7);
  });

  it("explicit maxIterations === DEFAULT_BUDGET.maxIterations: taskClass wins (default-pass-through)", () => {
    // When caller passes the generic default unchanged, task class takes effect
    const defaultVal = DEFAULT_BUDGET.maxIterations; // 8
    expect(resolveEffectiveMaxIterations({ taskClass: "verification_only" }, defaultVal)).toBe(1);
    expect(resolveEffectiveMaxIterations({ taskClass: "reversible_edit" }, defaultVal)).toBe(3);
  });

  it("explicit maxIterations=1 with taskClass=reversible_edit: honors 1 (not 3)", () => {
    // Caller explicitly wants 1 attempt even for a reversible edit
    expect(resolveEffectiveMaxIterations({ taskClass: "reversible_edit" }, 1)).toBe(1);
  });
});

// ── D2: Budget viability (no rigid 25% cap) ───────────────────────────────────

describe("D2 — evaluateBudgetPreflight (budget-aware cap)", () => {
  const baseInput = {
    promptCharCount: 1000,
    attemptCount: 0,
    remainingBudgetUsd: 10.00,
  };

  it("adequate budget: allowed", () => {
    const result = evaluateBudgetPreflight({ ...baseInput, remainingIterations: 3 });
    expect(result.allowed).toBe(true);
  });

  it("low but viable budget ($0.30 remaining, $0.05 estimated): allowed", () => {
    // OLD behavior: $0.05 estimated > $0.30 * 0.25 = $0.075? No, 0.05 < 0.075, so that's fine.
    // But $0.25 estimated vs $1.00 budget: old cap = 0.25 → rejected. New cap = 0.80 → allowed.
    const result = evaluateBudgetPreflight({
      promptCharCount: 50_000,  // large prompt → higher estimate
      attemptCount: 0,
      remainingBudgetUsd: 1.00,
      remainingIterations: 1,
      // No explicit cap — should use 0.80 * 1.00 = $0.80
    });
    // The estimated cost for 50k chars is manageable; should be admitted
    expect(result.allowed).toBe(true);
  });

  it("per-iteration cap: remaining / remainingIterations", () => {
    // $0.90 remaining, 3 iterations → cap = $0.30 per attempt
    const result = evaluateBudgetPreflight({
      promptCharCount: 500,
      attemptCount: 0,
      remainingBudgetUsd: 0.90,
      remainingIterations: 3,
    });
    expect(result.allowed).toBe(true);
    // Estimate should be tiny (500 chars)
    expect(result.estimate.estimatedAttemptCostUsd).toBeLessThan(0.30);
  });

  it("obviously inadequate budget: rejected", () => {
    const result = evaluateBudgetPreflight({
      promptCharCount: 1000,
      attemptCount: 0,
      remainingBudgetUsd: 0.00,
      remainingIterations: 1,
    });
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("Preflight");
  });

  it("explicit perAttemptCapUsd overrides computed cap", () => {
    // $5 budget but cap set to $0.01 → should reject if estimated > $0.01
    const result = evaluateBudgetPreflight({
      promptCharCount: 5000,
      attemptCount: 0,
      remainingBudgetUsd: 5.00,
      remainingIterations: 3,
      perAttemptCapUsd: 0.001  // extremely low explicit cap
    });
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("per-attempt cap");
  });

  it("repair reserve: enough budget for current attempt when iterations remain", () => {
    // 2 iterations left, $0.20 remaining → cap = $0.10 per attempt
    const result = evaluateBudgetPreflight({
      promptCharCount: 100,
      attemptCount: 0,
      remainingBudgetUsd: 0.20,
      remainingIterations: 2,
    });
    expect(result.allowed).toBe(true);
    // Small prompt should be well under $0.10
    expect(result.estimate.estimatedAttemptCostUsd).toBeLessThan(0.10);
  });

  it("near-zero remaining iterations: falls back to 80% of remaining budget", () => {
    // 0 remainingIterations means the run is almost done; allow remaining spend
    const result = evaluateBudgetPreflight({
      promptCharCount: 100,
      attemptCount: 0,
      remainingBudgetUsd: 0.50,
      remainingIterations: 0,  // 0 → treated as "no iteration info"
    });
    // With 0 iterations, the cap should not be computed as 0.50/0 (infinity or NaN)
    // The logic should fall back to 0.80 * 0.50 = 0.40
    expect(result.allowed).toBe(true);
  });

  it("near-boundary rounding: estimatedAttemptCostUsd precision", () => {
    const result = evaluateBudgetPreflight({
      promptCharCount: 1000,
      attemptCount: 0,
      remainingBudgetUsd: 0.05,
      remainingIterations: 1,
    });
    // $0.05 remaining, cap = min(0.05/1, 0.05) = $0.05. Estimated should be ≤ $0.05.
    // The estimatedVerifierCostUsd alone is $0.01, so this depends on prompt size.
    // Just check it's a definite allowed or rejected — no NaN/Infinity.
    expect(typeof result.allowed).toBe("boolean");
    expect(isFinite(result.estimate.estimatedAttemptCostUsd)).toBe(true);
  });
});
