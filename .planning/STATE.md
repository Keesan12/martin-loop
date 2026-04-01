# Project State

## Current Phase
Phase 1 — Repo Surgery (in progress)

## Current Plan
Plan 1 of 3 in Phase 1 — COMPLETE (01-01: Git Init, Branch Setup, Gitignore Hardening)
Next: 01-02 (source file staging and cleanup)

## Last Action
Completed 01-01-PLAN.md — standalone git repo initialized in martin-loop/, hardened .gitignore committed, rebuild/v4-controller branch created and checked out.

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
