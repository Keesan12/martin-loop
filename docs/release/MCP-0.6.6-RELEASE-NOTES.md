# @martinloop/mcp 0.6.6 — Reliability Patch

## What changed

### MCP schema compatibility
All 14 root-level `oneOf` combinators removed from tool `inputSchema` definitions. Hosts that validate tool schemas before invocation (Claude, Codex) now accept all MartinLoop tools. Selector exclusivity is still enforced at runtime by `server-validation.ts`.

### Windows Claude native-installer discovery
The MCP tool-support layer now suggests the native installer one-liner for Claude on Windows/macOS/Linux, replacing the deprecated npm global install suggestion.
