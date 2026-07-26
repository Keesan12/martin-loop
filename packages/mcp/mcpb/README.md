# MartinLoop MCPB

Packages the existing `@martinloop/mcp` local stdio server as an MCP Bundle (`.mcpb`). This is an additional distribution format; it does not replace npm or the official MCP Registry package.

## Build

From `packages/mcp`:

```bash
pnpm mcpb:build
pnpm mcpb:validate
```

Outputs:

```text
dist-mcpb/martinloop-<version>.mcpb
dist-mcpb/martinloop-<version>.mcpb.sha256
```

## Runtime configuration

| Setting | Environment variable | Purpose |
|---|---|---|
| `workspace_root` | `MARTIN_MCP_WORKSPACE_ROOT` | Approved repository boundary |
| `runs_root` | `MARTIN_RUNS_DIR` | Local receipts and evidence root |
| `live_mode` | `MARTIN_LIVE` | Enables or disables live execution |

`live_mode` defaults to `false`. MartinLoop must reject workspace escapes, avoid stdout contamination, and never package credentials, `.env` files, source repositories, or existing receipts.

## Cross-platform requirement

The builder uses the repository's shared `createCommandLaunch` helper. Windows commands run through `cmd.exe /d /s /c` with argument quoting; macOS and Linux execute commands directly with `shell: false`.

## Release gate

Do not publish until Linux, macOS, and Windows CI lanes pass lint, tests, standalone build, npm package smoke tests, MCPB build and validation, archive inspection, checksum verification, runtime initialization, live-disabled blocking, and path-escape rejection.
