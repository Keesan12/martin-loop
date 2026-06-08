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
