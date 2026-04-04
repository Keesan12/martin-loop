# Phase 9 Slice 1-2 Summary

Date: 2026-04-03
Status: in_progress

## What landed

- Added explicit Phase 9 trust-profile types to contracts:
  - `ExecutionProfile`
  - `ApprovalPolicy`
- Extended `LoopTask` with:
  - `executionProfile`
  - `allowedNetworkDomains`
  - `approvalPolicy`
- Added profile resolution in `packages/core/src/leash.ts` via `resolveExecutionProfile()`
- Added network enforcement in `evaluateVerificationLeash()`:
  - `strict_local` blocks outbound network commands
  - `staging_controlled` allows allowlisted domains only
- Added dependency/migration approval enforcement via `evaluateChangeApprovalLeash()`
- Added config/deployment approval enforcement via `evaluateChangeApprovalLeash()`
  - blocks `vercel.json`, `.github/workflows/*`, and other deployment/config files unless `approvalPolicy.configChanges` is granted
- Wired dependency-approval blocking into `runMartin()` after patch generation and changed-file resolution
- Persisted attempt-scoped safety artifacts as `artifacts/attempt-XXX/leash.json`
- Added profile test coverage for `research_untrusted`

## Challenge coverage now present

- Challenge 10: unsafe shell command in verifier plan
- Challenge 11: forbidden path write
- Challenge 12: network access attempt in `strict_local`
- Challenge 13: dependency-related change without approval
- Challenge 13 extension: deployment/config change without approval

## Verification run

```powershell
pnpm --filter @martin/core test
pnpm --filter @martin/contracts build
pnpm --filter @martin/core build
```

Latest result:

- `@martin/core` tests: 66 passed, 0 failed
- `@martin/contracts` build: passed
- `@martin/core` build: passed

## Files touched in this slice

- `packages/contracts/src/index.ts`
- `packages/core/src/index.ts`
- `packages/core/src/leash.ts`
- `packages/core/src/persistence/store.ts`
- `packages/core/tests/leash.test.ts`
- `packages/core/tests/persistence.test.ts`
- `packages/core/tests/runtime.test.ts`
- `.planning/STATE.md`
- `.planning/phases/09-safety-leash-v2/09-01-VERIFICATION.md`

## Still remaining inside Phase 9

- Add stronger profile coverage for `ci_safe` and `research_untrusted`
- Decide whether command evaluation should move from denylist-only to a stricter allowlist engine
- Add profile-specific patch/file-count/time/spend ceilings if the next slice needs them
- Expand rolling-cert artifacts beyond challenges 10-13 if the CTO pack requires per-profile evidence bundles
