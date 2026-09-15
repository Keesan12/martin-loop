# @martinloop/mcp 0.6.4

The 0.6.4 MCP release stays aligned with MartinLoop 0.6.4 and its run-lifecycle reliability fixes.

## What changed

- Package, server, runtime, plugin, and MCPB product versions align at 0.6.4.
- MCP install metadata points at the exact `@martinloop/mcp@0.6.4` package line.
- `martin_run` persists the active attempt before the provider wait so status, wait, cancellation, and recovery remain authoritative after a client timeout.
- MCPB manifest schema remains 0.3.

```sh
npx -y @martinloop/mcp@0.6.4
```
