# @martinloop/mcp v0.1.4

`@martinloop/mcp v0.1.4` is the first cohesive standalone execution-cockpit release for the public Martin Loop MCP package. This version keeps the install story host-native for Codex and Claude Code, adds read-only setup lanes ahead of execution, and hardens the release surface so docs, metadata, and pack-time verification move together.

## Highlights

### Five-tool governed execution cockpit

`0.1.4` turns the package into a clearer five-tool operator flow:

- `martin_doctor`
- `martin_preflight`
- `martin_run`
- `martin_inspect`
- `martin_status`

The intended flow is:

1. `martin_doctor`
2. `martin_preflight`
3. `martin_run`
4. `martin_inspect` or `martin_status`

This keeps environment diagnostics and contract validation separate from the actual code-changing run.

### Host-native install guidance

- The public MCP docs now lead with current host-native install snippets for:
  - Codex via `codex mcp add martin-loop -- npx -y @martinloop/mcp`
  - Claude Code via explicit stdio transport configuration
  - native Windows Claude Code installs via `cmd /c npx -y @martinloop/mcp`
- Codex guidance points to both `~/.codex/config.toml` and project-scoped `.codex/config.toml` for trusted projects.

### Release verification hardening

- Added a package-local `verify:release` command for the MCP surface.
- Added targeted release-doc tests that check:
  - `package.json` and `server.json` stay aligned
  - the current MCP release note exists for the package version
  - Codex and Claude Code install snippets stay current in the docs
  - the docs describe the actual tools-first cockpit flow
  - pre-publish local-pack smoke and post-publish npm smoke stay separate gates
- Metadata verification now also guards key package surface expectations such as shipped bin aliases, shipped files, and stdio transport declaration.

## What `0.1.4` does not claim

The current package is still a tools-only MCP server. `0.1.4` does not declare:

- MCP resources
- resource templates
- prompts
- richer run-listing surfaces such as `martin_list_runs`, `martin_get_run`, `martin_get_attempt`, `martin_get_verification_results`, or `martin_run_dossier`

Those capabilities belong to the broader `0.2.x` cockpit follow-up lane and should not be documented as already shipped in `0.1.4`.

## Metadata

- npm package: `@martinloop/mcp`
- MCP registry server name: `io.github.Keesan12/martin-loop`
- Node runtime requirement: `>=20`

## Release Verification Gates

- `pnpm --filter @martinloop/mcp lint`
- `pnpm --filter @martinloop/mcp test`
- `pnpm --filter @martinloop/mcp build`
- `pnpm --filter @martinloop/mcp smoke:pack`
- `pnpm --filter @martinloop/mcp smoke:published:pack`
- `pnpm --filter @martinloop/mcp verify:release`
- `pnpm --filter @martinloop/mcp smoke:published`

`smoke:published` remains a separate post-publish gate. Passing the local pack checks is not the same as proving the live npm artifact.

## Publish Path

- Merge the `0.1.4` release PR to `main`
- Push tag `mcp-v0.1.4`
- Let `.github/workflows/publish-mcp.yml` publish via npm trusted publishing
- Verify live npm with `npm view @martinloop/mcp version`
- Re-run `pnpm --filter @martinloop/mcp smoke:published` against the real published package
- From `packages/mcp`, run:
  - `mcp-publisher login github`
  - `mcp-publisher publish`

## `0.2.x` Cockpit Follow-Up

The next end-state for this package can grow toward a richer governed execution cockpit with:

- inspection tools like `martin_list_runs`, `martin_get_run`, `martin_get_attempt`, `martin_get_verification_results`, and `martin_run_dossier`
- resources and resource templates for server health, recent runs, guides, runs by `loopId`, attempts, and verification
- prompts for governed kickoff, failed-run debugging, and publish-readiness review

That follow-up work is not part of the current `0.1.4` publish claim.
