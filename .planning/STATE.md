# Project State

## Current Phase
Phase 1 — Repo Surgery (in progress)

## Current Plan
Plan 2 of 3 in Phase 1 — COMPLETE (01-02: Root Cleanup, Legacy Docs Relocation)
Next: 01-03 (README.md — running in parallel, may already be complete)

## Last Action
Completed 01-02-PLAN.md — legacy docs moved to docs/legacy/, MartinLoop V3 3-31-2026/ and demo/ added to .gitignore, root now contains only canonical project files.

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

## Performance Metrics
| Phase | Plan | Duration | Tasks | Files |
|-------|------|----------|-------|-------|
| 01-repo-surgery | 01 | 18min | 2 | 2 |
| 01-repo-surgery | 02 | 12min | 1 | 4 |
