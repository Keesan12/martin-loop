# Phase 13 Clean Handoff

Date: 2026-04-03
Status: ready_to_start

## Executive state

Martin Loop v4 is now through Phase 12 from a real repo-and-artifact perspective, and the last open Phase 10 blocker is closed.

What changed in the closeout:

- rollback-boundary persistence is real
- restore outcome artifacts are real
- discarded and safety-blocked attempts restore back to the recorded pre-attempt boundary
- rollback restore preserves pre-existing dirty tracked state instead of flattening the repo to `HEAD`
- Phase 12 certification is still `GO` after the rollback-truth closeout

This means the program can enter Phase 13 cleanly.

## What is complete

- Phase 10: patch truth and rollback
- Phase 11: read-model truth
- Phase 12: certification and claim freeze

## Verified baseline

```powershell
pnpm --filter @martin/core test
pnpm --filter @martin/core lint
pnpm --filter @martin/contracts build
pnpm --filter @martin/core build
pnpm --filter @martin/benchmarks test
pnpm --filter @martin/benchmarks build
pnpm --filter @martin/benchmarks eval:phase12
```

Latest results:

- `@martin/core` tests: 77/77 passing
- `@martin/core` lint: pass
- `@martin/contracts` build: pass
- `@martin/core` build: pass
- `@martin/benchmarks` tests: 13/13 passing
- `@martin/benchmarks` build: pass
- `Phase 12` certification report: `GO`

## Phase 10 closeout details

Key artifacts now present per attempt:

- `patch-score.json`
- `patch-decision.json`
- `rollback-boundary.json`
- `rollback-outcome.json`

Key behavior now present:

- repo-backed attempts capture a recoverable state boundary before adapter execution
- discarded verifier-regression attempts restore to that boundary
- filesystem safety-block attempts restore to that boundary
- rollback evidence is replayable from disk, not inferred from summaries

Primary files touched in the closeout:

- `packages/contracts/src/index.ts`
- `packages/core/src/index.ts`
- `packages/core/src/rollback.ts`
- `packages/core/src/persistence/store.ts`
- `packages/core/tests/persistence.test.ts`
- `packages/core/tests/runtime.test.ts`

## Required certification addenda after Phase 10

Leadership direction is to treat these as the next trust gates before broad public release:

1. Provider-path certification
   - run certification separately for each marketed execution surface
   - at minimum: CLI path and routed/direct provider path
2. Rollback-replay certification
   - prove rollback intent persisted
   - prove rollback attempted
   - prove rollback result persisted
   - prove final repo state matches the recorded boundary
   - prove restore failures surface explicitly as artifacts
3. Fresh-environment certification
   - no warmed caches
   - no prior grounding artifacts
   - no leftover benchmark output folders
   - fresh install and fresh repo path

## Phase 13 execution focus

Phase 13 is now a release-candidate engineering phase, not a feature phase.

Deliverables:

- clean-environment install/build/test pass
- OSS core extraction finalization
- dependency hygiene and dead-code cleanup
- release notes
- migration notes
- install and quickstart docs
- operator runbook
- incident and rollback runbook
- observability checklist
- trust-mode defaults review
- exact-vs-estimated accounting label review across the product

RC exit criteria:

- fresh install works
- full repo build works
- benchmark and certification pass are reproducible
- no fake/demo production path remains
- docs are sufficient for a fresh engineer or pilot user

## Release-readiness matrix

| Surface | Status | Notes |
|---|---|---|
| Runtime grounding truth | Green | Phase 8 complete |
| Safety leash truth | Green | Phase 9 complete |
| Patch truth | Green | Phase 10 complete |
| Rollback truth | Green for RC entry | Add rollback-replay certification before broad release |
| Read-model truth | Green | Phase 11 complete |
| Claim-freeze certification | Green for RC entry | Add provider-path and fresh-environment certification before public release |
| Release-candidate engineering | Not started | This is the next active phase |
| Staged pilot readiness | Pending | Depends on Phase 13 |
| Public release readiness | Pending | Depends on Phases 13-15 and addenda |

## Recommended first tasks in Phase 13

1. Create the provider-path certification matrix and decide the exact surfaces to support publicly.
2. Add rollback-replay certification cases to the benchmark/certification harness.
3. Run a fresh-environment install/build/certification pass from a clean repo path.
4. Finalize RC docs and operator materials from the now-verified runtime behavior.
