# D.0-D.4 Verification Snapshot

Date: 2026-06-26
Repo: `martin-loop`
Branch: `claude/martinloop-hero-image-a01s2b`
Base commit before this slice: `5117669` (chore(release): 0.3.12)

## Files touched in this slice

- `packages/adapters/src/cli-bridge.ts` — `createSpawnPlan` now tries direct shim-script
  invocation before falling back to `cmd.exe`/`powershell.exe`; new exported
  `resolveNpmShimScript` helper.
- `packages/adapters/src/codex-launcher.ts` — `buildProbeCommand` reuses
  `resolveNpmShimScript` so the launch probe matches the real run's invocation depth; updated
  remediation text for the Windows sandbox-launch-failure signature to reflect that direct
  invocation is already attempted.
- `packages/contracts/src/index.ts` — added `sandbox_write_blocked` to `FAILURE_CLASSES`.
- `packages/core/src/index.ts` — `classifyPatchDecisionFailure` now detects known sandbox-write
  -blocked signatures in the adapter's reported summary/failure text and classifies a
  no-code-change attempt as `sandbox_write_blocked` instead of generic `no_progress`.
- New tests: `packages/adapters/tests/cli-bridge.test.ts`,
  additions to `packages/adapters/tests/codex-launcher.test.ts` and
  `packages/core/tests/runtime.test.ts`.

## Targeted test gates

- `pnpm --filter @martin/adapters test` -> PASS (5 files, 82 tests)
- `pnpm --filter @martin/core test` -> PASS (17 files, 198 tests)
- `pnpm --filter @martin/adapters lint` -> PASS
- `pnpm --filter @martin/contracts lint` -> PASS

## Repo-level build gates

- `pnpm -r build` -> PASS (contracts, core, mcp, adapters, benchmarks, cli)

## Known pre-existing, unrelated issue (not introduced by this slice)

- `pnpm --filter @martin/core lint` fails on `tests/trace-store.test.ts` (TS2345/TS2532, strict
  `undefined` narrowing). Confirmed via `git stash` + rerun that this failure exists identically
  on the base commit before any D-slice changes — out of scope for this fix, not touched.

## Live-repro limitation (explicit, not silently skipped)

- This session runs in a remote Linux execution environment with no Windows host and no VS Code
  process tree available, so the PowerShell-vs-VS-Code repro matrix called for in D.0 could not
  be executed literally. The fix instead targets the exact mechanism already evidenced in code
  (`classifyProbeFailure`'s Windows sandbox/process-launch signatures) and was validated via:
  - unit tests that construct a synthetic npm Windows `.cmd`/`.ps1` shim on disk and confirm
    `resolveNpmShimScript`/`buildProbeCommand`/`createSpawnPlan` resolve and invoke the wrapped
    script directly instead of through `cmd.exe`/`powershell.exe`;
  - confirming `process.platform !== "win32"` and unresolvable-shim paths are untouched (existing
    `codex-launcher.test.ts` cases for Linux/WSL/native Windows binaries still pass unchanged).
- Recommend the next Windows/VS Code repro (PowerShell vs. VS Code integrated terminal vs. VS
  Code agent panel, both `claude` and `codex` engines) be captured on an actual Windows host to
  close out D.0 with field evidence.
