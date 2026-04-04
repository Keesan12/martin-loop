# Phase 13 Slice 01 Summary

Date: 2026-04-03
Status: completed
Scope: RC reproducibility entry slice

## What landed

This slice did not add new runtime features. It tightened the release-candidate surface around the already-verified runtime by making the repo more reproducible and more honest for a fresh engineer.

Changes landed:

- added a real root RC validation command in `package.json`
  - `pnpm rc:validate`
  - `pnpm rc:validate:install`
- added `scripts/rc-validation.mjs`
  - runs the current Phase 13 RC matrix in a clean temporary home/profile
  - isolates `HOME`, `USERPROFILE`, `APPDATA`, `LOCALAPPDATA`, `XDG_*`, `MARTIN_RUNS_DIR`, and package caches away from the user’s long-lived machine state
  - writes per-step logs plus a JSON summary into a temp log directory
  - uses explicit `cmd.exe /d /s /c ...` execution on Windows to avoid the shell warning from the first draft
- added focused validator regression coverage in `scripts/tests/rc-validation.test.mjs`
- replaced the placeholder OSS outline with real Phase 13 docs:
  - `docs/oss/README.md`
  - `docs/oss/QUICKSTART.md`
  - `docs/oss/EXAMPLES.md`
- rewrote the root `README.md` to reflect actual Phase 13 status instead of the older pre-hardening posture
- turned `docs/oss/README-outline.md` into a redirect to the new docs instead of leaving stale guidance behind

## Why this matters

Phase 13 is about release discipline, not new capability. Before this slice:

- the repo had no single clean-environment RC validation command
- the root README overstated some surfaces and under-described the current RC state
- the OSS docs were still an outline rather than an engineer-usable quickstart

After this slice:

- a fresh engineer has a single command to validate the current repo baseline
- the root docs now separate what is real from what is still gated
- the OSS/core story is grounded in actual package and runtime state

## Files changed

- `package.json`
- `scripts/rc-validation.mjs`
- `scripts/tests/rc-validation.test.mjs`
- `README.md`
- `docs/oss/README.md`
- `docs/oss/QUICKSTART.md`
- `docs/oss/EXAMPLES.md`
- `docs/oss/README-outline.md`

## Verification

Focused validator tests:

```powershell
node --test .\scripts\tests\rc-validation.test.mjs
```

Result:

- 4/4 passing

Full RC matrix:

```powershell
pnpm rc:validate
```

Result:

- pass
- latest successful clean-home log root:
  - `C:\Users\Torram\AppData\Local\Temp\martin-rc-validation-eoaS8J\logs`
- latest successful clean-home root:
  - `C:\Users\Torram\AppData\Local\Temp\martin-rc-validation-eoaS8J\home`

Observed matrix coverage:

- `@martin/contracts` build
- `@martin/core` lint, test, build
- `@martin/adapters` lint, test, build
- `@martin/cli` lint, test, build
- `@martin/benchmarks` test, build, `eval:phase12`
- `@martin/control-plane` lint, test, build
- root workspace build

Certification remained green during the RC validation run:

- Phase 12 verdict: `GO`
- 7/7 certification scenarios passed
- 7/7 evidence bundles complete

## Notes from implementation

- The first validator draft passed but emitted a Windows child-process deprecation warning because it used `shell: true`.
- The second draft removed the warning but broke execution on `.cmd` resolution.
- The final version uses explicit `cmd.exe /d /s /c` on Windows and now passes both the focused tests and the full RC matrix.

## Recommended next Phase 13 slices

From the v10 RC pack, the next highest-value slices are:

1. Provider-path validation matrix
   - separate RC validation expectations for CLI and routed/direct provider paths
2. OSS core extraction closeout
   - decide the final publishable package boundary
   - remove or quarantine hosted-only coupling from the OSS story
3. Release-surface audit
   - review public copy, accounting labels, trust-profile wording, and demo-path claims
4. Operational readiness docs
   - operator runbook
   - incident/rollback runbook
   - release checklist
   - pilot-prep checklist

## Handoff note

The repo is still in Phase 13 and is not claiming public release readiness yet. This slice makes Phase 13 reproducibility real and gives the next engineer a safer baseline for the remaining RC workstreams.
