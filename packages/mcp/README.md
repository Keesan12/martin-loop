# @keean12/mcp

Martin Loop's installable Model Context Protocol server.

It exposes three MCP tools over stdio:

- `martin_run`
- `martin_inspect`
- `martin_status`

## Quickstart

Run the packaged server directly:

```sh
npx @keean12/mcp
```

Add it to Claude Code:

```sh
# macOS/Linux
claude mcp add --scope user martin-loop -- npx @keean12/mcp

# Windows PowerShell/cmd
claude mcp add --scope user martin-loop cmd /c "npx @keean12/mcp"
```

For clients that want explicit command/args:

- Command: `npx`
- Args: `@keean12/mcp`

## Official MCP Registry

This package is prepared for the official MCP Registry metadata flow:

- npm package: `@keean12/mcp`
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
pnpm --filter @keean12/mcp build
pnpm --filter @keean12/mcp test
pnpm --filter @keean12/mcp smoke:pack
```

`smoke:pack` packs the tarball, launches it through `npx`, performs the MCP handshake, lists tools, and verifies a `martin_status` call.
