# D-LEDGER (Execution Log)

## D.0 Baseline

- Confirmed branch: `claude/martinloop-hero-image-a01s2b`, clean except for unrelated in-flight
  Routing Cost Control changes (left untouched, not regressed).
- Read `codex-launcher.ts`, `cli-bridge.ts`, `claude-cli.ts`, `run-loop.ts`,
  `server-validation.ts` to locate every code path involved in launching Codex/Claude on Windows.
- Confirmed `classifyProbeFailure()` already fingerprints the exact failure class being reported
  (`CreateProcessAsUserW failed: 5`, "windows sandbox: runner error", read-only/approval-disabled
  sandbox) but only used it to abort with a remediation string, never to retry with a shallower
  invocation.
- Confirmed both `createCodexCliAdapter` and `createClaudeCliAdapter` funnel their live execution
  through the same shared `runSubprocess`/`createSpawnPlan` chokepoint in `cli-bridge.ts` — so a
  fix there benefits both engines without duplicating Codex-specific shim logic into
  `claude-cli.ts`.
- Limitation: no Windows host or VS Code process tree available in this remote Linux execution
  environment, so the live PowerShell-vs-VS-Code repro matrix could not be run literally. Treated
  as a documented gap, not silently skipped (see D-VERIFICATION.md).

## D.1 Shallow Windows shim invocation (cli-bridge.ts)

- Added `resolveNpmShimScript(shimPath)`: reads an npm-generated `.cmd`/`.bat`/`.ps1` shim file,
  extracts the `node <script>.js` target it wraps (matches `%~dp0%`/`%dp0%`/`$basedir`-relative
  paths), resolves it relative to the shim's own directory, and returns it only if the resolved
  script actually exists on disk.
- `createSpawnPlan` now calls this first for any resolved `.cmd`/`.bat`/`.ps1` command; on success
  it returns `{ command: process.execPath, args: [scriptPath, ...args] }` — bypassing the
  `cmd.exe /d /c` / `powershell.exe -File` wrapper hop entirely. Falls back to the prior wrapper
  behavior unchanged when resolution fails, preserving the existing fallback paths exactly.
- Added `packages/adapters/tests/cli-bridge.test.ts` covering: `.cmd` shim resolution, `.ps1` shim
  resolution, missing-target-script fallback, missing-shim-file fallback, and
  no-recognizable-script-reference fallback.

## D.2 Probe/run invocation-depth parity (codex-launcher.ts)

- `buildProbeCommand` (used by `probeCodexLaunch`) now reuses `resolveNpmShimScript` the same way,
  so the live launch probe exercises the same process-nesting depth as the real run instead of
  potentially diverging from it.
- Updated the Windows-subprocess-launch-failure remediation text in `classifyProbeFailure` to
  state that direct invocation was already attempted, since that's now true by construction
  (resolution happens unconditionally on the first attempt, not as a separate retry pass).
- Added a `probeCodexLaunch` test that builds a synthetic Windows `.cmd` shim on disk and asserts
  `spawnSyncImpl` is invoked with `process.execPath` + the resolved script path, not `cmd.exe`.

## D.3 Claude adapter

- No separate shim-detection module needed: confirmed `claude-cli.ts`'s live execution already
  routes through the same `runSubprocess`/`createSpawnPlan` chokepoint fixed in D.1, so Claude
  gets the same shallow-invocation behavior on Windows automatically.

## D.4 Silent sandbox-blocked-write classification (core)

- Added `sandbox_write_blocked` to `FAILURE_CLASSES` (`packages/contracts/src/index.ts`).
- `classifyPatchDecisionFailure` (`packages/core/src/index.ts`) now takes the adapter's
  `MartinAdapterResult` and, for the default/no-other-violation branch, checks the adapter's
  `summary`/`failure.message` text against the same Windows sandbox-write-blocked signatures
  (`CreateProcessAsUserW failed`, "windows sandbox: runner error", read-only/approval-disabled
  sandbox) — if matched, classifies as `sandbox_write_blocked` (retryable, recommends
  `switch_adapter`) instead of generic `no_progress`.
- Added an integration test in `packages/core/tests/runtime.test.ts`: a stub adapter reports
  `verification.passed: true`, `execution.changedFiles: []`, and a summary containing the
  Windows sandbox-launch-failure signature; asserts the resulting patch decision is `DISCARD`
  with reason `no_code_change` and the attempt's `failureClass` is `sandbox_write_blocked`.

## Verification

- `pnpm --filter @martin/adapters test` passed (5 files, 82 tests).
- `pnpm --filter @martin/core test` passed (17 files, 198 tests).
- `pnpm --filter @martin/adapters lint` passed; `pnpm --filter @martin/contracts lint` passed.
- `pnpm -r build` passed across `contracts`, `core`, `mcp`, `adapters`, `benchmarks`, `cli`.
- Confirmed (via `git stash` + rerun) that the one failing lint target,
  `@martin/core lint` on `tests/trace-store.test.ts`, fails identically on the pre-existing base
  commit — not a regression introduced by this slice.

## Remaining D-slice status

- D.0 hypothesis confirmation: closed via static analysis; live Windows/VS Code field repro still
  recommended as a follow-up to close the loop with direct evidence.
- D.1 shallow Windows shim invocation: closed in code + tests.
- D.2 probe/run invocation-depth parity: closed in code + tests.
- D.3 Claude adapter parity: closed — no separate code needed, inherited from D.1.
- D.4 sandbox-write-blocked failure classification: closed in code + tests.
