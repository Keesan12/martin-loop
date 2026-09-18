# @martinloop/mcp 0.6.5

The 0.6.5 MCP release stays aligned with MartinLoop 0.6.5 and its prelaunch usability fixes.

## What changed

- Package, server, runtime, plugin, and MCPB product versions align at 0.6.5.
- MCP install metadata points at the exact `@martinloop/mcp@0.6.5` package line.
- `loopPreviewSchema` now advertises `activeAttemptId` as an optional string property so MCP hosts can surface the active attempt ID for in-progress runs.
- MCPB manifest schema remains 0.3.

```sh
npx -y @martinloop/mcp@0.6.5
```
