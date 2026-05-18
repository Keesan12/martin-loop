# @martinloop/mcp v0.1.4

`@martinloop/mcp@0.1.4` is the operator-foundation release for the public standalone Martin Loop MCP package.

## Highlights

### Five-tool operator flow

`0.1.4` exposes:

- `martin_doctor`
- `martin_preflight`
- `martin_run`
- `martin_inspect`
- `martin_status`

Recommended flow:

1. `martin_doctor`
2. `martin_preflight`
3. `martin_run`
4. `martin_inspect` or `martin_status`

### Host-native install guidance

- Codex: `codex mcp add martin-loop -- npx -y @martinloop/mcp`
- Claude Code macOS/Linux: `claude mcp add --transport stdio --scope user martin-loop -- npx -y @martinloop/mcp`
- Claude Code Windows: `claude mcp add --transport stdio --scope user martin-loop -- cmd /c npx -y @martinloop/mcp`

### Release-proof hardening

- package metadata stays aligned between `package.json` and `server.json`
- checked-in release notes are used for the GitHub release body
- the publish workflow verifies:
  - `smoke:pack`
  - `smoke:published:pack`
  - `verify:release`
  - `smoke:published`

## What `0.1.4` does not claim

This release is still a tools-only MCP server. It does not claim:

- resources
- resource templates
- prompts
- `martin_list_runs`
- `martin_triage_runs`
- `martin_get_run`
- `martin_get_attempt`
- `martin_get_verification_results`
- `martin_run_dossier`

Those belong to the later `0.2.x` public releases, not to `0.1.4`.

## Metadata

- npm package: `@martinloop/mcp`
- MCP registry server name: `io.github.Keesan12/martin-loop`
- Node runtime: `>=20`

## Verification Gates

- `pnpm --filter @martinloop/mcp lint`
- `pnpm --filter @martinloop/mcp test`
- `pnpm --filter @martinloop/mcp build`
- `pnpm --filter @martinloop/mcp smoke:pack`
- `pnpm --filter @martinloop/mcp smoke:published:pack`
- `pnpm --filter @martinloop/mcp verify:release`
- `pnpm --filter @martinloop/mcp smoke:published`

## Publish Path

- merge the `0.1.4` release candidate
- push tag `mcp-v0.1.4`
- let `.github/workflows/publish-mcp.yml` publish through npm trusted publishing
- verify live npm with `npm view @martinloop/mcp version`
