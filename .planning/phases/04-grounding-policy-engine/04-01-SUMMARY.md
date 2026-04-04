---
phase: "04-grounding-policy-engine"
plan: "01"
subsystem: "core/contracts-grounding-policy"
tags: ["grounding", "budget-preflight", "contracts", "provenance"]
dependency_graph:
  requires: ["03-02"]
  provides: ["budget-preflight-types", "grounding-scanner", "phase-4-core-exports"]
  affects: ["packages/contracts/src/index.ts", "packages/core/src/grounding.ts", "packages/core/src/policy.ts", "packages/core/src/index.ts"]
tech_stack:
  added: []
  patterns: ["typed-preflight-estimates", "grounding-diff-scan", "contract-level-provenance"]
key_files:
  created: []
  modified:
    - "packages/contracts/src/index.ts"
    - "packages/core/src/grounding.ts"
    - "packages/core/src/policy.ts"
    - "packages/core/src/index.ts"
decisions:
  - "Kept CostProvenance aligned with the active Phase 4 contract: actual | estimated | unavailable"
  - "Grounding scanner validates diff file references and allowed-path scope before later runtime use"
  - "Budget preflight estimate remains a typed pre-admission artifact, separate from post-attempt settlement"
metrics:
  completed: "2026-04-02"
  tasks_completed: 4
  files_created: 0
  files_modified: 4
---

# Phase 04 Plan 01 Summary

Wave 1 added the shared Phase 4 budget types, the grounding diff scanner, and the preflight admission primitive that later runtime code uses to block attempts before execution.

## Files Modified

- `packages/contracts/src/index.ts` — added `CostProvenance`, `BudgetPreflightEstimate`, and `BudgetSettlement`
- `packages/core/src/grounding.ts` — added `scanPatchForGroundingViolations`, `GroundingViolation`, `GroundingScanResult`, and allowed-path matching
- `packages/core/src/policy.ts` — added `BudgetPreflightInput`, `BudgetPreflightDecision`, and `evaluateBudgetPreflight`
- `packages/core/src/index.ts` — re-exported new Phase 4 contracts, grounding, and policy symbols

## Verification

- `pnpm --filter @martin/contracts lint`
- `pnpm --filter @martin/core lint`

Both type checks passed with 0 errors.

## Notes

- Reviewed `martin-loop-complete-handoff-v5.zip` while executing this wave; the v9 grounding/policy and budget governor specs were used as a cross-check for the Phase 4 shape.
- Patch and verification spend separation is represented at the contract layer now; ledger/runtime settlement detail can build on top of these shared types in later phases.
