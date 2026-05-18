---
phase: 02-runtime-state-machine
plan: "01"
title: "Import Slice Work + Contract Type Additions"
subsystem: core
tags: [policy, leash, grounding, contracts, state-machine]
dependency_graph:
  requires: []
  provides:
    - PolicyPhase (contracts)
    - EvidenceVector (contracts)
    - MachineState (contracts)
    - classifyFailure (core/policy)
    - evaluateCostGovernor (core/policy)
    - inferExit (core/policy)
    - nextPolicyPhase (core/policy)
    - policyPhaseToLifecycleState (core/policy)
    - evaluateVerificationLeash (core/leash)
    - buildRepoGroundingIndex (core/grounding)
    - queryRepoGroundingIndex (core/grounding)
    - loadOrBuildRepoGroundingIndex (core/grounding)
    - compilePromptPacket (core/index)
    - evaluateAttemptPolicy (core/index)
  affects:
    - packages/core/src/index.ts (re-exports)
    - packages/contracts/src/index.ts (extended)
tech_stack:
  added: []
  patterns:
    - Explicit PolicyPhase state machine (GATHER→ADMIT→PATCH→VERIFY→RECOVER→ESCALATE→ABORT→HANDOFF)
    - Safety leash enforcement with regex pattern matching
    - Repo grounding index with symbol/keyword extraction and LRU-style file cache
    - Deterministic PromptPacket compilation for adapter requests
key_files:
  created:
    - packages/core/src/policy.ts
    - packages/core/src/leash.ts
    - packages/core/src/grounding.ts
  modified:
    - packages/contracts/src/index.ts
    - packages/core/src/index.ts
decisions:
  - PolicyPhase is a union type (not enum) to align with existing contracts conventions
  - MartinAdapterResultLike has optional usage field for structural compatibility with MartinAdapterResult
  - CostGovernorState/ExitDecision/FailureAssessment are re-exported only from ./policy.js to avoid duplicate export errors
  - SafetyLeashDecision is re-exported separately from ./leash.js
metrics:
  duration: "~12 minutes"
  completed: "2026-04-01"
  tasks_completed: 6
  tasks_total: 6
  files_created: 3
  files_modified: 2
---

# Phase 02 Plan 01: Import Slice Work + Contract Type Additions Summary

Policy engine, safety leash, and repo grounding index extracted into dedicated modules; PolicyPhase state machine and three new contract types wired into contracts and core.

## What Was Done

- Added `PolicyPhase` (8-value union), `EvidenceVector` (10 fields), and `MachineState` (9 fields) to `packages/contracts/src/index.ts`
- Created `packages/core/src/policy.ts` with the full policy engine: `classifyFailure`, `evaluateCostGovernor`, `inferExit`, `nextPolicyPhase`, `policyPhaseToLifecycleState`
- Created `packages/core/src/leash.ts` with `evaluateVerificationLeash` enforcing 14 destructive-command block patterns
- Created `packages/core/src/grounding.ts` with `buildRepoGroundingIndex`, `queryRepoGroundingIndex`, and `loadOrBuildRepoGroundingIndex` with cache persistence
- Rewrote `packages/core/src/index.ts` to import from the three new modules, add `compilePromptPacket` and `evaluateAttemptPolicy`, and wire the PolicyPhase state machine into `runMartin`
- Ran `tsc --noEmit` on both packages; fixed one type compatibility issue (see Deviations)

## Files Created

| File | Purpose |
|---|---|
| `packages/core/src/policy.ts` | Policy engine: failure classification, cost governor, exit inference, phase transitions |
| `packages/core/src/leash.ts` | Safety leash: destructive verifier command blocking |
| `packages/core/src/grounding.ts` | Repo grounding index: file scanning, symbol extraction, keyword search |

## Files Modified

| File | Change |
|---|---|
| `packages/contracts/src/index.ts` | Added PolicyPhase, EvidenceVector, MachineState exports |
| `packages/core/src/index.ts` | Full rewrite to wire in new modules, add compilePromptPacket + evaluateAttemptPolicy |

## TypeScript Error Count

0 errors after fix.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Fixed MartinAdapterResultLike missing optional usage field**
- **Found during:** Task 6 (typecheck)
- **Issue:** Tests pass `MartinAdapterResult` objects (which include `usage`) to `classifyFailure` and `inferExit`. These functions accept `MartinAdapterResultLike` from `policy.ts`, which did not include `usage`. TypeScript reported TS2353 errors in `tests/runtime.test.ts` at lines 93 and 173.
- **Fix:** Added `usage` as an optional field to `MartinAdapterResultLike` in `policy.ts`. This maintains structural compatibility without requiring tests to strip the field.
- **Files modified:** `packages/core/src/policy.ts`
- **Commit:** ed2e6a3

**2. [Rule 1 - Duplicate Export Prevention] Removed duplicate type exports**
- **Found during:** Task 5 (plan review)
- **Issue:** The plan template had `CostGovernorState`, `ExitDecision`, `FailureAssessment` listed in two `export type` blocks (from `./leash.js` AND `./policy.js`), which would cause a duplicate identifier error at compile time.
- **Fix:** Exported `CostGovernorState`, `ExitDecision`, `FailureAssessment` only from `./policy.js`. Exported `SafetyLeashDecision` separately from `./leash.js`.
- **Files modified:** `packages/core/src/index.ts`
- **Commit:** 396d83a (applied inline during task execution, no separate commit needed)

## Commits

| Hash | Message |
|---|---|
| 1ff2d0a | feat(02-01): add PolicyPhase, EvidenceVector, MachineState to contracts |
| 07be3e2 | feat(02-01): create packages/core/src/policy.ts |
| 57b4a4b | feat(02-01): create packages/core/src/leash.ts |
| 966e56d | feat(02-01): create packages/core/src/grounding.ts |
| 396d83a | feat(02-01): rewrite core/src/index.ts to wire in policy, leash, grounding modules |
| ed2e6a3 | fix(02-01): add optional usage field to MartinAdapterResultLike for test compatibility |

## Self-Check: PASSED

All created files exist and all commits are present in git log.
