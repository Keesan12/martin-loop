# Project State

## Current Phase
Phase 3 — Persistence Stack (planned, executing)

## Current Plan
Plan 2 of 2 in Phase 3 — COMPLETE (03-02: ContextCompiler + RunStore wiring + full tests)

## Last Action
Phase 3 complete (2026-04-01): 25 tests passing in @martin/core, 16 in @martin/cli. All 03-02 tasks done.
- 03-01: RunStore interface + FileRunStore + LedgerEvent types (12 kinds) + CLI persistence shim
- 03-02: ContextCompiler + wire RunStore into runMartin at all lifecycle boundaries + 7 new persistence tests
Circular import resolved: compilePromptPacket extracted to packages/core/src/compiler.ts.
Phase 2 complete (2026-04-02): 18 tests passing across runtime/leash/grounding.
Previous: Phase 2 planned. 2 plans created:
- 02-01-PLAN.md: Import engineer slice work (policy.ts, leash.ts, grounding.ts) + add PolicyPhase/EvidenceVector/MachineState to contracts + wire compilePromptPacket and evaluateAttemptPolicy into core/src/index.ts
- 02-02-PLAN.md: Full test coverage for all new Phase 2 APIs

Handoff zip analyzed: slices 1-8 implemented policy, leash, grounding modules. Phase 2 plans wire all of that into the tracked repo and add test coverage.

## Active Decisions
- Database: Supabase (Postgres)
- Auth: Clerk
- Package manager: bun
- Branch: rebuild/v4-controller (created and active)
- Granularity: Standard (5-8 phases)
- Parallelization: Yes
- git init run inside martin-loop/ as standalone repo — parent Setup Stuff repo must not track martin-loop files
- Initial commit contains ONLY .gitignore so no noise ever enters git history
- rebuild/v4-controller is the working branch; main contains only the .gitignore baseline commit
- Legacy reference docs (ENGINEERING.md, HANDOVER.md, OPEN-ME-FIRST.html) live in docs/legacy/ — not root
- Historical directories and demo artifacts excluded via explicit .gitignore entries (not deleted from disk)
- Used plain mv (not git mv) for relocating untracked files — correct approach for freshly initialized repo

## Key Constraints
- Do not proceed to Phase 6 (control plane) without Phase 3 (persistence) complete
- Delete mock-control-plane-data.ts — do not refactor it, do not wrap it, delete it
- Delete demo-data.js — same rule
- Non-goals: multi-tenant billing, demo pathways in production, natural language as canonical state

## Blockers
None.

## Notes
- The old plan file (sharded-hopping-flask.md) was the v2 remediation plan. Now superseded.
- v6 pack requires a full rebuild, not incremental patches on existing architecture.
- CTO demo deliverable = Phase 6, which requires Phase 3 (persistence) first.
- martin-loop .git/ is a standalone repo nested inside "Setup Stuff/" — git commands must be run from inside martin-loop/ to target the correct repo.

## Active Decisions (Phase 2)
- Slice work (policy.ts, leash.ts, grounding.ts) from engineer's handoff is imported as-is into working repo
- compilePromptPacket and evaluateAttemptPolicy are NEW additions not in handoff (required by tests)
- PolicyPhase, EvidenceVector, MachineState added to packages/contracts/src/index.ts
- FailureClass kept as thin output label only (R2.5) — policy reads EvidenceVector, not the label
- runMartin explicitly tracks currentPhase (PolicyPhase state machine variable)

## Performance Metrics
| Phase | Plan | Duration | Tasks | Files |
|-------|------|----------|-------|-------|
| 01-repo-surgery | 01 | 18min | 2 | 2 |
| 01-repo-surgery | 02 | 12min | 1 | 4 |
| 01-repo-surgery | 03 | 8min | 1 | 1 |
| 02-runtime-state-machine | 02-01 | (prior) | 4 | 5 |
| 02-runtime-state-machine | 02-02 | 8min | 4 | 3 |
