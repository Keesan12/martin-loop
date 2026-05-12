# Martin Loop MCP 0.1.2 Release Notes

## Summary

`@martinloop/mcp@0.1.2` is the pre-listing hardening release for the standalone Martin Loop MCP server. This release focuses on real run-store compatibility, safer packaging, cleaner install guidance, and stronger release verification before external directory submissions.

## What changed from 0.1.1

### Real run-store support

- `martin_inspect` now reads both canonical persisted runs at `<runsDir>/<loopId>/loop-record.json` and legacy `*.jsonl` run-store files.
- `martin_inspect` now supports:
  - `file?: string`
  - `runsDir?: string`
  - defaulting to `MARTIN_RUNS_DIR` or `~/.martin/runs` when no selector is provided.
- `martin_status` now supports persisted run lookups through:
  - `file?: string`
  - `loopId?: string`
  - `runsDir?: string`
  - `latest?: boolean`
  - while keeping `loopJson?: string` for backward compatibility.
- `martin_status` now rejects ambiguous selector combinations with a clear validation error.

### Governed run execution

- `martin_run` now preserves `allowedPaths` and `deniedPaths` into the runtime task contract.
- `martin_run` now resolves `repoRoot` from `workingDirectory` before the run starts.
- `martin_run` now creates a real file-backed run store in the MCP path so saved run records are available to `martin_inspect` and `martin_status`.

### Packaging and install hardening

- the packaged MCP tarball now rebuilds vendored workspace dependencies before packing, preventing stale `dist/` output from leaking into the npm artifact.
- the packaged MCP tarball now rebuilds and vendors the Martin runtime dependencies required by the standalone server.
- the package manifest now exposes both:
  - `mcp`
  - `martin-loop-mcp`
  while keeping `npx @martinloop/mcp` as the primary install path.
- public install guidance is normalized to:
  - direct run: `npx @martinloop/mcp`
  - Claude macOS/Linux: `claude mcp add --scope user martin-loop -- npx @martinloop/mcp`
  - Claude Windows: `claude mcp add --scope user martin-loop cmd /c "npx @martinloop/mcp"`

### Documentation and metadata

- npm-facing README copy now leads with Martin Loop’s real product story: governed AI coding loops with budgets, verifier gates, policy checks, and audit trails.
- README examples now cover:
  - `martin_run`
  - `martin_inspect`
  - `martin_status`
- package metadata remains aligned to:
  - package name: `@martinloop/mcp`
  - official MCP Registry server name: `io.github.keesan12/martin-loop`

### Release validation

- `smoke:pack` now verifies the packed tarball after fresh vendored builds.
- new `smoke:published` validates the npm-installed artifact through `npm exec`.
- the RC/release surface checks now include the published-artifact smoke gate.

## Verification performed before publish

- `pnpm --filter @martinloop/mcp lint`
- `pnpm --filter @martinloop/mcp test`
- `pnpm --filter @martinloop/mcp build`
- `pnpm --filter @martinloop/mcp smoke:pack`
- `pnpm --filter @martinloop/mcp smoke:published` against a fresh local `0.1.2` tarball via `MARTIN_MCP_PACKAGE_SPEC`
- `node --test scripts/tests/rc-validation.test.mjs scripts/tests/release-matrix.test.mjs scripts/tests/release-surface-audit.test.mjs`
- `node scripts/release-surface-audit.mjs`

## Known release blocker

The live npm package is still `@martinloop/mcp@0.1.1` until terminal npm auth is restored and `0.1.2` is published. External directory submissions should stay blocked until:

- `npm publish --access public` succeeds for `0.1.2`
- `npm view @martinloop/mcp version` returns `0.1.2`
- `pnpm mcp:published:smoke` passes against the real published package

## Next release candidate

`0.1.3` is the right place for macOS-specific verification and any mac-only launcher fixes, unless that validation happens before `0.1.2` is published.
