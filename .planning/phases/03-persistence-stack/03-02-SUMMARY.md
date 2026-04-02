---
phase: "03-persistence-stack"
plan: "02"
subsystem: "core/persistence"
tags: ["persistence", "runstore", "ledger", "context-compiler", "circular-import-fix"]
dependency_graph:
  requires: ["03-01"]
  provides: ["compileAndPersistContext", "runMartin-store-wiring", "persistence-tests"]
  affects: ["packages/core/src/index.ts", "packages/core/src/persistence/"]
tech_stack:
  added: []
  patterns: ["optional-store-guard", "append-only-ledger", "deterministic-packet-compiler"]
key_files:
  created:
    - "packages/core/src/compiler.ts"
    - "packages/core/src/persistence/compiler.ts"
    - "packages/core/tests/persistence.test.ts"
  modified:
    - "packages/core/src/index.ts"
    - "packages/core/src/persistence/index.ts"
decisions:
  - "Extracted compilePromptPacket to standalone compiler.ts to break circular import"
  - "persistence/compiler.ts imports from ../compiler.js (not ../index.js) — no cycle"
  - "All store calls in runMartin guarded with if (input.store) for backwards compatibility"
  - "currentAttemptIndex captured before attempt push to ensure correct index in store calls"
metrics:
  duration: "~20 minutes"
  completed: "2026-04-01"
  tasks_completed: 5
  files_created: 3
  files_modified: 2
---

# Phase 03 Plan 02: ContextCompiler + Wire RunStore into runMartin + Full Tests Summary

ContextCompiler added and RunStore wired into runMartin at every lifecycle boundary via optional store guards; circular import resolved by extracting compilePromptPacket into a standalone compiler module.

## Tasks Completed

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 | Create persistence/compiler.ts | 322950b | packages/core/src/compiler.ts, packages/core/src/persistence/compiler.ts |
| 2 | Export compileAndPersistContext from persistence index | 322950b | packages/core/src/persistence/index.ts |
| 3 | Wire RunStore into runMartin | 101d39c | packages/core/src/index.ts |
| 4 | Create persistence.test.ts | e57b285 | packages/core/tests/persistence.test.ts |
| 5 | Run full test suite | — | (verification only) |

## Files Created

- `packages/core/src/compiler.ts` — Standalone prompt packet compiler module. Exports `compilePromptPacket`, `PromptPacket`, `CompilerAdapterRequest`. Placed outside persistence/ to break the circular import.
- `packages/core/src/persistence/compiler.ts` — ContextCompiler. Exports `compileAndPersistContext` which calls `compilePromptPacket` and persists compiled-context.json + prompt.compiled ledger event when store is provided.
- `packages/core/tests/persistence.test.ts` — 7 test cases covering FileRunStore and ContextCompiler.

## Files Modified

- `packages/core/src/index.ts` — Removed inline `PromptPacket` interface and `compilePromptPacket` function. Added imports from `./compiler.js` and `makeLedgerEvent` from persistence. Added re-exports for compiler types and `compileAndPersistContext`. Added full store wiring in `runMartin`.
- `packages/core/src/persistence/index.ts` — Added `compileAndPersistContext` and `CompileResult` exports from `./compiler.js`.

## Test Results

| Suite | Before | After | Delta |
|-------|--------|-------|-------|
| packages/core (leash) | 5 | 5 | +0 |
| packages/core (runtime) | 10 | 10 | +0 |
| packages/core (grounding) | 3 | 3 | +0 |
| packages/core (persistence) | 0 | 7 | +7 |
| **packages/core total** | **18** | **25** | **+7** |
| packages/cli total | 16 | 16 | +0 |

All 25 packages/core tests pass. All 16 packages/cli tests pass. Zero failures.

## TypeScript

TypeScript error count: **0** (confirmed with `pnpm --filter @martin/core exec tsc --noEmit`).

## Circular Import Resolution

