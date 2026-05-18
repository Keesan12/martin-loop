# Quickstart

This quickstart is for the public OSS runtime, CLI, and MCP surfaces only.

## Prerequisites

- Node.js 20+
- `pnpm` 10.x for repo-local work
- Optional for live runs: Claude Code CLI or Codex CLI on `PATH`

## Install and build

From the repo root:

```bash
pnpm install --frozen-lockfile
pnpm build
```

## Validate the OSS surface

```bash
pnpm test
pnpm oss:validate
pnpm public:smoke
pnpm --filter @martinloop/mcp smoke:pack
```

Use `pnpm rc:validate` when you want the same checks to run inside an isolated temp home.

## Stub-safe CLI run

### PowerShell

```powershell
$env:MARTIN_LIVE='false'
pnpm run:cli -- run --objective "Summarize the current runtime state" --verify "pnpm --filter @martin/core test"
Remove-Item Env:MARTIN_LIVE
```

### Bash

```bash
MARTIN_LIVE=false pnpm run:cli -- run --objective "Summarize the current runtime state" --verify "pnpm --filter @martin/core test"
```

## Config-driven run

The repo ships an example config at `martin.config.example.yaml`.

```bash
pnpm run:cli -- run --config martin.config.example.yaml --objective "Run with repo defaults" --verify "pnpm --filter @martin/core test"
```

## Inspect a saved run

```bash
pnpm run:cli -- inspect --file path/to/loop-record.json
```

Martin persists runs under `~/.martin/runs/` by default, or under `MARTIN_RUNS_DIR` if you override it.

## MCP server

Launch the published MCP package:

```bash
npx -y @martinloop/mcp
```

Claude Code install:

```bash
# macOS/Linux
claude mcp add --transport stdio --scope user martin-loop -- npx -y @martinloop/mcp

# Windows PowerShell/cmd
claude mcp add --transport stdio --scope user martin-loop -- cmd /c npx -y @martinloop/mcp
```

Codex install:

```bash
codex mcp add martin-loop -- npx -y @martinloop/mcp
```

Recommended first-use flow:

```text
martin_doctor
martin_preflight
martin_run
martin_inspect or martin_status
```

Repo-local MCP verification:

```bash
pnpm --filter @martinloop/mcp lint
pnpm --filter @martinloop/mcp test
pnpm --filter @martinloop/mcp build
pnpm --filter @martinloop/mcp smoke:pack
pnpm --filter @martinloop/mcp smoke:published:pack
pnpm --filter @martinloop/mcp verify:release
```

Official MCP Registry publication still happens after npm publication:

```bash
cd packages/mcp
mcp-publisher login github
mcp-publisher publish
```

## Local release matrix

```bash
pnpm release:matrix:local
```

This runs the Windows, macOS, and Linux lane definitions locally for the current machine’s platform and writes logs into a temp directory.
