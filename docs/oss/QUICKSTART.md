# Quickstart

This quickstart is intentionally conservative. It is written for a fresh engineer validating the current Phase 13 release-candidate state, not for a hypothetical future public release.

## Public launch target vs current RC path

The frozen public launch target is:

- `npm install martin-loop`
- `npx martin-loop ...`
- `import { MartinLoop } from "martin-loop"`

That launch surface is now implemented in the root package facade and smoke-validated from a clean temporary install. This quickstart still documents the honest RC-from-source path because public registry publication is a later release step.

## Prerequisites

- Node.js 20+ recommended
- `pnpm` 10.x
- A clean local checkout of this repo

Optional for live runs:

- Claude Code CLI for the Claude adapter path
- OpenAI Codex CLI plus credentials for the Codex adapter path

## Install and build

From the repo root:

```bash
pnpm install
pnpm build
```

## Run the RC validation matrix

```bash
pnpm rc:validate
```

What this does:

- creates an isolated temporary home or profile directory
- points Martin run artifacts at that clean location
- runs the current build, lint, test, benchmark, and certification matrix
- writes step logs into a temp `martin-rc-validation-*` directory

Use this when you want to answer, "Can a fresh environment still reproduce the current RC baseline?"

## RC gate commands

The current Phase 13 RC gate is made of these commands:

- `pnpm oss:validate`
- `pnpm public:smoke`
- `pnpm repo:smoke`
- `pnpm rc:validate`
- `pnpm pilot:prep:validate`
- `pnpm release:matrix:local`

Recommended order for a fresh local reviewer:

```bash
pnpm oss:validate
pnpm public:smoke
pnpm repo:smoke
pnpm rc:validate
pnpm release:matrix:local
```

`pnpm release:matrix:local` runs the full local OS lane for the current machine. The repository also defines Windows, macOS, and Linux CI lanes in `.github/workflows/phase13-release-matrix.yml`.

## Stub-safe CLI run

This is the safest first run because it avoids real provider spend.

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

This path uses the stub adapter and still exercises the loop, persistence, and policy surfaces.

## Config-driven run

The repo ships an example config at `martin.config.example.yaml`.

Martin auto-looks for `martin.config.yaml` in the invocation root, or you can pass `--config <path>`.

Example:

```bash
pnpm run:cli -- run --config martin.config.example.yaml --objective "Run with repo defaults" --verify "pnpm --filter @martin/core test"
```

## Inspect a saved run

Martin persists runs under `~/.martin/runs/` by default, or under `MARTIN_RUNS_DIR` if you override it.

```bash
pnpm run:cli -- inspect --file path/to/loop-record.json
```

For persisted run folders, inspect the `contract.json`, `state.json`, `ledger.jsonl`, and `artifacts/attempt-XXX/` files together. Those artifacts are the source of truth for runtime behavior.

## MCP server

Build first, then start the server from the workspace:

```bash
pnpm --filter @martin/mcp build
node packages/mcp/dist/server.js
```

The current MCP tools are:

- `martin_run`
- `martin_inspect`
- `martin_status`

## Notes for reviewers

- Fresh-home behavior matters. Do not rely only on a long-lived `~/.martin` directory.
- Exact-versus-estimated cost labels are meaningful and should not be merged in docs or dashboards.
- The repo contains control-plane code, but the public OSS boundary is still being finalized during Phase 13.
- The benchmark harness remains a workspace-level RC surface; `martin bench` is not part of the publishable CLI boundary yet.
