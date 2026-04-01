# Martin Loop

A TypeScript coding-loop orchestration engine. Martin wraps AI coding CLIs (Claude Code, OpenAI Codex) in a governed retry loop with budget enforcement, failure classification, and exit intelligence.

## What it does

Given an objective and a verification plan, Martin will:
1. Submit the task to a coding agent (Claude or Codex)
2. Run your verification commands after each attempt
3. Classify failures and decide whether to retry
4. Exit cleanly when the task passes, the budget runs out, or retries are exhausted

## Canonical Runtime Files

These are the 5 entry points that define Martin's live code. Start here when navigating the codebase:

| # | File | Role |
|---|------|------|
| 1 | `packages/contracts/src/index.ts` | All shared types (LoopRecord, LoopBudget, events) |
| 2 | `packages/core/src/index.ts` | Orchestration engine (runMartin, exit intelligence) |
| 3 | `packages/adapters/src/claude-cli.ts` | Claude CLI adapter implementation |
| 4 | `packages/cli/src/index.ts` | CLI entry point (martin run/inspect/bench) |
| 5 | `packages/mcp/src/server.ts` | MCP server (martin_run, martin_inspect tools) |

## Packages

| Package | Description |
|---|---|
| `@martin/contracts` | Shared types: LoopRecord, LoopBudget, LoopAttempt, events |
| `@martin/core` | Orchestration engine: runMartin(), cost governor, exit intelligence, failure classifier |
| `@martin/adapters` | Adapter implementations: Claude CLI, Codex CLI, stub |
| `@martin/cli` | CLI binary: `martin run/inspect/bench` |
| `@martin/mcp` | MCP server: `martin_run`, `martin_inspect`, `martin_status` tools |

## Prerequisites

- Node.js 18+
- pnpm 8+
- **Claude Code CLI** (for Claude adapter): `npm install -g @anthropic-ai/claude-code` then `claude auth login`
- **OpenAI Codex CLI** (for Codex adapter): `npm install -g @openai/codex` then set `OPENAI_API_KEY`

## Installation

```bash
git clone https://github.com/your-org/martin-loop
cd martin-loop
pnpm install
pnpm build
```

## CLI Usage

```bash
# Run a task with Claude (default)
martin run --objective "Fix the off-by-one error in counter.ts" \
  --verify "pnpm test" \
  --max-iterations 5 \
  --budget-usd 10

# Run with OpenAI Codex
martin run --objective "Refactor auth middleware" \
  --engine codex \
  --model o3 \
  --verify "pnpm test"

# Set working directory
martin run --objective "Fix the bug" --cwd /path/to/repo

# Inspect a saved loop record
martin inspect --file loop-record.json

# Run benchmark suite
martin bench --suite ralphy-smoke
```

### All CLI flags

| Flag | Default | Description |
|---|---|---|
| `--objective` | required | The task for the agent |
| `--engine` | `claude` | `claude` or `codex` |
| `--model` | engine default | Override model (e.g. `claude-opus-4-6`, `o3`) |
| `--verify` | none | Verification command (repeatable) |
| `--cwd` | `process.cwd()` | Working directory for the agent |
| `--max-iterations` | 8 | Max loop iterations |
| `--budget-usd` | 25 | Max spend in USD |
| `--soft-limit-usd` | 15 | Soft limit (triggers compress_context intervention) |
| `--max-tokens` | 80000 | Max total tokens |
| `--workspace` | `ws_default` | Workspace ID for loop records |
| `--project` | `proj_default` | Project ID for loop records |
| `--policy` | none | `strict` or `balanced` |
| `--config` | auto-detected | Path to `martin.config.yaml` |

### Config file (`martin.config.yaml`)

```yaml
policyProfile: strict
budget:
  maxUsd: 20
  softLimitUsd: 12
  maxIterations: 6
  maxTokens: 60000
governance:
  destructiveActionPolicy: approval
  telemetryDestination: control-plane
  verifierRules:
    - pnpm test
    - pnpm lint
```

## MCP Server

Register Martin as an MCP tool server for Claude Desktop or any MCP-compatible client:

```bash
# Add to Claude Code
claude mcp add martin-loop -- npx @martin/mcp

# Or if installed locally after cloning
claude mcp add martin-loop -- node /path/to/martin-loop/packages/mcp/dist/server.js
```

### Available MCP tools

**`martin_run`** — Run a coding loop against an objective.
```json
{
  "objective": "Fix the auth middleware bug",
  "engine": "claude",
  "model": "claude-opus-4-6",
  "workingDirectory": "/path/to/repo",
  "verificationPlan": ["pnpm test", "pnpm lint"],
  "maxIterations": 5,
  "maxUsd": 10
}
```

**`martin_inspect`** — Inspect a saved loop record JSON file.
```json
{ "file": "/path/to/loop-record.json" }
```

**`martin_status`** — Get budget pressure and remaining headroom.
```json
{ "loopJson": "{...serialized LoopRecord...}" }
```

## Environment variables

| Variable | Value | Description |
|---|---|---|
| `MARTIN_LIVE` | `false` | Use stub adapter (safe for CI / dry runs — no real agent calls) |

## Testing

```bash
# All tests (89 tests across 7 packages)
pnpm test

# Build
pnpm build

# Lint
pnpm lint

# Stub dry run
MARTIN_LIVE=false martin run --objective "test" --max-iterations 1

# Live eval harness (requires claude installed and authenticated)
pnpm eval
```

## Project Structure

```
martin-loop/
├── packages/
│   ├── contracts/     # Shared types and event schemas
│   ├── core/          # Orchestration engine (runMartin)
│   ├── adapters/      # Claude CLI, Codex CLI, stub adapters
│   ├── cli/           # martin CLI binary
│   └── mcp/           # MCP server
├── apps/
│   ├── control-plane/ # Next.js governance dashboard
│   └── local-dashboard/ # Express + vanilla JS local UI
├── benchmarks/        # Eval harness and fixture tasks
├── docs/legacy/       # Historical reference material
├── scripts/           # Build and utility scripts
├── deploy/            # Deployment configuration
└── .planning/         # GSD project planning (rebuild roadmap)
```

## Publishing

```bash
pnpm build
pnpm publish -r --access public
```
