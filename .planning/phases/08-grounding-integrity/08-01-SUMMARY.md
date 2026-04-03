---
phase: 08-grounding-integrity
plan: "01"
subsystem: grounding
tags: [grounding, tests, challenge-set, anatomy, contentOnly]
dependency_graph:
  requires: []
  provides: [challenge-set-grounding-tests, anatomy-persistence-test, contentOnly-field]
  affects: [packages/core/src/grounding.ts, packages/core/tests/grounding.test.ts]
tech_stack:
  added: []
  patterns: [vitest, tmpdir-isolation, schema-validation]
key_files:
  created: []
  modified:
    - packages/core/tests/grounding.test.ts
    - packages/core/src/grounding.ts
decisions:
  - "Challenge 2 assertion adjusted: scanner catches all unindexed symbols in added lines — test checks that phantomHelper is among violations rather than asserting it is the only one"
  - "contentOnly computed after substantive-line regex: any + line that is not a comment, whitespace, or empty line is substantive"
metrics:
  duration: "3 minutes"
  completed: "2026-04-03"
  tasks_completed: 7
  files_modified: 2
requirements: [H-02, H-03]
---

# Phase 8 Plan 01: Challenge-Set Grounding Tests (Cases 1-5) + Anatomy Persistence Summary

## One-liner

Six targeted grounding tests covering the v6 failure-mode challenge set (import_not_found, symbol_not_found, two patch_outside_allowed_paths cases, content-only diff) plus anatomy artifact disk-write and schema verification — all 54 @martin/core tests pass with 0 failures.

## What Was Built

Added 6 missing tests to `packages/core/tests/grounding.test.ts` and one production change to `packages/core/src/grounding.ts`:

### Production Change (grounding.ts)
- Added `contentOnly: boolean` field to `GroundingScanResult` interface
- Computed `contentOnly` in `scanPatchForGroundingViolations` using regex: any added line that is not a comment (`//`, `/*`, `*`, `#`), whitespace, or empty is "substantive"; if no substantive lines exist and the diff contains `+` lines, `contentOnly` is `true`

### New Tests (grounding.test.ts)

| Test | Violation Kind | Pass |
|------|---------------|------|
| Challenge 1: fake relative import | `import_not_found` | Yes |
| Challenge 2: unindexed phantomHelper | `symbol_not_found` | Yes |
| Challenge 3: package.json outside src/** | `patch_outside_allowed_paths` | Yes |
| Challenge 4: control-plane outside packages/core/** | `patch_outside_allowed_paths` | Yes |
| Challenge 5: comment-only diff | `contentOnly: true` | Yes |
| Anatomy artifact persistence | Schema fields + disk write | Yes |

## Commits

| Task | Commit | Message |
|------|--------|---------|
| 2 | 9b040de | test(08-01): add challenge 1 — import_not_found for fake relative import |
| 3 | 705155a | test(08-01): add challenge 2 — symbol_not_found for unindexed phantomHelper |
| 4 | 8bd8bbe | test(08-01): add challenges 3 and 4 — package.json scope and control-plane scope violations |
| 5 | e04db06 | feat(08-01): add contentOnly field to GroundingScanResult and challenge 5 test |
| 6 | 58a1390 | test(08-01): add anatomy artifact persistence test verifying disk write and schema validity |

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Challenge 2 assertion corrected for scanner behavior**
- **Found during:** Task 3 — first run of challenge 2 test
- **Issue:** Plan specified `expect(symbolViolation?.reference).toBe("phantomHelper")` using `.find()` to get the first `symbol_not_found` violation. The scanner processes added lines top-to-bottom and catches `processData` (the function declaration) before `phantomHelper` (the call expression). Both are unindexed symbols, so both produce violations.
- **Fix:** Changed assertion to use `.filter()` for all `symbol_not_found` violations, then find `phantomHelper` specifically: `symbolViolations.find((v) => v.reference === "phantomHelper")`. This accurately verifies that `phantomHelper` is caught without depending on ordering.
- **Files modified:** packages/core/tests/grounding.test.ts
- **Commit:** 705155a

## Verification Results

- `pnpm --filter @martin/core test`: 54 tests, 5 test files, 0 failures
- `pnpm --filter @martin/core exec tsc --noEmit`: 0 type errors

## Known Stubs

None. All test assertions verify real behavior against real implementations.

## Self-Check: PASSED

- packages/core/tests/grounding.test.ts: FOUND
- packages/core/src/grounding.ts: FOUND
- Commit 9b040de: FOUND
- Commit 705155a: FOUND
- Commit 8bd8bbe: FOUND
- Commit e04db06: FOUND
- Commit 58a1390: FOUND
