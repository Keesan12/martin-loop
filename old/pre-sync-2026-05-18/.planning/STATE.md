---
gsd_state_version: 1.0
milestone: v1.0
milestone_name: milestone
status: active
last_updated: "2026-04-04"
progress:
  total_phases: 15
  completed_phases: 12
  total_plans: 11
  completed_plans: 11
---

# Project State

## Current Phase

Phase 13 — Release-Candidate Engineering (in progress)

## Current Plan

Phase 13 is active. Slice 01 through Slice 08 of RC engineering are now landed: the repo has a real clean-environment validation command (`pnpm rc:validate`), rooted OSS docs, an updated root README, a provider-path validation matrix that is part of the RC gate, a machine-checked OSS boundary report that incorporates the CTO package-surface memo, a real root public package facade that clean-install smoke-tests `MartinLoop` root import plus `npx martin-loop --help`, a cross-platform release matrix with a locally verified Windows lane plus real CI lanes for macOS and Linux, a machine-checked release-surface audit that runs inside the RC gate, a machine-checked pilot-prep package covering operator runbooks, pilot defaults, staging checklists, and scorecards, and a hardened Windows matrix preflight that removes stale root `_tmp_*` artifacts plus uploads per-OS matrix artifacts in CI. The next block is still the remaining real macOS/Linux evidence plus the final Phase 13 gate review before moving into the staged pilot.

## Last Action

Phase 13 slice 08 complete (2026-04-04): Windows matrix hardening landed. Fresh verification:

- `pnpm install --frozen-lockfile` => pass
- `node --test .\scripts\tests\release-matrix.test.mjs` => 4/4 passing
- `pnpm release:matrix:local` => pass on the local Windows lane
- latest successful local Windows matrix log root => `C:\Users\Torram\AppData\Local\Temp\martin-release-matrix-DAOZ9D\logs`
- nested RC validation log root from that lane => `C:\Users\Torram\AppData\Local\Temp\martin-rc-validation-bb7KLe\logs`
- nested RC validation clean-home root from that lane => `C:\Users\Torram\AppData\Local\Temp\martin-rc-validation-bb7KLe\home`

What changed:

- `scripts/release-matrix.mjs` now preflight-cleans stale root `_tmp_*` artifacts before the local Windows lane runs `pnpm install --frozen-lockfile`
- `scripts/release-matrix.mjs` now supports `MARTIN_RELEASE_MATRIX_OUTDIR` so a CI lane can write stable per-OS artifacts instead of only temp logs
- `.github/workflows/phase13-release-matrix.yml` now uploads each OS lane’s matrix artifacts with `actions/upload-artifact@v4`
- Slice 08 confirmed that the reported Windows package-install blocker is not currently reproducible in the real `martin-loop` checkout; the remaining blocker is still missing macOS/Linux execution evidence

Phase 13 slice 07 complete (2026-04-04): pilot-prep packaging landed. Fresh verification:

- `node --test .\scripts\tests\pilot-prep-audit.test.mjs .\scripts\tests\release-surface-audit.test.mjs .\scripts\tests\rc-validation.test.mjs` => 9/9 passing
- `pnpm pilot:prep:validate` => GO
- `pnpm release:surface:validate` => GO
- `pnpm rc:validate` => pass
- `pnpm release:matrix:local` => pass on the local Windows lane
- latest successful pilot-prep report => `C:\Users\Torram\OneDrive\Documents\Codex Main\Setup Stuff\martin-loop\docs\pilot\PILOT-PREP-REPORT.md`
- latest successful standalone RC validation log root => `C:\Users\Torram\AppData\Local\Temp\martin-rc-validation-gk2AIq\logs`
- latest successful standalone RC validation clean-home root => `C:\Users\Torram\AppData\Local\Temp\martin-rc-validation-gk2AIq\home`
- latest successful local Windows matrix log root => `C:\Users\Torram\AppData\Local\Temp\martin-release-matrix-Jr1VZD\logs`
- nested RC validation log root from that lane => `C:\Users\Torram\AppData\Local\Temp\martin-rc-validation-MWIXLz\logs`
- nested RC validation clean-home root from that lane => `C:\Users\Torram\AppData\Local\Temp\martin-rc-validation-MWIXLz\home`

What changed:

