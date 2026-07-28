# @martinloop/mcp 0.3.9 Release Notes

## Release Summary

`0.3.9` adds an audited, cross-platform MCPB distribution for installing MartinLoop in MCPB-compatible desktop clients. The npm package and MCP Registry entry remain available for standard stdio integrations.

## What this release adds

- a self-contained `martinloop-0.3.9.mcpb` bundle built from the reviewed pnpm lockfile
- a SHA-256 checksum published beside the bundle on the GitHub Release
- validation on Ubuntu, macOS, and Windows with Node.js 20 and 24
- explicit client configuration for the workspace root, run storage, and live execution
- safer defaults: `MARTIN_LIVE` remains disabled unless the user enables it

## Installing the MCPB bundle

Download `martinloop-0.3.9.mcpb` and `martinloop-0.3.9.mcpb.sha256` from this GitHub Release. Verify the checksum, import the bundle into an MCPB-compatible client, select the allowed workspace and run-storage directories, and launch the server.

## Verification

- `pnpm --filter @martinloop/mcp lint`
- `pnpm --filter @martinloop/mcp test`
- `pnpm --filter @martinloop/mcp build`
- `pnpm --filter @martinloop/mcp smoke:pack`
- `pnpm --filter @martinloop/mcp smoke:published:pack`
- `pnpm --filter @martinloop/mcp verify:release`
- `pnpm --filter @martinloop/mcp mcpb:build`
- `pnpm --filter @martinloop/mcp mcpb:validate`
