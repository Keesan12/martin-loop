# Phase 10 Slice 1 Summary

Date: 2026-04-03
Status: complete

## What landed

- Added explicit Phase 10 patch-truth contract types:
  - `PatchDecision`
  - `PatchDecisionReasonCode`
  - `PatchScore`
  - `PatchDecisionArtifact`
- Added `evaluatePatchDecision()` and `scorePatchDecision()` in `packages/core/src/policy.ts`
- Added persisted patch truth artifacts in `packages/core/src/persistence/store.ts`:
  - `patch-score.json`
  - `patch-decision.json`
- Added rollback-truth contract types and helpers:
  - `RollbackBoundaryArtifact`
  - `RollbackOutcomeArtifact`
  - `packages/core/src/rollback.ts`
- Added persisted rollback artifacts in `packages/core/src/persistence/store.ts`:
  - `rollback-boundary.json`
  - `rollback-outcome.json`
- Wired `runMartin()` to:
  - score grounded/completed attempts before keep/discard
  - persist patch truth artifacts per attempt
  - write structured `attempt.kept` / `attempt.discarded` ledger payloads with decision, reason codes, and score
  - downgrade verifier-passing-but-ungrounded patches into discard decisions instead of silently keeping them
- capture a pre-attempt rollback boundary for repo-backed attempts
- restore discarded and safety-blocked attempts back to that recorded boundary
- preserve pre-existing dirty tracked state while removing new failed/discarded patch output
- persist explicit restore outcomes instead of leaving rollback implied
- Preserved Phase 9 safety block behavior while adding patch-truth artifacts to post-patch safety exits

## Challenge coverage now present

- Challenge 14: tests pass but wrong files changed -> discard rule present
- Challenge 15: one test fixed, another regressed -> discard rule present
- Challenge 16: no code change but verbose attempt summary -> discard rule present
- Challenge 17: large diff with no verifier improvement -> discard rule present

## Verification run

```powershell
pnpm --filter @martin/core test
pnpm --filter @martin/core lint
pnpm --filter @martin/contracts build
pnpm --filter @martin/core build
pnpm --filter @martin/benchmarks test
pnpm --filter @martin/benchmarks build
pnpm --filter @martin/benchmarks eval:phase12
```

Latest result:

- `@martin/core` tests: 77 passed, 0 failed
- `@martin/core` lint: passed
- `@martin/contracts` build: passed
- `@martin/core` build: passed
- `@martin/benchmarks` tests: 13 passed, 0 failed
- `@martin/benchmarks` build: passed
- `Phase 12` certification report: GO

## Files touched in this slice

- `packages/contracts/src/index.ts`
- `packages/core/src/index.ts`
- `packages/core/src/policy.ts`
- `packages/core/src/rollback.ts`
- `packages/core/src/persistence/store.ts`
- `packages/core/tests/policy.test.ts`
- `packages/core/tests/persistence.test.ts`
- `packages/core/tests/runtime.test.ts`

## Phase 10 closeout result

- Rollback-truth residue is closed.
- The next step is Phase 13 release-candidate engineering, with targeted provider-path, rollback-replay, and fresh-environment certification addenda tracked as RC/public-release gates rather than open Phase 10 work.
