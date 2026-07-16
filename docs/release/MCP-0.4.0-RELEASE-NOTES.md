# @martinloop/mcp 0.4.0 Release Notes

## Release Summary

`0.4.0` is the star and messaging milestone for the standalone MartinLoop MCP package. Private endpoint configuration has been removed from the public build. The server remains local-first and stdio-first.

## What this release adds

- star tier progression tracking wired into the governed run surface
- structured messaging events emitted at milestone boundaries
- `martin_run` now surfaces star tier and messaging state through the next-step resource
- private Codex host configuration removed from the public export surface — the public build no longer accepts or forwards private endpoint overrides

## Breaking changes

- `__setCodexHostOverridesForTests` is no longer exported. Any test harness that referenced this export must remove the call or use the no-op stub.
- Private endpoint configuration passed through CLI flags is silently ignored in this build. Public cloud defaults apply.

## Verification

- `pnpm --filter @martinloop/mcp lint`
- `pnpm --filter @martinloop/mcp test`
- `pnpm --filter @martinloop/mcp build`
- `pnpm --filter @martinloop/mcp smoke:pack`
- `pnpm --filter @martinloop/mcp smoke:published:pack`
- `pnpm --filter @martinloop/mcp verify:release`
