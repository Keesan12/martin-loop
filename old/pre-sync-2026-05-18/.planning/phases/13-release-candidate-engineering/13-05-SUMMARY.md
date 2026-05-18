# Phase 13 Slice 05 Summary

## Goal

Add a real cross-platform release validation matrix for the RC and prove the Windows lane locally without pretending macOS or Linux were executed from this machine.

## What landed

- Added `scripts/repo-backed-smoke.mjs`:
  - creates temporary git repos
  - runs a grounded repo-backed attempt through the real root public facade
  - verifies `contract.json`, `ledger.jsonl`, grounding scan artifacts, and grounding cache creation
  - runs a blocked repo-backed attempt and verifies `rollback-boundary.json`, `rollback-outcome.json`, `leash.json`, and restored repo contents
- Added `scripts/release-matrix.mjs`:
  - defines frozen Windows/macOS/Linux release lanes
  - runs the local platform lane with logs
  - executes the exact Slice 05 command set:
    - `pnpm install --frozen-lockfile`
    - `pnpm build`
    - `pnpm oss:validate`
    - `pnpm public:smoke`
    - `pnpm repo:smoke`
    - `pnpm rc:validate`
- Added root scripts:
  - `pnpm repo:smoke`
  - `pnpm release:matrix:local`
- Added `.github/workflows/phase13-release-matrix.yml`:
  - fans out across `windows-latest`, `macos-latest`, and `ubuntu-latest`
  - runs `pnpm release:matrix:local` in each lane
- Added Slice 05 tests:
  - `scripts/tests/release-matrix.test.mjs`
  - `scripts/tests/repo-backed-smoke.test.mjs`

## Real issues found and fixed

- Windows git argument quoting in the repo smoke setup:
  - the original commit message with spaces tripped command parsing
  - fixed by removing the space-sensitive commit message from the scripted smoke setup
- Cross-platform line ending truth in rollback verification:
  - rollback restore was working, but the raw README comparison failed on Windows CRLF
  - fixed by normalizing line endings in the smoke assertion so the check measures restore truth instead of newline style

## Files changed

- `scripts/repo-backed-smoke.mjs`
- `scripts/release-matrix.mjs`
- `scripts/tests/release-matrix.test.mjs`
- `scripts/tests/repo-backed-smoke.test.mjs`
- `.github/workflows/phase13-release-matrix.yml`
- `package.json`

## Verification

- `node --test .\scripts\tests\release-matrix.test.mjs .\scripts\tests\repo-backed-smoke.test.mjs` => 5/5 passing
- `pnpm repo:smoke` => pass
- `pnpm release:matrix:local` => pass on local Windows lane

Latest successful local Windows matrix lane:

- logs: `C:\Users\Torram\AppData\Local\Temp\martin-release-matrix-Wek2EB\logs`

Latest successful nested RC validator inside that lane:

- logs: `C:\Users\Torram\AppData\Local\Temp\martin-rc-validation-XBdNQX\logs`
- clean home: `C:\Users\Torram\AppData\Local\Temp\martin-rc-validation-XBdNQX\home`

## Notes

- Windows was executed and verified locally.
- macOS and Linux are now encoded as real workflow lanes, but they were not executed from this machine in this slice.
- The repo-backed smoke now proves:
  - rooted public facade can drive a real repo-backed run
  - grounding artifacts are persisted for an allowed-path grounded change
  - rollback boundary/outcome artifacts are persisted for a blocked path
  - repo contents are restored after the blocked attempt

## Recommended next slice

Slice 06 should close the release-surface audit:

- remove remaining public-surface ambiguity
- verify exact vs estimated accounting labels everywhere
- freeze the public OSS core contract against the now-verified package and OS matrix surface
- prepare the operator/runbook and pilot-prep handoff for Slice 07
