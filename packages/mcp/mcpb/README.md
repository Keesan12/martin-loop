# MartinLoop MCPB

This packages the local `@martinloop/mcp` server as an MCP Bundle (`.mcpb`) for clients that support bundle-based installation.

The distribution format is different; the product is the same.

**MartinLoop is one system around coding agents so people can go from intent to a production-quality software handoff without stitching together separate tools around the agent.**

The coding agent still does the software work. MartinLoop connects the workflow around it: defining what should ship, running the work, checking the result, recovering when needed, and leaving a handoff that another person or agent can understand.

The MCPB carries the same governed outcomes and evidence rules as the standalone MCP package. Packaging must not create a different meaning for `VERIFIED`, `STOPPED`, `NEEDS REVIEW`, cost provenance, verification-only execution, or receipt integrity.

The product version is aligned with `@martinloop/mcp`; the current manifest schema remains `0.3`.

For agent-readable product context see [`../../../llms.txt`](../../../llms.txt), [`../../../llms-full.txt`](../../../llms-full.txt), and [`../../../docs/for-agents.md`](../../../docs/for-agents.md).

## Build the bundle

From the repository root:

```bash
pnpm install --frozen-lockfile
cd packages/mcp
pnpm mcpb:build
pnpm mcpb:validate
```

The release builder intentionally requires the `packages/mcp` tree to be clean.

Outputs:

```text
dist-mcpb/martinloop-<version>.mcpb
dist-mcpb/martinloop-<version>.mcpb.sha256
```

## Import and launch

In an MCP client that supports bundles, choose its bundle import/install action and select:

```text
dist-mcpb/martinloop-<version>.mcpb
```

Review the requested configuration, finish the import, and start MartinLoop from the client's MCP server controls.

Keep the `.mcpb` file intact. Do not extract it and manually launch files from inside the archive.

## Configure MartinLoop

| Setting | Environment variable | Purpose |
|---|---|---|
| `workspace_root` | `MARTIN_MCP_WORKSPACE_ROOT` | Repository or workspace MartinLoop may access |
| `runs_root` | `MARTIN_RUNS_DIR` | Local directory for run records and handoff evidence |
| `live_mode` | `MARTIN_LIVE` | Enables or disables live coding-agent execution |

`live_mode` defaults to `false`.

Set `workspace_root` to the repository MartinLoop may access and `runs_root` to the local directory where run records should be written. Leave live execution disabled until you intentionally want the client to start or control coding-agent work.

MartinLoop must reject workspace escapes and must not package credentials, `.env` files, source repositories, or existing run records into the bundle.

## Verify the installation

After launch:

1. Confirm the client reports MartinLoop as connected.
2. Confirm its MCP tools are discoverable.
3. Run a doctor/status/inspection path first while `MARTIN_LIVE=false`.
4. Confirm a live execution request remains blocked while live mode is disabled.

A live-disabled call is inspection or verification evidence only. It is not proof that a coding agent edited the repository.

## Release gate

Do not publish a bundle until the release lanes have validated the package build, MCPB schema, archive contents, checksum, initialization, live-disabled blocking, and workspace-boundary behavior on the supported platforms.
