---
phase: 02-runtime-state-machine
plan: "02-02"
subsystem: core-tests
tags: [testing, vitest, phase-transitions, safety-leash, grounding]
dependency_graph:
  requires: ["02-01"]
  provides: ["R2.6 test coverage", "compilePromptPacket tests", "evaluateAttemptPolicy tests", "evaluateVerificationLeash tests", "buildRepoGroundingIndex tests"]
  affects: ["packages/core/tests/"]
tech_stack:
  added: []
  patterns: ["vitest describe/it", "tmpdir async tests", "admission gate unit tests"]
key_files:
  created:
    - packages/core/tests/leash.test.ts
    - packages/core/tests/grounding.test.ts
  modified:
    - packages/core/tests/runtime.test.ts
decisions:
  - "Used Edit tool to add new test blocks to runtime.test.ts without replacing existing tests"
  - "classifyFailure grounding test placed in leash.test.ts (logical grouping with other failure-related tests)"
  - "grounding tests use async mkdtemp for isolated tmpdir creation per test"
metrics:
  duration: "~8 minutes"
  completed: "2026-04-02T02:59:47Z"
  tasks_completed: 4
  files_modified: 3
---

# Phase 02 Plan 02: Test Coverage — Phase Transitions, Leash, Grounding, Admission Summary

**One-liner:** Vitest coverage added for compilePromptPacket admission control, evaluateAttemptPolicy oscillation/budget gates, safety leash destructive-command blocking, and grounding index scoring.

## What Was Done

- Updated `packages/core/tests/runtime.test.ts` to import `compilePromptPacket` and `evaluateAttemptPolicy` from `../src/index.js`
- Added `describe("compilePromptPacket")` block with 1 test: deterministic packet compilation with prior failure pattern encoding and attemptNumber calculation
- Added `describe("evaluateAttemptPolicy")` block with 3 tests: budget gate denial, oscillation detection (A/B/A failure class pattern), materially repetitive attempt detection
- Created `packages/core/tests/leash.test.ts` with 5 tests: 4 for `evaluateVerificationLeash` (destructive command blocking, safe command allowance, git reset blocking, curl-pipe-bash blocking) and 1 for `classifyFailure` repo grounding failure mapping
- Created `packages/core/tests/grounding.test.ts` with 3 async tests: file indexing with symbol extraction and scored query retrieval, empty-hit return when query has no matching terms, limit parameter enforcement on `queryRepoGroundingIndex`

## Test Counts

| | Count |
|---|---|
| Tests before (02-02) | 8 (runtime.test.ts only) |
| Tests after (02-02) | 18 total across 3 files |
| New tests added | 10 |

## All Test Names Added

**runtime.test.ts — compilePromptPacket:**
- "rebuilds a minimal deterministic packet from structured request state"

**runtime.test.ts — evaluateAttemptPolicy:**
- "denies attempts that exceed remaining budget"
- "denies oscillating loops instead of blindly retrying"
- "denies materially repetitive attempts even when the failure label changes"

**leash.test.ts — evaluateVerificationLeash:**
- "blocks destructive verifier commands before the run starts"
- "allows standard test and build commands"
- "blocks git reset --hard in verification stack"
- "blocks curl-pipe-bash patterns"

**leash.test.ts — classifyFailure repo grounding:**
- "maps missing repo modules to repo_grounding_failure"

**grounding.test.ts — repo grounding index:**
- "indexes repo files and returns relevant hits for the current objective"
- "returns empty hits when the query has no matching terms"
- "respects the limit parameter"

## Failures Encountered

None. All 18 tests passed on the first run.

## Final Test Result

```
Test Files  3 passed (3)
      Tests  18 passed (18)
   Duration  896ms
```

## Deviations from Plan

None — plan executed exactly as written.

## Commits

| Hash | Message |
|---|---|
| 61f5eac | test(02-02): add compilePromptPacket and evaluateAttemptPolicy test suites |
| ffbfcf3 | test(02-02): add evaluateVerificationLeash and classifyFailure grounding tests |
| aba0e26 | test(02-02): add repo grounding index tests |

## Self-Check: PASSED

- packages/core/tests/runtime.test.ts: FOUND
- packages/core/tests/leash.test.ts: FOUND
- packages/core/tests/grounding.test.ts: FOUND
- Commits 61f5eac, ffbfcf3, aba0e26: FOUND
