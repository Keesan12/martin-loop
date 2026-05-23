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

## Three-minute first value

Start with the public CLI readiness check:

```bash
npx martin-loop doctor
```

Then prove the flow locally without provider spend:

```bash
npx martin-loop demo
cd martin-loop-demo
npm install
MARTIN_LIVE=false npx martin-loop run "Summarize the demo workspace and confirm the verifier is green" --verify "npm test"
npx martin-loop dossier --latest
```

`dossier --latest` summarizes what happened, verifier evidence, rollback or artifact evidence, directional token or cost totals, and the next safe action.

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

Generated local profile examples:

```bash
martin mcp print-config --host codex --profile minimal
martin mcp print-config --host claude --profile diagnostic
martin mcp print-config --host gemini --profile full-local
martin mcp install --host codex --scope project --dry-run
```

Profile guide:

- `minimal` is the default read-only local profile for readiness, preflight, run listing, triage, and dossier review.
- `diagnostic` adds deeper read-only run archaeology.
- `full-local` is the profile that exposes `martin_run` for local execution hosts.

Recommended first-use flow:

```text
martin_doctor
martin_preflight
martin_list_runs
martin_run_dossier
martin_run
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