- `scripts/pilot-prep-audit.mjs` now machine-checks the required pilot-prep package, freezes the recommended defaults, and writes `docs/pilot/PILOT-PREP-REPORT.{json,md}`
- root command `pnpm pilot:prep:validate` now exists and is part of `pnpm rc:validate`
- root README, OSS README, and quickstart now include the pilot-prep validator in the explicit Phase 13 gate command set
- `docs/ops/` now has canonical operator and incident/rollback runbooks
- `docs/pilot/` now has the pilot index, defaults, artifact review template, staging checklist, and success/failure scorecard
- Slice 07 also surfaced a real operational caveat during verification: do not run `pnpm rc:validate` and `pnpm release:matrix:local` concurrently in the same checkout because both build the control-plane `.next` output

Phase 13 slice 06 complete (2026-04-04): release-surface audit closeout landed. Fresh verification:

- `node --test .\scripts\tests\release-surface-audit.test.mjs .\scripts\tests\rc-validation.test.mjs` => 7/7 passing
- `pnpm release:surface:validate` => GO
- `pnpm release:matrix:local` => pass on the local Windows lane with the audit step included inside `pnpm rc:validate`
- release-surface report => `C:\Users\Torram\OneDrive\Documents\Codex Main\Setup Stuff\martin-loop\docs\oss\RELEASE-SURFACE-REPORT.md`
- release-surface report json => `C:\Users\Torram\OneDrive\Documents\Codex Main\Setup Stuff\martin-loop\docs\oss\RELEASE-SURFACE-REPORT.json`
- latest successful local Windows matrix log root => `C:\Users\Torram\AppData\Local\Temp\martin-release-matrix-0PPyEv\logs`
- nested RC validation log root from that lane => `C:\Users\Torram\AppData\Local\Temp\martin-rc-validation-0hROjc\logs`
- nested RC validation clean-home root from that lane => `C:\Users\Torram\AppData\Local\Temp\martin-rc-validation-0hROjc\home`

What changed:

- `scripts/release-surface-audit.mjs` now machine-checks the frozen public package surface, the RC gate command set, and the key OSS docs for release-surface drift
- root command `pnpm release:surface:validate` now exists and writes `docs/oss/RELEASE-SURFACE-REPORT.{json,md}`
- `pnpm rc:validate` now includes the release-surface validator as a named RC step
- root README, OSS README, and quickstart now list the explicit RC gate commands instead of leaving that story implicit
- the stale `docs/oss/README-outline.md` pointer file is gone so the OSS docs have a cleaner single-source-of-truth shape
- Slice 06 also surfaced and fixed a real cross-platform polish issue: the generated audit report now normalizes doc paths so the output is stable across Windows and POSIX path separators

Phase 13 slice 05 complete (2026-04-03): cross-platform release validation matrix landed. Fresh verification:

- `node --test .\scripts\tests\release-matrix.test.mjs .\scripts\tests\repo-backed-smoke.test.mjs` => 5/5 passing
- `pnpm repo:smoke` => pass
- `pnpm release:matrix:local` => pass on the local Windows lane
- latest successful local Windows matrix log root => `C:\Users\Torram\AppData\Local\Temp\martin-release-matrix-Wek2EB\logs`
- nested RC validation log root from that lane => `C:\Users\Torram\AppData\Local\Temp\martin-rc-validation-XBdNQX\logs`
- nested RC validation clean-home root from that lane => `C:\Users\Torram\AppData\Local\Temp\martin-rc-validation-XBdNQX\home`

What changed:

- `scripts/repo-backed-smoke.mjs` now exercises real repo-backed grounded and rollback flows through the root public facade using temporary git repos
- `scripts/release-matrix.mjs` now defines the frozen Windows/macOS/Linux RC lanes and runs the local platform lane with log capture
- root scripts `pnpm repo:smoke` and `pnpm release:matrix:local` now exist
- `.github/workflows/phase13-release-matrix.yml` now fans the matrix out across `windows-latest`, `macos-latest`, and `ubuntu-latest`
- Slice 05 surfaced and fixed two real cross-platform issues during implementation:
  - Windows git-argument quoting in scripted commit setup
  - CRLF-vs-LF rollback content comparison noise
- Windows was executed locally; macOS and Linux are now covered by the workflow lane definition, not by local claims

