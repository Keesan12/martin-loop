# @martinloop/mcp v0.1.2

`@martinloop/mcp@0.1.2` is the pre-listing hardening release for the standalone Martin Loop MCP server. This release focuses on real run-store compatibility, safer standalone packaging, clearer install guidance, and stronger cross-platform release verification before external registry submission.

## Highlights

### Real run-store compatibility

- `martin_inspect` now supports canonical persisted runs at `<runsDir>/<loopId>/loop-record.json` and legacy `*.jsonl` run-store files.
- `martin_inspect` now supports `file` and `runsDir`, and can default to `MARTIN_RUNS_DIR` or `~/.martin/runs`.
- `martin_status` now supports persisted run lookups through `file`, `loopId`, `runsDir`, and `latest`, while keeping `loopJson` for backward compatibility.
- `martin_status` now rejects ambiguous selector combinations with clear validation errors.

### Governed MCP execution improvements

- `martin_run` now preserves `allowedPaths` and `deniedPaths` in the runtime task contract.
- `martin_run` now resolves `repoRoot` from `workingDirectory` before execution starts.
- The MCP server now writes to a real file-backed run store in the MCP path so saved runs can be inspected by `martin_inspect` and `martin_status`.

### Standalone packaging hardening

- The packaged MCP tarball now rebuilds tracked vendored runtime dependencies before packing, preventing stale local build residue from leaking into the npm artifact.
- The standalone package now vendors the tracked Martin runtime facades it actually needs instead of depending on unrelated workspace outputs being present on disk.
- The package manifest exposes both `mcp` and `martin-loop-mcp`, while keeping `npx @martinloop/mcp` as the primary install path.

### Install and release verification hardening

- Public install guidance is standardized to:
  - direct run: `npx @martinloop/mcp`
  - Claude macOS/Linux: `claude mcp add --scope user martin-loop -- npx @martinloop/mcp`
  - Claude Windows: `claude mcp add --scope user martin-loop cmd /c "npx @martinloop/mcp"`
- `smoke:pack` verifies the packed tarball after fresh vendored builds.
- `smoke:published` verifies the installed package artifact from an isolated temp workspace, which keeps the published-artifact smoke deterministic on Windows as well as Linux and macOS.
- The RC gate list now includes `pnpm mcp:published:smoke`.

## Metadata

- npm package: `@martinloop/mcp`
- MCP registry server name: `io.github.keesan12/martin-loop`
- Node runtime requirement: `>=20`

## Verification

- `pnpm --filter @martinloop/mcp lint`
- `pnpm --filter @martinloop/mcp test`
- `pnpm --filter @martinloop/mcp build`
- `pnpm --filter @martinloop/mcp smoke:pack`
- `pnpm --filter @martinloop/mcp smoke:published`
- `pnpm release:matrix:local`

## Publish path

- Merge PR `#34` to `main`
- Push tag `mcp-v0.1.2`
- Let `.github/workflows/publish-mcp.yml` publish via npm trusted publishing
- Verify live npm with `npm view @martinloop/mcp version`
- Re-run `pnpm --filter @martinloop/mcp smoke:published` against the real published package

## Notes

- npm publication is the required precursor to any official MCP Registry submission.
