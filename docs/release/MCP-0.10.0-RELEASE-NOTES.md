# @martinloop/mcp 0.10.0

`@martinloop/mcp@0.10.0` aligns the standalone MCP package with MartinLoop 0.10.0.

## Included

- Durable mission status and recovery surfaces backed by source-bound checkpoints.
- Governed Memory V2 operations with explicit scope, provenance, promotion, and revocation authority.
- Restart-safe mission supervision that preserves bounded child execution and verifier-only completion authority.
- Aligned package, server, plugin, runtime, and MCPB product metadata at `0.10.0`.
- MCPB manifest schema remains `0.3`.

## Compatibility

No MCP tool name is removed. Existing host configuration continues to use `npx -y @martinloop/mcp`.

## Verification

The standalone package is accepted only after source tests, packed-package smoke, MCPB validation, coordinated release gates, and exact-head supported-platform validation pass.
