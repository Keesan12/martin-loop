# @martinloop/mcp

Martin Loop's installable Model Context Protocol server.

It exposes three MCP tools over stdio:

- `martin_run`
- `martin_inspect`
- `martin_status`

`martin_run` accepts budget fields (`maxUsd`, `maxIterations`, `maxTokens`),
`verificationPlan`, and optional repo-relative `allowedPaths` / `deniedPaths`.
When scope paths are supplied, MartinLoop passes them into both the agent prompt
and post-run filesystem leash checks using `workingDirectory` as the repo root.

## Quickstart

Run the packaged server directly:

```sh
npx @martinloop/mcp
```

Add it to Claude Code:

```sh
# macOS/Linux
claude mcp add --scope user martin-loop -- npx @martinloop/mcp

# Windows PowerShell/cmd
claude mcp add --scope user martin-loop cmd /c "npx @martinloop/mcp"
```

For clients that want explicit command/args:

- Command: `npx`
- Args: `@martinloop/mcp`

## Official MCP Registry

This package is prepared for the official MCP Registry metadata flow:

- npm package: `@martinloop/mcp`
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
pnpm --filter @martinloop/mcp build
pnpm --filter @martinloop/mcp test
pnpm --filter @martinloop/mcp smoke:pack
```

`smoke:pack` packs the tarball, launches it through `npx`, performs the MCP handshake, lists tools, and verifies a `martin_status` call.
