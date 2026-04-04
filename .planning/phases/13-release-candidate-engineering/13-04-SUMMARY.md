# Phase 13 Slice 04 Summary

## Goal

Make the frozen public package surface real inside the repo:

- `npm install martin-loop`
- `npx martin-loop`
- `import { MartinLoop } from "martin-loop"`

## What landed

- Root `package.json` now exposes the real public facade:
  - package name `martin-loop`
  - root `exports` map
  - root `main` and `types`
  - root `bin` entry for `martin-loop`
  - root `files` allowlist and public publish config
- Added `scripts/build-public-facade.mjs` to generate a self-contained `dist/` facade that vendors the built OSS runtime packages and rewrites internal package imports to relative paths.
- Added `scripts/public-facade-smoke.mjs` plus tests to prove a clean temporary install can:
  - import `MartinLoop` from `martin-loop`
  - run `npx martin-loop --help`
- Added root script:
  - `pnpm public:smoke`
- Wired `pnpm public:smoke` into `pnpm rc:validate`
- Added CLI help handling so `--help`, `-h`, `help`, and no-arg usage return a real usage surface.
- Removed the stale `@martin/benchmarks` build alias from `packages/cli/tsconfig.build.json`
- Updated RC docs so they reflect the new truth:
  - the root public package facade is now implemented and smoke-validated
  - registry publication is still a later release step

## Files changed

- `package.json`
- `scripts/build-public-facade.mjs`
- `scripts/public-facade-smoke.mjs`
- `scripts/rc-validation.mjs`
- `scripts/tests/oss-boundary.test.mjs`
- `scripts/tests/public-facade.test.mjs`
- `scripts/tests/rc-validation.test.mjs`
- `packages/cli/src/index.ts`
- `packages/cli/tests/cli-integration.test.ts`
- `packages/cli/tsconfig.build.json`
- `benchmarks/tests/phase12-certification.test.ts`
- `README.md`
- `docs/oss/README.md`
- `docs/oss/QUICKSTART.md`
- `docs/oss/EXAMPLES.md`

## Verification

- `node --test .\scripts\tests\oss-boundary.test.mjs .\scripts\tests\public-facade.test.mjs .\scripts\tests\rc-validation.test.mjs` => 10/10 passing
- `pnpm install` => pass
- `pnpm --filter @martin/cli lint` => pass
- `pnpm --filter @martin/cli build` => pass
- `pnpm --filter @martin/cli test` => 18/18 passing
- `pnpm build` => pass
- `pnpm oss:validate` => GO
- `pnpm public:smoke` => pass
- `pnpm --filter @martin/benchmarks test` => 15/15 passing
- `pnpm rc:validate` => pass

Latest successful RC validation:

- logs: `C:\Users\Torram\AppData\Local\Temp\martin-rc-validation-ee6XOH\logs`
- clean home: `C:\Users\Torram\AppData\Local\Temp\martin-rc-validation-ee6XOH\home`

## Notes

- The root public package facade is now real in the repo and clean-install validated via `npm pack` + temp-project install.
- This does **not** mean the package has been published to npm yet. Registry publication remains part of the later release flow.
- RC verification exposed a flaky Phase 12 certification timeout under clean-home load. The root cause was an overly tight 5s budget on the repeated persistence rewrite test, so that test now carries an explicit 15s timeout to keep RC validation stable without changing certification logic.

## Recommended next slice

Slice 05 should be the cross-platform release validation matrix:

- macOS
- Windows
- Linux

That slice should verify install, build, tests, `npx martin-loop --help`, `import { MartinLoop } from "martin-loop"`, repo-backed smoke behavior, rollback artifact creation, and the RC gate on each supported platform.
