---
phase: 08-grounding-integrity
plan: "02"
subsystem: core-runtime
tags: [grounding, ledger, verify-phase, runtime-test]
dependency_graph:
  requires: [08-01]
  provides: [grounding-scan-in-verify-phase, grounding-violations-ledger-event]
  affects: [packages/core/src/index.ts, packages/core/tests/runtime.test.ts]
tech_stack:
  added: []
  patterns: [best-effort-try-catch, synthetic-diff-header, ledger-event-append]
key_files:
  modified:
    - packages/core/src/index.ts
    - packages/core/tests/runtime.test.ts
decisions:
  - Grounding scan wrapped in try/catch so a scan error never fails the execution loop
  - buildPatchDiff synthesizes diff headers from result.execution.changedFiles or changedFiles fallback
  - softLimitUsd required by LoopBudget type — added to the new runtime test (deviation auto-fix)
metrics:
  duration: "6min"
  completed: "2026-04-03"
  tasks_completed: 4
  files_modified: 2
---

# Phase 8 Plan 02: Wire scanPatchForGroundingViolations into runMartin VERIFY Phase + Ledger Integration Summary

**One-liner:** Grounding scan wired into runMartin VERIFY phase with `grounding.violations_found` ledger event using synthetic diff headers from changedFiles.

## What Was Built

1. **Task 1 (read-only):** Mapped the VERIFY phase structure in index.ts — identified insertion point after filesystem leash check (line ~937) and before `attempt.kept`/`attempt.discarded`.

2. **Task 2 — Grounding scan wired into runMartin:**
   - Added grounding scan block in `packages/core/src/index.ts` after the filesystem leash check
   - Calls `loadOrBuildRepoGroundingIndex(input.task.repoRoot)` then `scanPatchForGroundingViolations`
   - Appends `grounding.violations_found` ledger event when `violations.length > 0` with: `violationCount`, `resolvedFiles`, `contentOnly`, `violations` (first 10)
   - Scan wrapped in try/catch — grounding errors never fail the loop
   - Added `buildPatchDiff` private helper that builds synthetic diff headers from `result.execution.changedFiles` or the `changedFiles` fallback from `resolveChangedFiles`

3. **Task 3 — Runtime test:**
   - Added test `"appends grounding.violations_found to ledger when patch references unindexed files"` to `packages/core/tests/runtime.test.ts`
   - Creates tmpdir with only `src/real.ts` in the grounding index
   - Runs `runMartin` with adapter returning `changedFiles: ["src/ghost-new-file.ts"]` (not in index)
   - Verifies `grounding.violations_found` event appears in ledger with `violationCount > 0`

4. **Task 4 — Full test suite + typecheck:**
   - `tsc --noEmit`: 0 errors
   - `pnpm --filter @martin/core test`: 55/55 passing, 0 failures

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Missing softLimitUsd in test budget object**
- **Found during:** Task 4 typecheck
- **Issue:** `LoopBudget.softLimitUsd` is required but was not included in the new grounding test's budget literal
- **Fix:** Added `softLimitUsd: 8` to the budget object in the grounding runtime test
- **Files modified:** `packages/core/tests/runtime.test.ts`
- **Commit:** 3890aba

## Known Stubs

None — all grounding scan logic is fully wired and uses real data paths.

## Commits

| Task | Commit | Description |
|------|--------|-------------|
| Task 2 | 326de6f | feat(08-02): wire scanPatchForGroundingViolations into runMartin VERIFY phase |
| Task 3 | f93f464 | test(08-02): add runtime test for grounding.violations_found ledger event |
| Task 4 | 3890aba | fix(08-02): add softLimitUsd to grounding test budget (required by LoopBudget type) |

## Self-Check: PASSED