Phase 13 slice 04 complete (2026-04-03): root public package facade landed and is now part of the RC gate. Fresh verification:

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
- latest successful RC validation temp log root => `C:\Users\Torram\AppData\Local\Temp\martin-rc-validation-ee6XOH\logs`
- latest successful RC validation temp clean-home root => `C:\Users\Torram\AppData\Local\Temp\martin-rc-validation-ee6XOH\home`

What changed:

- root `package.json` now exposes the real `martin-loop` public package facade with `exports`, `types`, and `bin`
- `scripts/build-public-facade.mjs` now builds a self-contained root `dist/` facade by vendoring the built OSS runtime packages and rewriting internal package imports to relative paths
- `scripts/public-facade-smoke.mjs` now proves a clean temp install can import `MartinLoop` and run `npx martin-loop --help`
- `pnpm public:smoke` is now part of the Phase 13 RC gate
- `packages/cli/src/index.ts` now returns a real help surface for `--help`, `-h`, `help`, and no-arg invocation
- repo and OSS docs now reflect the new truth: the root public package facade is implemented and smoke-validated, while npm registry publication remains a later release step
- RC verification exposed a flaky Phase 12 timeout under clean-home load, so the repeated certification persistence test now has an explicit 15s timeout budget to keep the RC gate stable without changing certification logic

Phase 13 slice 03 complete (2026-04-03): OSS boundary closeout landed and now incorporates the CTO package-surface memo. Fresh verification:

- `node --test .\scripts\tests\oss-boundary.test.mjs` => 4/4 passing
- `pnpm --filter @martin/cli lint` => pass
- `pnpm --filter @martin/cli build` => pass
- `pnpm --filter @martin/cli test` => 17/17 passing
- `pnpm oss:validate` => GO
- `pnpm install` => pass
- `pnpm rc:validate` => pass
- `pnpm rc:validate` now includes `pnpm oss:validate` as a named RC gate step
- latest successful RC validation temp log root => `C:\Users\Torram\AppData\Local\Temp\martin-rc-validation-wspIdB\logs`
- latest successful RC validation temp clean-home root => `C:\Users\Torram\AppData\Local\Temp\martin-rc-validation-wspIdB\home`

What changed:

- `@martin/cli` no longer depends on the private `@martin/benchmarks` workspace
- `martin bench` is now explicitly a workspace-only RC surface rather than a publishable CLI promise
- `scripts/oss-boundary.mjs` added a machine-checked OSS boundary report and public-surface status output
- the boundary report now encodes the memo-frozen public target:
  - package name `martin-loop`
  - install command `npm install martin-loop`
  - CLI target `npx martin-loop`
  - SDK target `import { MartinLoop } from "martin-loop"`
- the boundary report also honestly records that root `npx martin-loop` and root SDK import support are not shipped yet
- repo and OSS docs now separate the current repo-local RC path from the frozen public launch target
- `pnpm rc:validate` now proves the OSS boundary report inside the clean-environment RC matrix instead of relying on a separate ad hoc command

Phase 13 slice 02 complete (2026-04-03): provider-path RC validation landed and is now part of the clean-environment gate. Fresh verification:

- `pnpm --filter @martin/benchmarks lint` => pass
- `pnpm --filter @martin/benchmarks build` => pass
- `pnpm --filter @martin/benchmarks test -- provider-paths.test.ts` => 2/2 passing
- `node --test .\scripts\tests\rc-validation.test.mjs` => 4/4 passing
- `pnpm --filter @martin/benchmarks test` => 15/15 passing
- `pnpm --filter @martin/benchmarks eval:providers` => GO
- `pnpm rc:validate` => pass
- latest successful RC validation temp log root => `C:\Users\Torram\AppData\Local\Temp\martin-rc-validation-MZoGci\logs`
- latest successful RC validation temp clean-home root => `C:\Users\Torram\AppData\Local\Temp\martin-rc-validation-MZoGci\home`

What changed:

- provider-path report generator and report writer landed in `benchmarks/src/`
- the RC support matrix is now explicit: Claude CLI exact, Codex CLI estimated-only, direct/routed HTTP unsupported-for-RC
- `eval:providers` now generates artifact-backed provider-path truth in `benchmarks/output/`
- `scripts/rc-validation.mjs` now includes provider-path validation as part of the full RC matrix

