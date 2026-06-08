# C-LEDGER (Execution Log)

## C.0 Baseline

- Confirmed internal target repo: `martin-Loop/ML_Core_OSS_Internal`.
- Confirmed active branch: `codex/gsd-phase08-mainline`.
- Confirmed clean starting worktree before C-slice edits.
- Loaded new CounterSwarm audit findings and mapped to C.1-C.11.

## C.1-C.2 initial implementation (in progress)

- Added path policy normalization/validation in CLI execution-policy resolution.
  - Rejects empty and traversal path patterns for `--allow-path` and `--deny-path`.
- Switched default guardrails config lookup to repo root (`--cwd`-resolved scope) for run/preflight.
- Switched default `doctor` config lookup to working directory scope (not invocation root).
- Added CLI regression tests for:
  - default `doctor` config scope with `--cwd`,
  - traversal rejection in preflight path flags.

## Pending in this wave

- Record exact command outputs for C.1 and C.2 verification.

## C.1-C.2 verification

- `pnpm --filter @martin/cli test -- cli.test.ts` passed (20/20).
- `pnpm --filter @martin/cli lint` passed.
- New regressions covered:
  - doctor default config lookup follows `--cwd` scope (target repo).
  - preflight rejects traversal values in `--allow-path`.

## C.3 parity probe

- Added selector-parity regression test in CLI suite:
  - same run queried via `runs verify --latest` and `runs verify --loop-id`.
- Re-ran validation:
  - `pnpm --filter @martin/cli test -- cli.test.ts` passed (21/21),
  - `pnpm --filter @martin/cli lint` passed.
- Result: parity issue is not reproduced by canonical local fixture in this branch; keep C.3 open for field-lane replay parity with copied/relocated evidence paths.

## C.4 share trust hardening (in progress)

- Hardened share bundle rendering so non-verified integrity suppresses sensitive loop fields (`status`, `lifecycle`, `spend`, `budget`) as untrusted/null.
- Non-verified integrity now redacts receipt/verification sections into explicit untrusted notices in share JSON payload.
- Proof-card input now degrades untrusted fields when integrity is weak.
- Added regression test:
  - tampered loop record loaded via `share --file` does not export manipulated status/spend as authoritative.

## C.3 selector canonicalization follow-up

- Improved `--file` selector handling:
  - when file path points at canonical run `loop-record.json` under a run directory, integrity verification now uses canonical run-directory context instead of noncanonical fallback.

## C.8 proof gate alignment

- Added `--proof` parsing back into run/preflight request parsing.
- Added `liveMode` to run request model and propagation.
- `executeRunCommand` and `executePreflightCommand` now pass request `liveMode` into environment resolution.
- Adapter selection now honors proof mode directly (`liveMode === "proof"` => stub adapter), independent of `MARTIN_LIVE`.
- Regression test added:
  - `run --proof` works without requiring `MARTIN_LIVE=false`.

## C.9 unknown-field hardening

- Added unknown top-level field detector for file-selected loop records.
- `runs get --file` and `share --file` now surface explicit untrusted warnings when copied loop records contain unknown top-level keys.
- Regression test added:
  - injected `hiddenControlPlaneDirective` triggers an explicit warning instead of silent acceptance.

## C.5 lifecycle reliability hardening

- Added bounded run timeout guard around `runMartin` execution in CLI (`MARTIN_RUN_TIMEOUT_MS`, default 30 minutes).
- On timeout or adapter hang, CLI now persists a fallback loop record and exits with structured environment failure instead of hanging indefinitely.
- Added test-only adapter override hook to simulate hanging adapters in deterministic CLI regression tests.
- Regression test added:
  - hanging adapter beyond timeout exits non-zero and persists fallback run artifacts.

## Current verification state

- `pnpm --filter @martin/cli test -- cli.test.ts` passed (25/25).
- `pnpm --filter @martin/cli lint` passed.

## C.6 Windows Codex launch parity

- Root cause from field audit: doctor/preflight probe resolved one Codex executable path while runtime adapter launch could still use a different default command path.
- Fix implemented:
  - `executeRunCommand` now captures `codexProbe.command` and passes it into runtime adapter selection.
  - `selectAdapter` now accepts an optional `codexCommandOverride` and forwards it to `createCodexCliAdapter`.
- Result:
  - runtime launch path is now pinned to the exact command path proven by the launch probe in the same run.

## C.10 staging rerun evidence (internal exact branch)

- Full staging gate rerun on `codex/gsd-phase08-mainline` after C.6:
  - `pnpm --filter @martin/cli test` passed (12/12 files, 109 tests)
  - `pnpm --filter @martin/cli lint` passed
  - `pnpm test` passed
  - `pnpm build` passed
  - `pnpm oss:validate` passed
  - `pnpm public:smoke` passed
  - `pnpm --filter @martinloop/mcp lint` passed
  - `pnpm --filter @martinloop/mcp test` passed
  - `pnpm --filter @martinloop/mcp build` passed
  - `pnpm --filter @martinloop/mcp smoke:pack` passed
  - `pnpm --filter @martinloop/mcp smoke:published:pack` passed
  - `pnpm --filter @martinloop/mcp verify:release` passed
  - `pnpm release:matrix:local` passed

## Remaining C-slice status

- C.1 path traversal reject: closed in code + tests.
- C.2 `--cwd` config isolation: closed in code + tests.
- C.3 selector parity canonicalization: covered by canonical selector test; keep open for external field replay confirmation.
- C.4 weak-integrity share trust degradation: closed in code + tests.
- C.5 stuck-run timeout + fail-closed finalization: closed in code + tests.
- C.6 Windows Codex probe/run parity: closed in code.
- C.7 integrity-state split: partially improved via trust degradation and explicit warnings; state vocabulary expansion still pending full public-surface contract update.
- C.8 proof-mode gate alignment: closed in code + tests.
- C.9 unknown-field warning on copied receipts: closed in code + tests.
- C.10 full client rerun contract: internal gate rerun complete; external field rerun still pending.
- C.11 staging/public promotion: pending.

## Public-copy scan hygiene follow-up

- Hardened `scripts/public-copy-scan.mjs` scope to scan `.github` markdown surfaces only (not workflow YAML), preventing false positives from CI script names.
- Validation:
  - `node --test scripts/tests/public-copy-scan.test.mjs` passed.
- Current scan output still flags two existing artifact-policy violations in this repo baseline:
  - `docs/assets/phase3c-sidesidebyside-demo.html`
  - `docs/release/OSS-M2-HARVEST-HANDOFF.md`
- These are pre-existing repository artifacts and require explicit disposition before claiming a fully green public-copy gate for promotion.
