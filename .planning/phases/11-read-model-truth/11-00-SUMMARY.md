# Phase 11 Summary

Date: 2026-04-03
Status: complete

## What landed

- Added artifact-backed run ingestion in `apps/control-plane/lib/server/ingest-run-read-model.ts`
- Hydrated run and attempt truth from persisted artifacts:
  - `grounding-scan.json`
  - `leash.json`
  - `patch-score.json`
  - `patch-decision.json`
- Added `buildRunPortfolioViewModel()` so `/api/runs` returns nested attempt truth instead of inferred summaries
- Updated control-plane read models and view models to expose:
  - patch decision
  - grounding evidence
  - leash surface
  - budget variance
  - accounting mode
  - stop reason
- Hardened `apps/control-plane/app/layout.tsx` so missing Clerk env does not fake auth state or break builds

## Verification

```powershell
pnpm --filter @martin/control-plane test
pnpm --filter @martin/control-plane lint
pnpm --filter @martin/control-plane build
```

Latest result:

- `@martin/control-plane` tests: 36 passed, 0 failed
- `@martin/control-plane` lint: passed
- `@martin/control-plane` build: passed

## Files touched

- `apps/control-plane/app/api/runs/route.ts`
- `apps/control-plane/app/layout.tsx`
- `apps/control-plane/lib/server/control-plane-read-model.ts`
- `apps/control-plane/lib/server/control-plane-repository.ts`
- `apps/control-plane/lib/server/ingest-run-read-model.ts`
- `apps/control-plane/lib/server/supabase-repository.ts`
- `apps/control-plane/lib/view-models/executive-overview.ts`
- `apps/control-plane/lib/view-models/operator-economics.ts`
- `apps/control-plane/tests/control-plane-routes.test.ts`
- `apps/control-plane/tests/control-plane-queries.test.ts`
- `apps/control-plane/tests/control-plane-test-helpers.ts`
- `apps/control-plane/tests/ingest-run-read-model.test.ts`
