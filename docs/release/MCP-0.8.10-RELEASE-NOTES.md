# @martinloop/mcp 0.8.10

`@martinloop/mcp@0.8.10` aligns the standalone MCP package with the MartinLoop 0.8.10 correctness release.

## Included

- The packaged runtime carries the same path-scope, verifier-binding, budget-preflight, and Swarm workflow-state corrections as the root package.
- MCP package metadata, server metadata, plugin manifests, generated runtime version authority, and MCPB product version remain aligned at `0.8.10`.
- MCPB manifest schema remains `0.3`.

## Compatibility

No MCP tool names are removed. Existing host configuration continues to use `npx -y @martinloop/mcp`.

## Verification

The standalone package is accepted only after source tests, packed-package smoke, published-package smoke against the local tarball, MCPB validation, and the coordinated release gates pass on the exact versioned source.
