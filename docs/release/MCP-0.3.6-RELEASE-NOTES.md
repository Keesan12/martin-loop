# @martinloop/mcp 0.3.6 Release Notes

## Release Summary

`0.3.6` is the current public standalone MCP baseline for MartinLoop.

This release keeps the MCP package aligned with the public root CLI line, preserves the local-first stdio transport, and keeps the public docs and package metadata consistent with the version already shipped on npm.

## What this release represents

- stable standalone MCP package metadata on the `0.3.6` line
- public release notes and version ledger aligned with the live npm package
- no hosted-only transport or private control-plane language introduced into the OSS MCP surface

## Verification

- `pnpm --filter @martinloop/mcp lint`
- `pnpm --filter @martinloop/mcp test`
- `pnpm --filter @martinloop/mcp build`
- `pnpm --filter @martinloop/mcp smoke:pack`
- `pnpm --filter @martinloop/mcp smoke:published:pack`
- `pnpm --filter @martinloop/mcp verify:release`
