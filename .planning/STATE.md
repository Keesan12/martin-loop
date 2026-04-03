# Project State

## Current Phase
Phase 8 — Grounding Integrity (active)

## Current Plan
08-01 complete (2026-04-03). Next: 08-02 if planned, or phase complete.

## Last Action
Phase 8 Plan 01 complete (2026-04-03): challenge-set grounding tests (cases 1-5) + anatomy artifact persistence test + contentOnly field added to GroundingScanResult. 54 @martin/core tests passing, 0 failures, 0 type errors.

Phase 7 complete (2026-04-02): evaluation matrix, replay drills, variance study, and CTO-ready go/no-go reporting landed.
- Phase 5 complete: blocking safety enforcement, adapter normalization, fallback adapter rotation, and CLI/direct-provider ledger consistency
- Phase 6 complete: mock/demo control-plane data deleted, repository-backed Supabase read model added, Clerk auth wiring added, and local dashboard moved to honest empty/live states
- Phase 7 complete: A/B/C benchmark matrix, failure replay suite, safety incident drills, 21-run budget variance study, and generated go/no-go report artifacts
- Verification:
  - `pnpm --filter @martin/control-plane lint`
  - `pnpm --filter @martin/control-plane test`
  - `pnpm --filter @martin/benchmarks lint`
  - `pnpm --filter @martin/benchmarks test`
  - `pnpm --filter @martin/benchmarks eval:phase7`
- Output: `benchmarks/output/phase7-go-no-go-report.md` and `benchmarks/output/phase7-go-no-go-report.json` generated with verdict `GO`
- Handoff review: reviewed `martin-loop-complete-handoff-v5.zip` and used it as a cross-check while completing the grounding/policy and Phase 5-7 implementation passes

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
- No active milestone blockers for Phases 5-7. The remaining work is next-milestone planning, not unresolved Phase 6/7 implementation debt.

## Notes
- The old plan file (sharded-hopping-flask.md) was the v2 remediation plan. Now superseded.
- v6 pack requires a full rebuild, not incremental patches on existing architecture.
- CTO demo deliverable = Phase 6, which requires Phase 3 (persistence) first.
- martin-loop .git/ is a standalone repo nested inside "Setup Stuff/" — git commands must be run from inside martin-loop/ to target the correct repo.
- The v5 handoff reframes "hallucination" as "grounding violation" and reinforces preflight/admission/settlement as the Phase 4 budget control layers.

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
| 04-grounding-policy-engine | 04-01 | 2026-04-02 | 4 | 4 |
| 04-grounding-policy-engine | 04-02 | 2026-04-02 | 4 | 4 |
| 08-grounding-integrity | 08-01 | 3min | 7 | 2 |
