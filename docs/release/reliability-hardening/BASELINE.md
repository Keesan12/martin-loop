# Reliability Hardening Baseline

Date: 2026-06-08

## Public Package Truth

- `martin-loop`: `0.3.2`
- `@martinloop/mcp`: `0.3.1`

## Baseline Goal

Confirm the promotion candidate starts from a clean, reproducible baseline before reliability hardening changes are promoted.

## Baseline Checks

```bash
pnpm public:copy-scan
pnpm public:git-surface
node --test scripts/tests/readme-public-surface.test.mjs
```

These checks must pass before and after reliability hardening changes.

## Required Promotion Gates

```bash
pnpm test
pnpm build
pnpm release:validate-local
pnpm release:matrix:local
pnpm public:copy-scan
pnpm public:git-surface
pnpm --filter @martinloop/mcp verify:release
```

No public release action should happen unless these gates are green on the exact commit being promoted.
