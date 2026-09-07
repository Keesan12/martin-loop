# @martinloop/mcp 0.6.0

The 0.6.0 MCP release aligns host installation and packaged metadata with the MartinLoop 0.6.0 release.

## What changed

- Re-running MCP installation refreshes a stale canonical MartinLoop server entry.
- Unrelated host configuration is preserved during supported JSON and Codex TOML merges.
- Package, server, runtime, and MCPB product versions are aligned at 0.6.0.
- The MCPB manifest schema remains 0.3.

```sh
npx -y @martinloop/mcp@0.6.0
```
