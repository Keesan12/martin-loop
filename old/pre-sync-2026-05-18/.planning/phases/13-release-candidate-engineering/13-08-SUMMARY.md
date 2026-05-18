# Phase 13 Slice 08 Summary

## Goal

Verify the reported Windows OneDrive install blocker, fix any real repo-side issue, and make the cross-platform matrix produce reviewable artifacts once the blocked OS lanes can run.

## What landed

- Verified the exact claim against the real repo:
  - `pnpm install --frozen-lockfile` passed
  - `pnpm release:matrix:local` passed
- Found a real but narrower repo-side issue:
  - the repo root contained orphan `_tmp_*` hardlink artifacts
- Hardened `scripts/release-matrix.mjs` so the local Windows lane now preflight-cleans root `_tmp_*` artifacts before running `pnpm install --frozen-lockfile`
- Added support for `MARTIN_RELEASE_MATRIX_OUTDIR` so matrix logs can be written to a stable artifact directory instead of only a temp directory
- Updated `.github/workflows/phase13-release-matrix.yml` so each OS lane now uploads its matrix artifacts with `actions/upload-artifact@v4`

## What was verified

- The previously reported OneDrive install blocker is not reproducible in the current `martin-loop` checkout on this machine
- The WSL/Linux blocker is still host-level:
  - WSL launch fails because the required VM feature/service is not available yet
  - enabling WSL features requires true Administrator elevation or a rebooted host state outside the current session
- macOS still cannot be executed from this Windows machine

## Files changed

- `scripts/release-matrix.mjs`
- `scripts/tests/release-matrix.test.mjs`
- `.github/workflows/phase13-release-matrix.yml`

## Verification

- `pnpm install --frozen-lockfile` => pass
- `node --test .\scripts\tests\release-matrix.test.mjs` => 4/4 passing
- `pnpm release:matrix:local` => pass on the local Windows lane

Latest successful Windows lane after the cleanup hardening:

- logs: `C:\Users\Torram\AppData\Local\Temp\martin-release-matrix-DAOZ9D\logs`
- nested RC logs: `C:\Users\Torram\AppData\Local\Temp\martin-rc-validation-bb7KLe\logs`
- nested RC clean home: `C:\Users\Torram\AppData\Local\Temp\martin-rc-validation-bb7KLe\home`

## Notes

- The exact Windows package-install blocker is not currently real.
- The real repo-side fix here is preventative hardening around stale root `_tmp_*` artifacts.
- The remaining Phase 13 blocker is still missing macOS/Linux execution evidence, not a Windows package failure.
