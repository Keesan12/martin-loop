---
phase: "03-persistence-stack"
plan: "01"
subsystem: "persistence"
tags: ["persistence", "ledger", "run-store", "file-system", "cli"]
dependency_graph:
  requires: ["@martin/contracts.MachineState", "@martin/contracts.LoopRecord"]
  provides: ["RunStore", "FileRunStore", "LedgerEvent", "persistLoopArtifacts"]
  affects: ["@martin/core", "@martin/cli"]
tech_stack:
  added: ["node:fs/promises", "node:os", "node:path"]
  patterns: ["RunStore interface isolation", "append-only JSONL ledger", "flat runId path structure"]
key_files:
  created:
    - "packages/core/src/persistence/ledger.ts"
    - "packages/core/src/persistence/store.ts"
    - "packages/core/src/persistence/index.ts"
    - "packages/cli/src/persistence.ts"
    - "packages/cli/tests/persistence.test.ts"
  modified:
    - "packages/core/src/index.ts"
decisions:
  - "LedgerEventKind is a separate write-side union from LoopEventType — keeps read/write models independent"
  - "FileRunStore uses flat ~/.martin/runs/<runId>/ path (not nested workspaceId/loopId)"
  - "RunStore accepted as optional on RunMartinInput — zero-cost abstraction, existing callers unaffected"
metrics:
  duration: "~10 minutes"
  completed: "2026-04-01"
  tasks_completed: 7
  files_created: 5
  files_modified: 1
  typescript_errors: 0
---

# Phase 03 Plan 01: RunStore Foundation — Ledger Types, FileRunStore, CLI Persistence Shim Summary

**One-liner:** FileRunStore writes contract.json, state.json, ledger.jsonl, and attempt artifacts to `~/.martin/runs/<runId>/` via a typed RunStore interface that isolates persistence from orchestration.

## What Was Built

The Phase 3 persistence foundation: a typed abstraction layer between the `runMartin` orchestrator and the filesystem, plus a CLI-level helper for persisting full `LoopRecord` data at run completion.

### packages/core/src/persistence/ledger.ts
- `LedgerEventKind` union covering all 12 required write-side event types
- `LedgerEvent` and `LedgerEventDraft` interfaces with kind, runId, timestamp, payload
- `makeLedgerEvent` factory with optional timestamp injection

### packages/core/src/persistence/store.ts
- `RunContract` interface (immutable, written at run start)
- `AttemptArtifacts` interface (per-attempt compiled context, diff, verifier output, grounding scan)
- `RunStore` interface with 4 methods: `initRun`, `updateState`, `appendLedger`, `writeAttemptArtifacts`
- `createFileRunStore` factory that writes to `~/.martin/runs/<runId>/`
- `resolveRunsRoot`, `runDir`, `artifactDir` path helpers

### packages/core/src/persistence/index.ts
- Barrel export for the entire persistence module

### packages/core/src/index.ts (modified)
- Re-exports `createFileRunStore`, `makeLedgerEvent`, `resolveRunsRoot`
- Type-exports `RunStore`, `RunContract`, `AttemptArtifacts`, `LedgerEvent`, `LedgerEventKind`
- Added optional `store?: RunStore` field to `RunMartinInput`

### packages/cli/src/persistence.ts
- `persistLoopArtifacts(loop, { runsRoot? })` — writes full LoopRecord artifacts at run completion
- Uses Phase 3 flat path `~/.martin/runs/<loopId>/` (not nested `<workspaceId>/<loopId>`)
- Uses `ledger.jsonl` (not `events.jsonl`)

### packages/cli/tests/persistence.test.ts
- 2 tests: artifact correctness and flat path structure verification

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] RunStore type not imported into core/index.ts**
- **Found during:** Task 7 (typecheck)
- **Issue:** `store?: RunStore` field was added to `RunMartinInput` but `RunStore` was only re-exported with `export type`, not imported for local use — TypeScript reported `Cannot find name 'RunStore'` at line 309
- **Fix:** Added `import { type RunStore } from "./persistence/index.js"` to the imports section of `packages/core/src/index.ts`
- **Files modified:** `packages/core/src/persistence/store.ts` also added `/// <reference types="node" />` at top for `NodeJS.ProcessEnv` type safety
- **Commit:** 6bd441a

## TypeScript Errors
0 — `pnpm --filter @martin/core exec tsc --noEmit` exits clean.

## Test Results
16 tests pass across 3 test files in `@martin/cli`:
- `persistence.test.ts` — 2 new tests (PASS)
- `cli.test.ts` — 6 existing tests (PASS)
- `cli-integration.test.ts` — 8 existing tests (PASS)

## Commits
- `229694e` feat(03-01): add LedgerEvent types and makeLedgerEvent factory
- `3a331bd` feat(03-01): add RunStore interface and FileRunStore implementation
- `be5b8c6` feat(03-01): add persistence barrel export
- `c21a6a6` feat(03-01): export persistence module from core and add store to RunMartinInput
- `b1b95c6` feat(03-01): add CLI persistLoopArtifacts with Phase 3 ledger.jsonl path
- `ed37450` test(03-01): add persistence.test.ts for persistLoopArtifacts
- `6bd441a` fix(03-01): import RunStore type into core/index.ts for use in RunMartinInput

## Known Stubs
None — all code paths write real filesystem output. The `store` field on `RunMartinInput` is wired as optional; actual call sites hooking the store into the run loop are Phase 3 follow-on work.

## Self-Check: PASSED

All 5 created files confirmed present on disk. All 7 task commits confirmed in git log. TypeScript 0 errors verified. 16/16 tests passing.
