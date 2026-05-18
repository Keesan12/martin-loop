<div align="center">

# MartinLoop

### A governed runtime for autonomous AI coding agents.

[![License: MIT](https://img.shields.io/badge/license-MIT-7c3aed?style=flat-square)](./LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178c6?style=flat-square&logo=typescript&logoColor=white)](./tsconfig.base.json)
[![Node](https://img.shields.io/badge/node-%3E%3D20-3c873a?style=flat-square&logo=nodedotjs&logoColor=white)](#quick-start)
[![npm](https://img.shields.io/badge/npm-martin--loop-cc3534?style=flat-square&logo=npm&logoColor=white)](https://www.npmjs.com/package/martin-loop)

MartinLoop wraps AI coding-agent runs with budgets, policy checks, verifier gates, rollback evidence, and inspectable run records.

</div>

## Status

The public package surface is `martin-loop`, currently published on npm as version `0.1.2`.

```sh
npm install -g martin-loop
npx martin-loop --help
```

```typescript
import { MartinLoop } from "martin-loop";
```

The repo also contains workspace surfaces for benchmarks, an MCP server, a hosted control-plane workstream, and a local dashboard. Those are useful for review and development, but the public npm package surface is the root facade.

## What It Enforces Today

| Capability | Current behavior |
|---|---|
| Budget governance | Enforces budget, token, and iteration constraints through preflight and lifecycle exits. |
| Verifier gate | Completion requires verifier success, not only agent self-report. |
| Safety leash | Checks verifier commands, file scope, dependency or migration changes that need approval, and secret-like task text. |
| Failure taxonomy | Uses 11 current failure classes from `@martin/contracts`. |
| Run records | Appends JSONL loop records under `~/.martin/runs/`. |
| Rollback evidence | Repo-backed runs can persist rollback boundaries and restore outcomes. |

## Quick Start

```sh
martin run "fix the auth regression" \
  --budget 3.00 \
  --verify "pnpm test"
```

Inspect a run file:

```sh
martin inspect --file ~/.martin/runs/<workspaceId>.jsonl
```

Resume a persisted loop record:

```sh
martin resume <loopId>
```

## Config

Use `martin.config.yaml` in the repo root for defaults:

```yaml
budget:
  maxUsd: 5.00
  softLimitUsd: 3.75
  maxIterations: 5
  maxTokens: 40000

governance:
  destructiveActionPolicy: approval
  telemetryDestination: local-only
  verifierRules:
    - pnpm test
```

CLI flags override config values when provided.

## Validation

From the repo root:

```sh
pnpm test
pnpm public:smoke
pnpm oss:validate
pnpm release:surface:validate
```

Workspace benchmark and certification harnesses live under `benchmarks/`:

```sh
pnpm --filter @martin/benchmarks test
pnpm --filter @martin/benchmarks eval:phase12
pnpm --filter @martin/benchmarks eval:providers
```

## Package Map

| Surface | Role |
|---|---|
| `martin-loop` | Public npm facade. |
| `@martin/core` | Runtime controller, policy, safety leash, rollback, persistence. |
| `@martin/cli` | CLI implementation for `run`, `inspect`, and `resume`. |
| `@martin/adapters` | Claude CLI, Codex CLI, direct-provider, and stub adapters. |
| `@martin/contracts` | Shared runtime and governance types. |
| `@martin/mcp` | MCP tools for run, inspect, and status. |

## Positioning

MartinLoop does not replace coding agents. It governs the loop around them: what they may try, what it may cost, how completion is verified, and what evidence is left behind.
