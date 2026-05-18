# @martinloop/mcp v0.2.0

`@martinloop/mcp@0.2.0` is the first full public cockpit expansion release for the standalone Martin Loop MCP package.

## What Shipped

### Execution visibility

- added `martin_list_runs`
- added `martin_get_run`
- added `martin_get_attempt`
- added `martin_get_verification_results`
- added `martin_run_dossier`
- upgraded `martin_run` to return richer inspection, verification, and artifact rollups

### Context and discovery

- added static resources for server health, recent runs, MCP usage, and publish readiness
- added resource templates for runs, attempts, and verification
- added prompts for governed kickoff, failed-run debugging, and publish-readiness review

## Release Verification Gates

- `pnpm --filter @martinloop/mcp lint`
- `pnpm --filter @martinloop/mcp test`
- `pnpm --filter @martinloop/mcp build`
- `pnpm --filter @martinloop/mcp smoke:pack`
- `pnpm --filter @martinloop/mcp smoke:published:pack`
- `pnpm --filter @martinloop/mcp verify:release`
- `pnpm --filter @martinloop/mcp smoke:published`

## Compatibility Statement

- `martin_run` remains the only execution entrypoint
- existing `martin_inspect`, `martin_status`, `martin_doctor`, and `martin_preflight` flows remain backward-compatible
- all newly added MCP surfaces are read-only
