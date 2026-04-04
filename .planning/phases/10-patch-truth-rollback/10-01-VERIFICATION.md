# Phase 10 Rolling Verification

Date: 2026-04-03
Status: complete

## Challenge Coverage

- Challenge 14: wrong-file patch decisions discard instead of keep
- Challenge 15: regressing verifier score discards the patch
- Challenge 16: no-code-change attempts discard with an explicit reason code
- Challenge 17: large diff with no verifier improvement discards the patch

## Evidence

- `packages/core/tests/policy.test.ts`
  - `challenge 14: discards a verifier-passing patch when the wrong files changed`
  - `challenge 15: discards a patch when verifier score regresses`
  - `challenge 16: discards a verbose attempt that changed no code`
  - `challenge 17: discards a large diff when verifier score does not improve`
- `packages/core/tests/persistence.test.ts`
  - `writes patch-score.json and patch-decision.json when patch truth artifacts are provided`
  - `writes rollback-boundary.json and rollback-outcome.json when rollback artifacts are provided`
- `packages/core/tests/runtime.test.ts`
  - `writes patch truth artifacts for a grounded verifier-passing patch`
  - `discards grounding-failure patches and persists patch decision artifacts`
  - `restores the pre-attempt repo boundary for discarded verifier regressions and preserves pre-existing dirty files`
  - `restores forbidden file changes on the filesystem safety-block path and persists rollback artifacts`

## Commands Run

```powershell
pnpm --filter @martin/core test
pnpm --filter @martin/core lint
pnpm --filter @martin/contracts build
pnpm --filter @martin/core build
pnpm --filter @martin/benchmarks test
pnpm --filter @martin/benchmarks build
pnpm --filter @martin/benchmarks eval:phase12
```

## Latest Results

- `@martin/core` tests: 77 passed, 0 failed
- `@martin/core` lint: passed
- `@martin/contracts` build: passed
- `@martin/core` build: passed
- `@martin/benchmarks` tests: 13 passed, 0 failed
- `@martin/benchmarks` build: passed
- `Phase 12` certification report: GO

## Notes

- The patch-truth engine now persists both the decision evidence and the rollback boundary/restore outcome evidence needed to audit discarded and safety-blocked attempts.
- `RollbackOutcomeArtifact.status` explicitly distinguishes `restored`, `not_required`, `failed`, and `unavailable`, so rollback truth is no longer implied by prose.
