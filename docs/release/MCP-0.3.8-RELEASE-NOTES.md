# @martinloop/mcp 0.3.8 Release Notes

## Release Summary

`0.3.8` is a reliability patch on top of `0.3.7` that hardens the MCP server's interaction with the governed run loop.

The server remains local-first and stdio-first.

## What this release adds

- budget circuit breaker fix: MCP-initiated runs now respect the configured budget cap and terminate correctly when the limit is reached
- engine auto-discovery: the server selects the active engine without requiring explicit host configuration when the environment is unambiguous
- verification diagnostics: preflight and post-run verification errors now include structured diagnostic output through the MCP transport
- resilience defaults: the server applies conservative defaults for timeout, retry, and error propagation instead of inheriting host-side assumptions

## Verification

- `pnpm --filter @martinloop/mcp lint`
- `pnpm --filter @martinloop/mcp test`
- `pnpm --filter @martinloop/mcp build`
- `pnpm --filter @martinloop/mcp smoke:pack`
- `pnpm --filter @martinloop/mcp smoke:published:pack`
- `pnpm --filter @martinloop/mcp verify:release`
