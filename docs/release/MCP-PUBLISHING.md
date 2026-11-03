# MCP Publishing

The standalone MCP line is published as its own package. Treat it like a product surface, not a side effect of the root package.

## Current public truth

- current published standalone package: `@martinloop/mcp` (live version: `0.8.10`)
- current in-repo standalone release baseline: `0.9.0` (pending publication)
- next planned standalone release: `0.9.0`, after exact release acceptance
- publish authority: GitHub Actions trusted publishing / OIDC

## Before publish

- confirm package metadata, server metadata, and release notes all describe the same version
- confirm docs and README copy match the exact shipped MCP surface
- confirm the release notes sound customer-facing, not internal
- confirm packed tarball contents stay limited to the package payload

## Required gates

- `pnpm --filter @martinloop/mcp lint`
- `pnpm --filter @martinloop/mcp test`
- `pnpm --filter @martinloop/mcp build`
- `pnpm --filter @martinloop/mcp smoke:pack`
- `pnpm --filter @martinloop/mcp smoke:published:pack`
- `pnpm --filter @martinloop/mcp verify:release`

## Release-note rule

Each standalone release needs release notes that answer four things plainly:

- what changed
- why it matters
- how to start using it
- what was verified before release
