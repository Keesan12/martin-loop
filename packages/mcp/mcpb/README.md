# MartinLoop MCPB

This directory packages the existing `@martinloop/mcp` local stdio server as an
MCP Bundle (`.mcpb`). It is an additional distribution format; it does not
replace npm or the official MCP Registry package.

## Build

From `packages/mcp`:

```bash
pnpm mcpb:build
```

Generated output:

```text
dist-mcpb/martinloop-<version>.mcpb
dist-mcpb/martinloop-<version>.mcpb.sha256
```

The builder requires a clean `packages/mcp` working tree, builds the existing
standalone package, stages only required runtime files, installs production
runtime dependencies, validates the bundle with the pinned MCPB CLI major,
packs it, and emits a SHA-256 checksum.

## Runtime configuration contract

| MCPB setting | Environment variable | Purpose |
|---|---|---|
| `workspace_root` | `MARTIN_MCP_WORKSPACE_ROOT` | Approved repository boundary |
| `runs_root` | `MARTIN_RUNS_DIR` | Local receipts and evidence root |
| `live_mode` | `MARTIN_LIVE` | Enables or disables live execution |

These names must remain synchronized with the server implementation. MCPB
always sets `MARTIN_LIVE`; the bundle defaults it to `false` so installation is
inspection-only until the user explicitly enables live execution.

## Security requirements

MartinLoop runs with the permissions of the desktop client that launches it.
MCPB is packaging, not an operating-system sandbox. MartinLoop must therefore:

- operate only inside `MARTIN_MCP_WORKSPACE_ROOT`;
- store run data only inside `MARTIN_RUNS_DIR`;
- fail closed when `MARTIN_LIVE=false`;
- reject traversal, canonicalization, junction, and symlink escapes;
- avoid shell interpolation for user-controlled process arguments;
- never package credentials, `.env` files, source repositories, or receipts;
- reserve stdout for MCP protocol traffic and send logs to stderr.

## Final release audit

- [ ] `pnpm lint`
- [ ] `pnpm test`
- [ ] `pnpm smoke:pack`
- [ ] `pnpm mcpb:build`
- [ ] `pnpm mcpb:validate`
- [ ] Confirm `server/dist/server.js` and runtime dependencies are staged
- [ ] Inspect the archive for secrets, `.env` files, receipts, and source repos
- [ ] Confirm `martin_doctor` works while `MARTIN_LIVE=false`
- [ ] Confirm every execution tool is blocked while `MARTIN_LIVE=false`
- [ ] Confirm every filesystem tool rejects paths outside the approved root
- [ ] Test canonicalization and symlink/junction escapes on Windows and macOS
- [ ] Verify the published artifact against the generated SHA-256 checksum

## Publish to Smithery

After all audit checks pass:

```bash
npx smithery auth login
npx smithery mcp publish "./dist-mcpb/martinloop-<version>.mcpb" -n martinloop/martin-loop
```
