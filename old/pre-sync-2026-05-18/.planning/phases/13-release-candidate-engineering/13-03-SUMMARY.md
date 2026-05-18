# Phase 13 Slice 03 Summary

Date: 2026-04-03
Status: completed
Scope: OSS core extraction closeout and public package-surface truth

## What landed

This slice closes the most immediate OSS boundary leak in the current RC repo and folds the CTO package-surface memo into the actual engineering source of truth.

Changes landed:

- removed the publishable CLI package's dependency on the private `@martin/benchmarks` workspace
  - `packages/cli/src/index.ts`
  - `packages/cli/package.json`
- changed `martin bench` from a pretend public CLI capability into an explicit RC workspace-only message with guidance to use the `benchmarks/` workspace directly
- added a machine-checked OSS boundary validator:
  - `scripts/oss-boundary.mjs`
  - `scripts/tests/oss-boundary.test.mjs`
- added a root command:
  - `pnpm oss:validate`
- generated artifact-backed boundary outputs:
  - `docs/oss/OSS-BOUNDARY-REPORT.json`
  - `docs/oss/OSS-BOUNDARY-REPORT.md`
- updated repo and OSS docs to separate:
  - the current repo-local RC path
  - the memo-frozen public launch target

## What the boundary report now proves

The intended OSS core set is explicit and machine-checked:

- `@martin/contracts`
- `@martin/core`
- `@martin/adapters`
- `@martin/cli`
- `@martin/mcp`

Non-OSS workspace surfaces are also explicit:

- `@martin/control-plane`
- `@martin/benchmarks`

Local-only surface:

- `apps/local-dashboard`

Most importantly, the validator now proves there are zero workspace dependency leaks from the intended OSS core into the non-OSS workspace packages.

## CTO memo incorporated

The boundary report also now captures the memo-frozen public package surface:

- package target: `martin-loop`
- canonical public package manager: `npm`
- install target: `npm install martin-loop`
- CLI target: `npx martin-loop`
- SDK target: `import { MartinLoop } from "martin-loop"`

And it records the current honest state:

- root `npx martin-loop` support is not shipped yet
- root `import { MartinLoop } from "martin-loop"` support is not shipped yet

That keeps the build aligned with the memo without pretending those public-launch surfaces already exist in the RC repo.

## Why this matters

Before this slice:

- the public CLI package imported the private benchmarks workspace
- `@martin/cli` looked more publishable than it really was
- OSS docs still mixed repo-local RC usage with the future public launch surface
- the CTO memo's package-surface decisions were not encoded into a build-time artifact

After this slice:

- the OSS/package boundary is machine-checked
- the public CLI no longer depends on a private RC-only workspace package
- docs stop implying that `bench` ships in the public CLI today
- the public install/name/import decisions are visible in the boundary report, together with the current gaps

## Files changed

- `packages/cli/src/index.ts`
- `packages/cli/package.json`
- `package.json`
- `scripts/oss-boundary.mjs`
- `scripts/tests/oss-boundary.test.mjs`
- `README.md`
- `docs/oss/README.md`
- `docs/oss/QUICKSTART.md`
- `docs/oss/EXAMPLES.md`

## Verification

Focused OSS boundary test:

```powershell
node --test .\scripts\tests\oss-boundary.test.mjs
```

Result:

- 4/4 passing

CLI verification:

```powershell
pnpm --filter @martin/cli lint
pnpm --filter @martin/cli build
pnpm --filter @martin/cli test
```

Result:

- lint pass
- build pass
- 17/17 tests passing

Boundary report:

```powershell
pnpm oss:validate
```

Result:

- verdict `GO`
- generated:
  - `docs/oss/OSS-BOUNDARY-REPORT.json`
  - `docs/oss/OSS-BOUNDARY-REPORT.md`

Lockfile sync:

```powershell
pnpm install
```

Result:

- pass
- workspace already up to date after dependency cleanup

Full RC matrix:

```powershell
pnpm rc:validate
```

Result:

- pass
- includes `pnpm oss:validate` as part of the clean-environment RC gate
- latest successful RC validation temp log root:
  - `C:\Users\Torram\AppData\Local\Temp\martin-rc-validation-wspIdB\logs`
- latest successful RC validation temp clean-home root:
  - `C:\Users\Torram\AppData\Local\Temp\martin-rc-validation-wspIdB\home`

## Remaining gaps after this slice

This slice does not claim that the root public package surface is complete. The following remain open:

- root `npx martin-loop` executable support
- root `MartinLoop` SDK import/export surface
- final SDK call shape
- macOS + Windows-specific public install and smoke validation
- remaining release-surface audit and operational or pilot runbooks

## Recommended next Phase 13 slices

The next highest-value slices are now:

1. Public package facade
   - decide whether the root `martin-loop` package becomes the real SDK + CLI facade
   - add truthful root exports and `bin` only when they are actually shipped
2. Cross-platform release validation
   - add the memo-driven macOS/Windows/Linux validation matrix and smoke checks
3. Release-surface audit and operator readiness
   - finish the claim audit
   - add operator, incident, and rollback runbooks
   - finish pilot-prep materials

## Handoff note

The OSS boundary is materially cleaner now, and the CTO memo is encoded into the repo. The repo is still not claiming that the final public `martin-loop` package facade is shipped. What it is now claiming, with artifacts, is:

- the intended OSS core set is explicit
- there are no workspace dependency leaks from OSS core into non-OSS workspaces
- the public install/name/import target is frozen for launch planning
- the remaining package-surface gaps are visible instead of hidden
