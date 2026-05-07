# @martin/mcp

Martin Loop's installable Model Context Protocol server.

It exposes three MCP tools over stdio:

- `martin_run`
- `martin_inspect`
- `martin_status`

## Quickstart

Run the packaged server directly:

```sh
npx -y @martin/mcp
```

Add it to Claude Code:

```sh
claude mcp add martin-loop -- npx -y @martin/mcp
```

For clients that want explicit command/args:

- Command: `npx`
- Args: `-y`, `@martin/mcp`

## Official MCP Registry

This package is prepared for the official MCP Registry metadata flow:

- npm package: `@martin/mcp`
- registry server name: `io.github.keesan12/martin-loop`
- manifest file: `packages/mcp/server.json`

The official registry publish flow is separate from npm publication. After publishing the package to npm, run the publisher from `packages/mcp`:

```sh
mcp-publisher login github
mcp-publisher publish
```

## Local Verification

From the repository root:

```sh
pnpm --filter @martin/mcp build
pnpm --filter @martin/mcp test
pnpm --filter @martin/mcp smoke:pack
```

`smoke:pack` packs the tarball, launches it through `npx`, performs the MCP handshake, lists tools, and verifies a `martin_status` call.
