# @martinloop/mcp

Governed MCP server for AI coding agents with hard budgets, verifier gates, policy checks, and inspectable run records.

Martin Loop helps MCP hosts run AI coding work inside a bounded runtime instead of an open-ended retry loop. The standalone MCP package exposes three focused tools over stdio:

- `martin_run`
- `martin_inspect`
- `martin_status`

## What's new in 0.1.2

- `martin_inspect` now reads both canonical `loop-record.json` runs and legacy `.jsonl` run-store files
- `martin_status` now supports `file`, `loopId`, `runsDir`, and `latest` selectors in addition to inline `loopJson`
- `martin_run` now persists loop records by default in the MCP path and preserves `allowedPaths`, `deniedPaths`, and resolved `repoRoot`
- the packaged tarball now rebuilds vendored workspace dependencies before packing, so `npm` installs match current source instead of stale `dist/` output
- the packaged artifact now includes the Martin policy WASM bundle required for real runtime policy evaluation
- release validation now includes both a packed-tarball smoke and a published-artifact smoke

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

Generic stdio configuration for non-Claude clients:

```json
{
  "type": "stdio",
  "command": "npx",
  "args": ["@martinloop/mcp"]
}
```

## What the tools do

- `martin_run`: runs a governed coding loop with budget caps, verifier commands, engine selection, path scoping, and persisted loop records
- `martin_inspect`: reads Martin Loop run-store data from a canonical `loop-record.json`, a legacy `.jsonl` file, or a full runs directory
- `martin_status`: evaluates remaining budget pressure and stop conditions from inline JSON, a saved loop record, a loop id, or the latest persisted run

## Requirements

- Node 20+
- For live runs, either the `claude` CLI or the `codex` CLI must be on `PATH`
- For dry-run and smoke-test flows, set `MARTIN_LIVE=false`

Live `martin_run` delegates to the configured CLI adapter. If no supported CLI is installed, use the stub path for testing:

```sh
MARTIN_LIVE=false npx @martinloop/mcp
```

## Tool examples

### `martin_run`

Example request body:

```json
{
  "objective": "Fix the auth regression and prove it with tests",
  "engine": "codex",
  "budgetUsd": 3,
  "softLimitUsd": 2.25,
  "maxIterations": 3,
  "verificationPlan": ["pnpm test --filter auth"],
  "workingDirectory": ".",
  "allowedPaths": ["src/**", "tests/**"],
  "deniedPaths": [".env*", "secrets/**"]
}
```

### `martin_inspect`

Inspect the default run store:

```json
{}
```

Inspect a legacy JSONL file directly:

```json
{
  "file": "C:/Users/you/.martin/runs/workspace.jsonl"
}
```

Inspect a canonical runs directory:

```json
{
  "runsDir": "C:/Users/you/.martin/runs"
}
```

### `martin_status`

Status for the latest saved run:

```json
{
  "latest": true
}
```

Status for a specific persisted loop:

```json
{
  "loopId": "loop-123",
  "runsDir": "C:/Users/you/.martin/runs"
}
```

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

## Local verification

From the repository root:

```sh
pnpm --filter @martinloop/mcp lint
pnpm --filter @martinloop/mcp test
pnpm --filter @martinloop/mcp build
pnpm --filter @martinloop/mcp smoke:pack
pnpm --filter @martinloop/mcp smoke:published
```

- `smoke:pack` validates the local packed tarball before publish
- `smoke:published` validates the npm-published artifact through `npm exec`
