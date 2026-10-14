# @martinloop/mcp 0.8.5 — release alignment

The standalone MCP package advances with MartinLoop 0.8.5 and remains aligned with the root package, plugin metadata, and MCPB product version.

This patch carries the shared process-tree cleanup correction for macOS and Linux, where an owned process group containing only defunct entries is treated as closed and ambiguous process information still fails closed. The MCPB manifest schema remains `0.3`.