Phase 13 slice 01 complete (2026-04-03): RC reproducibility entry slice landed. Fresh verification:

- `node --test .\scripts\tests\rc-validation.test.mjs` => 4/4 passing
- `pnpm rc:validate` => pass
- latest successful RC validation temp log root => `C:\Users\Torram\AppData\Local\Temp\martin-rc-validation-eoaS8J\logs`
- latest successful RC validation temp clean-home root => `C:\Users\Torram\AppData\Local\Temp\martin-rc-validation-eoaS8J\home`

What changed:

- root RC validation commands added
- `scripts/rc-validation.mjs` added with isolated home/profile execution
- Windows execution path hardened to avoid `shell: true` warnings while keeping the validator runnable
- real OSS quickstart/examples docs landed
- root README updated to Phase 13 RC truth

Phase 10 complete (2026-04-03): rollback-boundary persistence, explicit restore outcome artifacts, and replayable restore evidence are now real. Fresh verification:

- `pnpm --filter @martin/core test` => 77/77 passing
- `pnpm --filter @martin/core lint` => pass
- `pnpm --filter @martin/contracts build` => pass
- `pnpm --filter @martin/core build` => pass
- `pnpm --filter @martin/benchmarks test` => 13/13 passing
- `pnpm --filter @martin/benchmarks build` => pass
- `pnpm --filter @martin/benchmarks eval:phase12` => GO

Phase 12 complete (2026-04-03): certification harness, persisted evidence bundles, and release-gate report are real and green. Fresh verification:

- `pnpm --filter @martin/core test` => 74/74 passing
- `pnpm --filter @martin/core lint` => pass
- `pnpm --filter @martin/core build` => pass
- `pnpm --filter @martin/benchmarks test` => 13/13 passing
- `pnpm --filter @martin/benchmarks lint` => pass
- `pnpm --filter @martin/benchmarks build` => pass
- `pnpm --filter @martin/benchmarks eval:phase12` => GO

Phase 11 complete (2026-04-03): control-plane read models now derive patch decision, grounding evidence, leash surface, budget variance, accounting mode, and stop reason from persisted artifacts instead of inferred prose. Fresh verification: `pnpm --filter @martin/control-plane test` => 36/36 passing, `pnpm --filter @martin/control-plane lint` => pass, `pnpm --filter @martin/control-plane build` => pass.

Phase 9 complete (2026-04-03): trust-profile leash rules, network blocking, dependency/config approval boundaries, and `leash.json` artifacts landed with rolling verification for challenges 10-13.

Phase 8 complete (2026-04-03): grounding integrity hardening done. 55/55 @martin/core tests passing. Challenges 1-5 named tests pass. contentOnly field added to GroundingScanResult. Anatomy artifact persistence verified. scanPatchForGroundingViolations wired into runMartin VERIFY phase with grounding.violations_found ledger event.

Phase 7 complete (2026-04-02): evaluation matrix, replay drills, variance study, and CTO-ready go/no-go reporting landed.

- Phase 5 complete: blocking safety enforcement, adapter normalization, fallback adapter rotation, and CLI/direct-provider ledger consistency
- Phase 6 complete: mock/demo control-plane data deleted, repository-backed Supabase read model added, Clerk auth wiring added, and local dashboard moved to honest empty/live states
- Phase 7 complete: A/B/C benchmark matrix, failure replay suite, safety incident drills, 21-run budget variance study, and generated go/no-go report artifacts
- Verification:
  - `pnpm --filter @martin/control-plane lint`
  - `pnpm --filter @martin/control-plane test`
  - `pnpm --filter @martin/benchmarks lint`
  - `pnpm --filter @martin/benchmarks test`
  - `pnpm --filter @martin/benchmarks eval:phase7`
- Output: `benchmarks/output/phase7-go-no-go-report.md` and `benchmarks/output/phase7-go-no-go-report.json` generated with verdict `GO`
- Handoff review: reviewed `martin-loop-complete-handoff-v5.zip` and used it as a cross-check while completing the grounding/policy and Phase 5-7 implementation passes

Phase 3 complete (2026-04-01): 25 tests passing in @martin/core, 16 in @martin/cli. All 03-02 tasks done.

