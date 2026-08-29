# @martinloop/mcp 0.5.6

This release strengthens packaged MCP portability and version integrity.

## Changes

- Canonicalizes temporary workspace paths in the packed-package smoke lane.
- Keeps package, server initialization, plugin, MCPB product, and install metadata aligned at `0.5.6`.
- Includes the read-only Arcade MCP App resource surface while retaining one governed execution authority.
- Fails release validation when generated runtime metadata or source TypeScript resolution drifts.

The MCPB manifest schema remains `0.3`; `0.5.6` is the product version.
