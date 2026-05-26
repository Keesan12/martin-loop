# @martinloop/mcp v0.2.0

`@martinloop/mcp@0.2.0` is the public cockpit expansion release for the standalone Martin Loop MCP package. The release keeps `martin_run` as the only write-capable entrypoint and adds read-only inspection, resources, resource templates, and prompts for hosts that need richer post-run context.

## What Shipped

### Read-only cockpit inspection

- added `martin_list_runs`
- added `martin_get_run`
- added `martin_get_attempt`
- added `martin_get_verification_results`
- added `martin_run_dossier`
- kept `martin_run` as the only execution entrypoint

### Resources

- added `martin://server/health`
- added `martin://runs/recent`
- added `martin://guides/mcp-usage`
- added `martin://guides/publish-readiness`

### Resource templates

- added `martin://runs/{loopId}`
- added `martin://runs/{loopId}/attempts/{attemptIndex}`
- added `martin://runs/{loopId}/verification`

### Prompts

- added `martin_governed_coding_kickoff`
- added `martin_debug_failed_run`
- added `martin_publish_readiness_review`

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
- all newly added MCP surfaces in `0.2.0` are read-only

## Later-Line Boundary

`0.2.0` is the cockpit expansion contract. Later stable-line polish belongs to `0.2.5` and should not be described as part of this release unless it is explicitly labeled as later-line behavior.
