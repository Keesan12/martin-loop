# Phase 13 Slice 06 Summary

## Goal

Close the release-surface audit gap so the release candidate says exactly what it really ships, with a machine-checked validator instead of relying on manual doc review.

## What landed

- Added `scripts/release-surface-audit.mjs`:
  - audits the frozen public package surface
  - checks the current RC gate command set
  - validates root README, OSS README, quickstart, and examples for release-surface alignment
  - flags deprecated release-surface files
  - writes:
    - `docs/oss/RELEASE-SURFACE-REPORT.json`
    - `docs/oss/RELEASE-SURFACE-REPORT.md`
- Added root command:
  - `pnpm release:surface:validate`
- Wired `pnpm release:surface:validate` into `pnpm rc:validate`
- Tightened the RC docs so the current release-candidate gate is explicit:
  - `README.md`
  - `docs/oss/README.md`
  - `docs/oss/QUICKSTART.md`
- Removed the stale `docs/oss/README-outline.md` pointer file so the OSS docs have a cleaner single-source-of-truth shape

## Real issues found and fixed

- The release-surface story was spread across several files without a machine-checked audit gate.
- The root README and quickstart did not yet enumerate the full RC gate command set.
- A deprecated OSS doc pointer still existed and could drift from the real docs.
- The generated audit report initially rendered Windows-style backslashes in doc paths; that was normalized so the report is stable across platforms.

## Files changed

- `scripts/release-surface-audit.mjs`
- `scripts/tests/release-surface-audit.test.mjs`
- `scripts/tests/rc-validation.test.mjs`
- `scripts/rc-validation.mjs`
- `package.json`
- `README.md`
- `docs/oss/README.md`
- `docs/oss/QUICKSTART.md`
- `docs/oss/README-outline.md` (removed)

## Verification

- `node --test .\scripts\tests\release-surface-audit.test.mjs .\scripts\tests\rc-validation.test.mjs` => 7/7 passing
- `pnpm release:surface:validate` => GO
- `pnpm release:matrix:local` => pass on the local Windows lane with the new audit step included in `pnpm rc:validate`

Latest successful release-surface validator output:

- report: `C:\Users\Torram\OneDrive\Documents\Codex Main\Setup Stuff\martin-loop\docs\oss\RELEASE-SURFACE-REPORT.md`
- json: `C:\Users\Torram\OneDrive\Documents\Codex Main\Setup Stuff\martin-loop\docs\oss\RELEASE-SURFACE-REPORT.json`

Latest successful local Windows matrix lane:

- logs: `C:\Users\Torram\AppData\Local\Temp\martin-release-matrix-0PPyEv\logs`

Latest successful nested RC validator inside that lane:

- logs: `C:\Users\Torram\AppData\Local\Temp\martin-rc-validation-0hROjc\logs`
- clean home: `C:\Users\Torram\AppData\Local\Temp\martin-rc-validation-0hROjc\home`

## Notes

- Windows was executed and verified locally again after the Slice 06 gate changes.
- macOS and Linux are still represented by real CI workflow lanes, but they were not executed from this machine in this slice.
- Slice 06 closes the release-surface truth pass, but it does not close the remaining RC-to-pilot gap:
  - real macOS/Linux matrix evidence
  - pilot defaults and operator materials
  - staged pilot packaging

## Recommended next slice

Slice 07 should focus on pilot-prep packaging:

- operator runbook
- pilot defaults and trust-profile defaults
- artifact review checklist
- pilot staging checklist
- escalation and weird-run handling guidance