**Problem:** The plan's original `persistence/compiler.ts` imported `compilePromptPacket` from `"../index.js"`. But `index.ts` imports from `"./persistence/index.js"` which would import from `"./compiler.js"` — creating a runtime cycle.

**Solution:** Extracted `compilePromptPacket`, `PromptPacket`, and `CompilerAdapterRequest` into a new standalone module `packages/core/src/compiler.ts`. This module has no imports from persistence or index.

Import chain after fix (no cycles):
- `index.ts` imports from `./compiler.js` (no cycle)
- `index.ts` imports from `./persistence/index.js` (no cycle)
- `persistence/compiler.ts` imports from `"../compiler.js"` (not from `"../index.js"`) (no cycle)
- `persistence/index.ts` imports from `./compiler.js` (within persistence, no cycle)

`MartinAdapterRequest` in `index.ts` is structurally compatible with `CompilerAdapterRequest` from `compiler.ts` (same fields), so existing call sites work without modification.

## runMartin Store Wiring

Store calls added at these lifecycle boundaries (all guarded with `if (input.store)`):

1. **Run start** — `store.initRun(contract)` + `contract.created` ledger event
2. **Leash block exit** — `run.exited` ledger event
3. **Admission denied** — `attempt.rejected` + `run.exited` ledger events
4. **Admission passed** — `attempt.admitted` ledger event
5. **After attempt** — `writeAttemptArtifacts` with compiledContext, then `patch.generated`, `verification.completed`, `budget.settled`, `attempt.kept`/`attempt.discarded` ledger events
6. **Mid-loop exit (inferExit)** — `run.exited` ledger event
7. **Budget exhausted exit** — `run.exited` ledger event

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Resolved circular import before creating persistence/compiler.ts**
- **Found during:** Task 1 (pre-emptive fix per plan's critical watch-out)
- **Issue:** Plan's original compiler.ts imported from `"../index.js"`, creating index.ts → persistence/index.js → compiler.js → ../index.js cycle
- **Fix:** Created `packages/core/src/compiler.ts` as a standalone module. persistence/compiler.ts imports from `"../compiler.js"` instead. index.ts re-exports from `"./compiler.js"`.
- **Files modified:** packages/core/src/compiler.ts (new), packages/core/src/persistence/compiler.ts (modified import), packages/core/src/index.ts (added import, removed inline definitions)
- **Commit:** 322950b

**2. [Rule 1 - Bug] Removed unused type imports from index.ts**
- **Found during:** Task 1 cleanup
- **Issue:** `LoopCost`, `LoopLifecycleState`, `LoopStatus` were imported from `@martin/contracts` but became unused after removing the inline `PromptPacket` interface
- **Fix:** Removed the three unused type imports
- **Files modified:** packages/core/src/index.ts
- **Commit:** 322950b

**3. [Rule 2 - Missing functionality] Added run.exited to leash-blocked exit path**
- **Found during:** Task 3
- **Issue:** Plan specified run.exited on every exit path but the leash block return was not mentioned in plan's exit path list
- **Fix:** Added run.exited ledger call to the leash-blocked return path
- **Commit:** 101d39c

**4. [Rule 2 - Missing functionality] Removed unused createLoopRecord import from test file**
- **Found during:** Task 4
- **Issue:** Plan's test template imported `createLoopRecord` from `@martin/contracts` but none of the test bodies actually use it — tests call `store.initRun` directly
- **Fix:** Removed the unused import from persistence.test.ts
- **Commit:** e57b285

## Known Stubs

None — all persistence logic is fully implemented and writing to disk.

## Self-Check: PASSED

Files exist:
- packages/core/src/compiler.ts: FOUND
- packages/core/src/persistence/compiler.ts: FOUND
- packages/core/tests/persistence.test.ts: FOUND

Commits exist:
- 322950b: FOUND
- 101d39c: FOUND
- e57b285: FOUND

TypeScript: 0 errors
Tests: 25/25 passing (packages/core), 16/16 passing (packages/cli)
