# Current State

## Executive Summary

The Martin Loop rebuild is materially implemented through Phases 1-7 in this repository. The next engineer should treat this handoff as the start of the hardening and certification push, not as an initial build-out.

The repo already contains:

- Phase 5 blocking safety and adapter normalization work
- Phase 6 real control-plane and local-dashboard data plumbing
- Phase 7 benchmark, replay, safety-drill, and go/no-go reporting infrastructure

The next highest-value work is the v6 hardening program captured in `NEXT-HARDENING.md` and the copied reference docs under `references/v6-hardening/`.

## Phase 5 Already Landed

Phase 5 work is already present in the repo and should be treated as the current baseline:

- Blocking safety enforcement in `packages/core/src/index.ts` and `packages/core/src/leash.ts`
- Prompt redaction and safety-oriented context handling in `packages/core/src/compiler.ts`
- Adapter normalization and subprocess hardening in:
  - `packages/adapters/src/claude-cli.ts`
  - `packages/adapters/src/cli-bridge.ts`
  - `packages/adapters/src/runtime-support.ts`
  - `packages/adapters/src/direct-provider.ts`
  - `packages/adapters/src/stub-direct-provider.ts`
- Runtime and adapter coverage in:
  - `packages/core/tests/runtime.test.ts`
  - `packages/core/tests/leash.test.ts`
  - `packages/adapters/tests/claude-cli.test.ts`
  - `packages/adapters/tests/stub-adapters.test.ts`
  - `packages/cli/tests/cli-integration.test.ts`

## Phase 6 Landed

Phase 6 removed demo/mock control-plane behavior and replaced it with real repository-backed read models plus auth-aware routing.

Primary files:

- `apps/control-plane/lib/server/auth.ts`
- `apps/control-plane/lib/server/control-plane-repository.ts`
- `apps/control-plane/lib/server/supabase-repository.ts`
- `apps/control-plane/lib/server/ingest-run-read-model.ts`
- `apps/control-plane/lib/server/control-plane-read-model.ts`
- `apps/control-plane/app/api/runs/route.ts`
- `apps/control-plane/app/api/runs/[runId]/route.ts`
- `apps/control-plane/app/api/queue/route.ts`
- `apps/control-plane/middleware.ts`
- `apps/local-dashboard/data/live-run-data.js`
- `apps/local-dashboard/server.js`

Files removed earlier as part of this cleanup:

- `apps/control-plane/lib/data/mock-control-plane-data.ts`
- `apps/local-dashboard/data/demo-data.js`

## Phase 7 Landed

Phase 7 added a real evaluation and reporting surface for release decisions.

Primary files:

- `benchmarks/fixtures/phase7-variants.json`
- `benchmarks/src/scripted-runtime.ts`
- `benchmarks/src/comparison.ts`
- `benchmarks/src/phase7.ts`
- `benchmarks/src/phase7-report.ts`
- `benchmarks/tests/phase7-eval.test.ts`
- `benchmarks/src/index.ts`
- `benchmarks/src/types.ts`
- `benchmarks/package.json`
- `benchmarks/tsconfig.json`

Generated artifacts:

- `benchmarks/output/phase7-go-no-go-report.md`
- `benchmarks/output/phase7-go-no-go-report.json`

## Planning State

Planning docs were updated to reflect completion of Phases 5-7:

- `.planning/ROADMAP.md`
- `.planning/STATE.md`

The roadmap currently marks Phases 5, 6, and 7 complete. The next engineer should not reopen those phases as planning exercises unless a new scope change requires it.

## Recommended Starting Point

Start with `NEXT-HARDENING.md`.

That document translates the newly attached v6 hardening pack into a concrete continuation path from the current repo state.
