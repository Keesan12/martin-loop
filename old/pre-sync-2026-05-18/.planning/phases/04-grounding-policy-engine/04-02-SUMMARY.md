---
phase: "04-grounding-policy-engine"
plan: "02"
subsystem: "core/runtime-policy-tests"
tags: ["evidence-vector", "recovery-recipes", "runtime-admission", "tests"]
dependency_graph:
  requires: ["04-01"]
  provides: ["evidence-vector", "recovery-recipes", "runtime-budget-preflight", "phase-4-tests"]
  affects: ["packages/core/src/policy.ts", "packages/core/src/index.ts", "packages/core/tests/grounding.test.ts", "packages/core/tests/policy.test.ts", "packages/core/tests/runtime.test.ts"]
tech_stack:
  added: []
  patterns: ["test-first-phase-4", "preflight-before-admission", "evidence-driven-recovery"]
key_files:
  created:
    - "packages/core/tests/policy.test.ts"
  modified:
    - "packages/core/src/policy.ts"
    - "packages/core/src/index.ts"
    - "packages/core/tests/grounding.test.ts"
    - "packages/core/tests/runtime.test.ts"
decisions:
  - "Budget preflight now runs before evaluateAttemptPolicy and rejects with ledger source budget_preflight"
  - "EvidenceVector/recovery helpers are exported from core even though existing classifyFailure remains for backward-compatible runtime paths"
  - "Workspace-wide adapter and CLI spawn issues were recorded as non-Phase-4 residual failures"
metrics:
  completed: "2026-04-02"
  tasks_completed: 4
  files_created: 1
  files_modified: 4
---

# Phase 04 Plan 02 Summary

Wave 2 completed the evidence-driven policy helpers, enforced budget preflight before adapter execution in `runMartin`, and added the planned Phase 4 regression coverage.

## Files Created

- `packages/core/tests/policy.test.ts` — 12 Phase 4 tests covering budget preflight, EvidenceVector mapping, and recovery recipe selection

## Files Modified

- `packages/core/src/policy.ts` — added `computeEvidenceVector`, `selectRecoveryRecipe`, supporting types, and diff novelty tokenization
- `packages/core/src/index.ts` — wired `evaluateBudgetPreflight` ahead of attempt admission and re-exported the Phase 4 policy/grounding surface
- `packages/core/tests/grounding.test.ts` — added 3 grounding scanner regression tests
- `packages/core/tests/runtime.test.ts` — added a runtime regression proving budget preflight rejects before adapter execution and records `source: "budget_preflight"`

## Verification

- `pnpm --filter @martin/core test`
- `pnpm --filter @martin/core lint`
- `pnpm --filter @martin/contracts lint`

Results:

- `@martin/core`: 41/41 tests passing
- TypeScript: clean in `@martin/core` and `@martin/contracts`

Additional verification:

- `pnpm test` surfaced unrelated adapter failures outside Phase 4
- `pnpm --filter @martin/cli test` surfaced an unrelated `spawn EPERM` integration failure in the codex-engine path

## Residual Risks

- Adapter and CLI suites still have environment-sensitive spawn failures (`sleep` missing and `spawn EPERM`), so full workspace green remains blocked outside the Phase 4 scope.
- The v5 handoff’s broader “grounding violation” model includes claim-vs-verifier and tool-approval checks; this wave covered the repo diff/file/symbol admission slice needed for the active Phase 4 plan.
