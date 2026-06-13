# MartinLoop 0.3.1

`0.3.1` is a trust-hardening follow-up release focused on claim-to-code parity.

## Highlights

- Benchmark reproduction is now deterministic from a clean repo workflow.
- Public benchmark command paths are now tested end-to-end in CI.
- The public CLI now supports `--version` / `version` / `-V` directly.
- CLI doctor output now reports the public root package version for release clarity.
- Public trust-boundary language is explicit about usage provenance and receipt integrity.

## Fixed

- **Benchmark command reliability:** `@martin/benchmarks` eval/report commands now run from built runtime output (`dist/eval.js`) with pre-build hooks, eliminating fragile local `tsx` resolution assumptions.
- **Public command reproducibility:** root scripts (`bench:build`, `bench:test`, `bench:eval`, `bench:report:ralphy`) now route through the benchmark workspace commands used in docs and test coverage.
- **CLI version ergonomics:** `martin-loop --version` now returns a machine- and human-friendly version result instead of falling through to help text.
- **Release identity clarity:** `doctor --json` now reports the root public package version in `cliVersion`.

## Verification

- `pnpm bench:eval`
- `pnpm bench:report:ralphy`
- `node --test scripts/tests/benchmarks-workspace.test.mjs`
- `pnpm --filter @martin/cli test`
- `node --test scripts/tests/readme-public-surface.test.mjs`
- `node --test scripts/tests/public-copy-scan.test.mjs`

## Compatibility

- No hosted transport or private-control-plane features are introduced in this release.
- Root and standalone MCP release lines remain independent (`martin-loop` vs `@martinloop/mcp`).
