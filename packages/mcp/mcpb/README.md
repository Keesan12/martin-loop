# MartinLoop MCPB

Packages the existing `@martinloop/mcp` local stdio server as an MCP Bundle (`.mcpb`). This is an additional distribution format; it does not replace npm or the official MCP Registry package.

## Install and build

From the repository root, install the reviewed workspace lockfile. Then build and
validate the bundle from `packages/mcp`:

Commit or stash any uncommitted changes under `packages/mcp` before building;
the release builder intentionally requires that package tree to be clean.

```bash
pnpm install --frozen-lockfile
cd packages/mcp
pnpm mcpb:build
pnpm mcpb:validate
```

Outputs:

```text
dist-mcpb/martinloop-<version>.mcpb
dist-mcpb/martinloop-<version>.mcpb.sha256
```

## Import and launch

Open a client that supports MCP Bundles, choose its bundle import or install
command, and select `dist-mcpb/martinloop-<version>.mcpb`. Review the requested
configuration, finish the import, and launch MartinLoop from the client's MCP
server controls.

The exact import label varies by client. Keep the `.mcpb` file intact; do not
extract it and launch files from inside the archive.

## Configure the server

| Setting | Environment variable | Purpose |
|---|---|---|
| `workspace_root` | `MARTIN_MCP_WORKSPACE_ROOT` | Approved repository boundary |
| `runs_root` | `MARTIN_RUNS_DIR` | Local receipts and evidence root |
| `live_mode` | `MARTIN_LIVE` | Enables or disables live execution |

`live_mode` defaults to `false`. MartinLoop must reject workspace escapes, avoid stdout contamination, and never package credentials, `.env` files, source repositories, or existing receipts.

Set `workspace_root` to the repository MartinLoop may access. Set `runs_root` to
the directory where run receipts should be written. Leave `live_mode` disabled
until you intentionally want governed execution.

## Verify the installation

After launch, confirm that the client reports the MartinLoop server as connected
and that its tools are listed. Run the doctor or status tool first, with
`live_mode` still `false`, and verify that the response is structured MCP output
without terminal text mixed into the protocol stream. A live execution request
must remain blocked while `MARTIN_LIVE=false`.

## Release gate

Do not publish until Linux, macOS, and Windows CI lanes pass lint, tests, standalone build, npm package smoke tests, MCPB build and validation, archive inspection, checksum verification, runtime initialization, live-disabled blocking, and path-escape rejection.
