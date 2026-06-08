# Martin MCP `0.2.7` Release Packet

This packet records the public baseline we are now building from.

## Release summary

- package: `@martinloop/mcp@0.2.7`
- release tag: `mcp-v0.2.7`
- public role: standalone local-first MCP server for governed coding work

## What `0.2.7` established

- guided adoption for real MCP hosts
- clearer operating rules and next-step guidance
- a harder default gate around `martin_run`
- consistent package metadata, release notes, and public docs

## Commands run before release

- `pnpm --filter @martinloop/mcp lint`
- `pnpm --filter @martinloop/mcp test`
- `pnpm --filter @martinloop/mcp build`
- `pnpm --filter @martinloop/mcp smoke:pack`
- `pnpm --filter @martinloop/mcp smoke:published:pack`
- `pnpm --filter @martinloop/mcp verify:release`

## Why this packet exists

This is the release boundary for the next train.

`0.3.0`, `0.3.1`, and `0.3.2` should extend the standalone MCP line from this baseline without dragging in hosted, tenant, billing, or control-plane language.