- 03-01: RunStore interface + FileRunStore + LedgerEvent types (12 kinds) + CLI persistence shim
- 03-02: ContextCompiler + wire RunStore into runMartin at all lifecycle boundaries + 7 new persistence tests

Circular import resolved: compilePromptPacket extracted to packages/core/src/compiler.ts.
Phase 2 complete (2026-04-02): 18 tests passing across runtime/leash/grounding.
Previous: Phase 2 planned. 2 plans created:

- 02-01-PLAN.md: Import engineer slice work (policy.ts, leash.ts, grounding.ts) + add PolicyPhase/EvidenceVector/MachineState to contracts + wire compilePromptPacket and evaluateAttemptPolicy into core/src/index.ts
- 02-02-PLAN.md: Full test coverage for all new Phase 2 APIs

Handoff zip analyzed: slices 1-8 implemented policy, leash, grounding modules. Phase 2 plans wire all of that into the tracked repo and add test coverage.

## Active Decisions

- Database: Supabase (Postgres)
- Auth: Clerk
- Package manager: pnpm
- Branch: rebuild/v4-controller (created and active)
- Granularity: Standard (5-8 phases)
- Parallelization: Yes
- git init run inside martin-loop/ as standalone repo — parent Setup Stuff repo must not track martin-loop files
- Initial commit contains ONLY .gitignore so no noise ever enters git history
- rebuild/v4-controller is the working branch; main contains only the .gitignore baseline commit
- Legacy reference docs (ENGINEERING.md, HANDOVER.md, OPEN-ME-FIRST.html) live in docs/legacy/ — not root
- Historical directories and demo artifacts excluded via explicit .gitignore entries (not deleted from disk)
- Used plain mv (not git mv) for relocating untracked files — correct approach for freshly initialized repo

## Key Constraints

- Do not proceed to Phase 6 (control plane) without Phase 3 (persistence) complete
- Delete mock-control-plane-data.ts — do not refactor it, do not wrap it, delete it
- Delete demo-data.js — same rule
- Non-goals: multi-tenant billing, demo pathways in production, natural language as canonical state

## Blockers

- No active implementation blocker remains inside Phases 10-12.
- No active implementation blocker remains inside Phase 13 slice 03.
- Public-release confidence still needs the targeted addenda leadership called out beyond the current RC baseline: full macOS/Linux matrix execution evidence from CI, rollback-replay/public-release certification addendum, pilot defaults and operator materials, and staged-pilot packaging.

## Notes

- The old plan file (sharded-hopping-flask.md) was the v2 remediation plan. Now superseded.
- v6 pack requires a full rebuild, not incremental patches on existing architecture.
- CTO demo deliverable = Phase 6, which requires Phase 3 (persistence) first.
- martin-loop .git/ is a standalone repo nested inside "Setup Stuff/" — git commands must be run from inside martin-loop/ to target the correct repo.
- The v5 handoff reframes "hallucination" as "grounding violation" and reinforces preflight/admission/settlement as the Phase 4 budget control layers.

## Active Decisions (Phase 2)

- Slice work (policy.ts, leash.ts, grounding.ts) from engineer's handoff is imported as-is into working repo
- compilePromptPacket and evaluateAttemptPolicy are NEW additions not in handoff (required by tests)
- PolicyPhase, EvidenceVector, MachineState added to packages/contracts/src/index.ts
- FailureClass kept as thin output label only (R2.5) — policy reads EvidenceVector, not the label
- runMartin explicitly tracks currentPhase (PolicyPhase state machine variable)

## Performance Metrics

| Phase | Plan | Duration | Tasks | Files |
|-------|------|----------|-------|-------|
| 01-repo-surgery | 01 | 18min | 2 | 2 |
| 01-repo-surgery | 02 | 12min | 1 | 4 |
| 01-repo-surgery | 03 | 8min | 1 | 1 |
| 02-runtime-state-machine | 02-01 | (prior) | 4 | 5 |
| 02-runtime-state-machine | 02-02 | 8min | 4 | 3 |
| 04-grounding-policy-engine | 04-01 | 2026-04-02 | 4 | 4 |
| 04-grounding-policy-engine | 04-02 | 2026-04-02 | 4 | 4 |
| 08-grounding-integrity | 08-01 | 3min | 7 | 2 |
| 08-grounding-integrity | 08-02 | 6min | 4 | 2 |
