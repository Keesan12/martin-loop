# @martinloop/mcp 0.8.8 — truthful observation failures and safer verifier input

The standalone MCP package advances with MartinLoop 0.8.8, aligned with the root package, plugins, and MCPB product version.

- **Late observation errors cannot become verified results.** A failure to inspect workspace effects after execution ends the attempt with an explicit failure and safe rollback is attempted.
- **New focused tests are protected.** Newly created tests that focus, skip, or mark expected failures require test-change approval; ordinary new tests remain allowed.
- **Ignored-file checks are bounded and private.** Aggregate hash I/O is capped and content hashes remain ephemeral rather than entering persisted MCP evidence.
- **Verifier input remains fail-closed.** Valid launcher-prefixed MartinLoop commands are recognized without accepting malformed quotes or unsafe folded options. JSON verification-plan entries no longer receive CLI argv-fold detection, while malformed quotes remain rejected.
- **Claude cost provenance is preserved.** An authoritative provider cost remains available even when token usage details are missing.

To start the versioned MCP package:

```sh
npx -y @martinloop/mcp@0.8.8
```

MCPB product version is `0.8.8`; manifest schema remains `0.3`.

**Boundary:** MartinLoop governs observed repository effects; a provider running with host OS privileges is not automatically sandboxed by MCP or by allowed-path configuration.
