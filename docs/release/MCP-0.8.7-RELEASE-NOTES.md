# @martinloop/mcp 0.8.7 — fail-closed preflight and safer governed work

The standalone MCP package advances with MartinLoop 0.8.7, aligned with the root package, plugins, and MCPB product version.

- **Verifier readiness is more reliable.** `martin_preflight` checks malformed verifier quotes and MartinLoop-owned flags inside verifier commands. It does not label malformed commands ready for execution.
- **Failed Claude sessions remain failed.** A Claude Code terminal error is not converted into VERIFIED merely because the configured test command was already passing. Real usage remains attributable when provider cost evidence exists.
- **Rollback honors filesystem links.** Changes crossing symlinks or Windows junctions cannot cause MartinLoop rollback to delete files outside its repository; unsafe rollback fails closed.
- **Test changes require authority.** Deleting an existing test, or removing or changing its assertions, cannot happen silently without explicit approval. Adding tests and editing imports need none, and Swarm contracts cannot widen test-change approval beyond parent authority.
- **Ignored and protected files matter.** Denied or protected ignored files are checked, secret-file writes need an explicit allowed path, and the resulting rollback outcome is stated accurately.

To start the versioned MCP package:

```sh
npx -y @martinloop/mcp@0.8.7
```

MCPB product version is `0.8.7`; manifest schema remains `0.3`.

**Boundary:** MartinLoop governs observed repository effects; a provider running with host OS privileges is not automatically sandboxed by MCP or by allowed-path configuration.
