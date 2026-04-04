# Phase 9 Rolling Verification

Date: 2026-04-03
Status: in_progress

## Challenge Coverage

- Challenge 10: unsafe verifier commands are blocked before adapter execution and emit `safety.violations_found`
- Challenge 11: forbidden path writes are discarded and exit with `human_escalation`
- Challenge 12: outbound network commands are blocked in `strict_local`
- Challenge 13: dependency and deployment/config changes require explicit approval and persist `leash.json`

## Evidence

- `packages/core/tests/runtime.test.ts`
  - `challenge 10: emits safety.violations_found before run.exited when the verifier plan contains an unsafe shell command`
  - `challenge 11: discards the attempt and exits with human escalation when a forbidden path write is detected`
  - `challenge 12: blocks network access in strict_local before adapter execution`
  - `challenge 13: blocks dependency-related changes without approval and persists leash.json`
  - `blocks deployment config changes without approval and persists the config violation artifact`
- `packages/core/tests/leash.test.ts`
  - `challenge 12: blocks outbound network commands in strict_local`
  - `challenge 13: requires approval before dependency-related files can change`
  - `requires approval before deployment or config files can change`
  - `allows deployment config changes when config approval is explicitly granted`

## Commands Run

```powershell
pnpm --filter @martin/core test
pnpm --filter @martin/contracts build
pnpm --filter @martin/core build
```

## Latest Results

- `@martin/core` tests: 66 passed, 0 failed
- `@martin/contracts` build: passed
- `@martin/core` build: passed

## Notes

- `@martin/core build` initially failed because `@martin/contracts` had stale `dist/` output. Rebuilding `@martin/contracts` refreshed the exported trust-profile types and restored a clean package boundary.
- Remaining Phase 9 work is now focused on broader profile policy depth, not the core challenge 10-13 coverage.
