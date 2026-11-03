# @martinloop/mcp 0.9.0

`@martinloop/mcp@0.9.0` aligns the standalone MCP package with MartinLoop 0.9.0.

## Included

- Capability-aware pause, continue, and cancellation controls for eligible local runs.
- Terminal-state precedence, auditable requested-versus-applied outcomes, and exact cancellation signal/publication binding.
- Hardened control journals and execution leases with fail-closed replay, link, stale-lock, PID-reuse, and concurrent-reclaimer handling.
- Aligned package, server, plugin, runtime, and MCPB product metadata at `0.9.0`.
- MCPB manifest schema remains `0.3`.

## Compatibility

No MCP tool name is removed. Existing host configuration continues to use `npx -y @martinloop/mcp`.

## Verification

The standalone package is accepted only after source tests, packed-package smoke, MCPB validation, coordinated release gates, and exact-head hosted platform validation pass.
