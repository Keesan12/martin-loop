# Phase 13 Slice 02 Summary

Date: 2026-04-03
Status: completed
Scope: provider-path validation matrix

## What landed

This slice extends Phase 13 from generic clean-environment reproducibility into a named provider-path RC gate. It does not invent new live provider support. Instead, it classifies the current execution surfaces honestly and wires that classification into the RC validation flow.

Changes landed:

- added a real provider-path report generator in `benchmarks/src/provider-paths.ts`
- added a CLI/report writer in `benchmarks/src/provider-path-report.ts`
- extended benchmark exports and types so the report is a first-class Phase 13 artifact:
  - `benchmarks/src/index.ts`
  - `benchmarks/src/types.ts`
- added focused coverage in `benchmarks/tests/provider-paths.test.ts`
- added the report command in `benchmarks/package.json`
  - `pnpm --filter @martin/benchmarks eval:providers`
- wired provider-path validation into the root clean-environment RC matrix in `scripts/rc-validation.mjs`
- updated validator coverage in `scripts/tests/rc-validation.test.mjs`

## What the report proves

The current RC support matrix is now explicit and artifact-backed:

- `Claude CLI`
  - `supported_for_rc`
  - accounting mode `exact`
- `Codex CLI`
  - `supported_for_rc`
  - accounting mode `estimated_only`
- `Direct Provider HTTP Contract`
  - `unsupported_for_rc`
  - accounting mode `unavailable`
- `Routed Provider Contract`
  - `unsupported_for_rc`
  - accounting mode `unavailable`

This matters because RC truth is not "all provider paths are ready." The report makes the actual boundary visible:

- CLI surfaces are RC-usable today
- direct/routed HTTP surfaces are contract-defined but not yet live, configured inference paths

## Why this matters

Before this slice:

- provider-path readiness was implied by code structure and adapter docs
- the clean-environment validator did not prove provider-path truth
- a fresh reviewer could overread the existence of direct-provider contracts as release-ready support

After this slice:

- the repo emits a concrete provider-path artifact set
- RC validation includes provider-path truth as a named gate
- the current release posture is more defensible because unsupported surfaces are called out explicitly

## Files changed

- `benchmarks/src/provider-paths.ts`
- `benchmarks/src/provider-path-report.ts`
- `benchmarks/src/index.ts`
- `benchmarks/src/types.ts`
- `benchmarks/tests/provider-paths.test.ts`
- `benchmarks/package.json`
- `scripts/rc-validation.mjs`
- `scripts/tests/rc-validation.test.mjs`

## Verification

Focused provider-path test:

```powershell
pnpm --filter @martin/benchmarks test -- provider-paths.test.ts
```

Result:

- 2/2 passing

Validator regression test:

```powershell
node --test .\scripts\tests\rc-validation.test.mjs
```

Result:

- 4/4 passing

Benchmarks package verification:

```powershell
pnpm --filter @martin/benchmarks lint
pnpm --filter @martin/benchmarks build
pnpm --filter @martin/benchmarks test
pnpm --filter @martin/benchmarks eval:providers
```

Result:

- lint pass
- build pass
- 15/15 tests passing
- provider-path report verdict `GO`

Full RC matrix:

```powershell
pnpm rc:validate
```

Result:

- pass
- latest successful RC validation temp log root:
  - `C:\Users\Torram\AppData\Local\Temp\martin-rc-validation-MZoGci\logs`
- latest successful RC validation temp clean-home root:
  - `C:\Users\Torram\AppData\Local\Temp\martin-rc-validation-MZoGci\home`

Observed RC matrix coverage now includes:

- `@martin/contracts` build
- `@martin/core` lint, test, build
- `@martin/adapters` lint, test, build
- `@martin/cli` lint, test, build
- `@martin/benchmarks` test, build, `eval:phase12`, `eval:providers`
- `@martin/control-plane` lint, test, build
- root workspace build

## Generated artifacts

- `benchmarks/output/phase13-provider-path-report.json`
- `benchmarks/output/phase13-provider-path-report.md`

## Recommended next Phase 13 slices

The next highest-value RC workstreams are now:

1. OSS core extraction closeout
   - finalize the publishable OSS boundary
   - remove or quarantine hosted-only coupling from the OSS story
2. Release-surface audit
   - review claims, accounting labels, trust-profile wording, and any remaining implied demo behavior
3. Operational readiness and pilot prep
   - operator runbook
   - incident/rollback runbook
   - release checklist
   - pilot-prep checklist

## Handoff note

This slice improves release honesty more than runtime capability. The repo is still not claiming that direct or routed provider execution is release-ready. It is now claiming, with artifacts, that the current RC baseline supports the CLI surfaces and accurately labels the other provider contracts as not yet live for RC.
