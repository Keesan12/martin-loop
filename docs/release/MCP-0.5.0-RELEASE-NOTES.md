# @martinloop/mcp 0.5.0

The standalone MartinLoop MCP package advances to `0.5.0` with lifecycle management, aligned tool validation, and clearer governed prerequisites.

## Highlights

- Install, verify-install, rollback, and uninstall flows for supported hosts.
- Tool schemas, validators, and handlers aligned for run selection, dossier, review, and run-control inputs.
- Ordered governance prerequisites exposed consistently through discovery and execution errors.
- Machine-readable responses remain clean for MCP hosts and CI consumers.
- Run and workspace selectors reject stale or cross-workspace evidence.

## Install

```sh
npx -y @martinloop/mcp@0.5.0
```

The MCPB bundle is not advanced in this release and remains on its previously released `0.3.9` artifact.

MCP tools expose MartinLoop's configured checks and evidence; they do not establish that a change is universally correct or automatically safe to merge.
