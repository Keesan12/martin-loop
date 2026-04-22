<div align="center">

# MartinLoop

### A governed runtime for autonomous AI coding agents.

[![License: MIT](https://img.shields.io/badge/license-MIT-7c3aed?style=flat-square)](./LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178c6?style=flat-square&logo=typescript&logoColor=white)](./tsconfig.base.json)
[![Node](https://img.shields.io/badge/node-%3E%3D20-3c873a?style=flat-square&logo=nodedotjs&logoColor=white)](#quick-start)
[![npm](https://img.shields.io/badge/npm-martin--loop-cc3534?style=flat-square&logo=npm&logoColor=white)](https://www.npmjs.com/package/martin-loop)

> AI coding agents are useful. Unbounded retry loops are not.
>
> MartinLoop wraps agent runs with budgets, policy checks, verifier gates, rollback evidence, and inspectable run records.

</div>

---

## Status

The public package surface is live as `martin-loop` and currently published on npm as version `0.1.2`.

```sh
npm install martin-loop
npx martin-loop
```

```typescript
import { MartinLoop } from "martin-loop";
```

This repository is still organized as a dual-track workspace: the OSS runtime and package facade are present, while the hosted control-plane, local dashboard, and benchmark harness remain repo/workspace surfaces rather than the primary npm package API. Older RC docs may still mention that registry publication was a later release step; as of this README pass, the `martin-loop` package is published, but broader release packaging and managed-product surfaces remain gated.

---

## The Problem

A typical autonomous coding loop keeps attempting work until tests pass. Without a governance layer, that loop can keep spending, mutate files outside the intended scope, lose track of why it failed, and leave teams without a clean audit trail.

MartinLoop calls that failure mode the Ralph Loop: attempt, check, retry, repeat, with no strong answer to:

- What changed?
- What did it cost?
- Why was it allowed?
- Why did it stop?
- Can we inspect or resume it later?

---

## What MartinLoop Does Today

| Capability | Current behavior |
|---|---|
| Budget governance | Enforces `maxUsd`, `softLimitUsd`, `maxIterations`, and `maxTokens`; rejects attempts projected to exceed remaining budget and exits on budget or iteration exhaustion. |
| Verifier gate | A run only reaches `completed` when the adapter result and verifier state pass. Unsafe verifier commands are blocked before agent execution. |
| Failure taxonomy | Classifies failures across 11 current classes, including hallucination, test regression, scope creep, repo grounding failure, environment mismatch, and budget pressure. |
| Safety leash | Evaluates verifier commands, file scope, dependency or migration changes that require approval, and secret-like values in task text. |
| Rollback evidence | Captures rollback boundaries and restore outcomes for repo-backed attempts when a persistence store is configured. |
| Context distillation | Carries a distilled summary of recent attempts and remaining constraints into subsequent attempts. |
| Run records | The CLI appends JSONL loop records under `~/.martin/runs/<workspaceId>.jsonl`; lower-level stores can also persist contracts, ledgers, and attempt artifacts. |

The result is a runtime that can complete good work, refuse unsafe work, stop uneconomical work, and leave evidence behind.

---

## Benchmark And Demo

The repo includes deterministic benchmark and demo surfaces under `benchmarks/` and `docs/assets/`. These are useful for review and validation, but the benchmark harness is still a workspace-level RC surface, not a `martin bench` command in the public npm package.

Reproducible local benchmark paths:

```sh
pnpm --filter @martin/benchmarks test
pnpm --filter @martin/benchmarks eval
pnpm --filter @martin/benchmarks eval:phase12
```

The side-by-side demo uses the current demo scenario numbers for "Repair Flaky CI Gate": MartinLoop completes with verifier-backed success at `$2.30`; the Ralph-style baseline spends `$5.20` and fails.

[See the interactive side-by-side demo](./docs/assets/phase3c-sidesidebyside-demo.html)

<div align="center">
  <img src="./docs/assets/martin-raplph.png.jpg" alt="MartinLoop illustration" width="380">
</div>

---

## Quick Start

### Install from npm

```sh
npm install -g martin-loop
```

This installs both `martin-loop` and `martin` command aliases.

### Run a governed task

```sh
martin run "fix the auth regression" \
  --budget 3.00 \
  --verify "pnpm test"
```

You can also pass the objective explicitly:

```sh
martin run --objective "fix the auth regression" --budget 3.00 --verify "pnpm test"
```

For a no-spend repo-local dry run, use the stub adapter:

```powershell
$env:MARTIN_LIVE='false'
pnpm run:cli -- run --objective "Summarize the current runtime state" --verify "pnpm --filter @martin/core test"
Remove-Item Env:MARTIN_LIVE
```

### Inspect or resume runs

```sh
martin inspect --file ~/.martin/runs/<workspaceId>.jsonl
martin resume <loopId>
```

`inspect` prints a portfolio summary for records in the file. `resume` looks up a persisted loop record by ID under `~/.martin/runs/`.

---

## CLI

```text
martin run <objective> [options]

  --objective <text>      The task to accomplish, or pass it as the first positional arg
  --budget <n>            Hard cost cap in USD
  --budget-usd <n>        Alias for --budget
  --soft-limit-usd <n>    Soft budget threshold in USD
  --verify <cmd>          Verifier command after each attempt
  --max-iterations <n>    Maximum number of attempts
  --max-tokens <n>        Maximum total token budget
  --engine <name>         Adapter to use: claude (default) or codex
  --model <name>          Override the adapter model
  --cwd <path>            Repo root for the run
  --allow-path <glob>     Restrict agent writes to this path pattern; repeatable
  --deny-path <glob>      Block this path pattern; repeatable
  --accept <criterion>    Add an acceptance criterion; repeatable
  --config <path>         Path to a martin.config.yaml file
  --workspace <id>        Workspace ID for the run record
  --project <id>          Project ID for the run record
  --metadata <key=value>  Attach metadata to the run record; repeatable
```

The public CLI also includes `inspect`, `resume`, and a `bench` redirect that points reviewers to the workspace benchmark harness.

---

## Policy File

Drop a `martin.config.yaml` in your repo root to set governance defaults:

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

---

## TypeScript SDK

```sh
npm install martin-loop
```

```typescript
import {
  MartinLoop,
  createClaudeCliAdapter,
  createCodexCliAdapter,
  runMartin
} from "martin-loop";

const loop = new MartinLoop({
  adapter: createClaudeCliAdapter({ workingDirectory: process.cwd() }),
  defaults: {
    workspaceId: "my-workspace",
    projectId: "my-project",
    budget: {
      maxUsd: 3.00,
      softLimitUsd: 2.25,
      maxIterations: 3,
      maxTokens: 20_000
    }
  }
});

const result = await loop.run({
  task: {
    title: "Fix auth regression",
    objective: "Fix the failing auth regression tests",
    verificationPlan: ["pnpm test"],
    repoRoot: process.cwd()
  }
});

console.log(result.decision.status);
```

Use Codex instead of Claude by swapping adapters:

```typescript
const loop = new MartinLoop({
  adapter: createCodexCliAdapter({ workingDirectory: process.cwd() })
});
```

The lower-level `runMartin` function is also exported for callers that want to assemble the runtime input directly.

---

## Workspace Map

| Package or app | Role |
|---|---|
| `martin-loop` | Root public npm facade that vendors the runtime, CLI, adapters, and contracts into `dist/`. |
| `@martin/contracts` | Shared types for loops, policy, governance, budget, telemetry, and rollback. |
| `@martin/core` | Runtime controller, policy engine, safety leash, grounding, persistence, and rollback logic. |
| `@martin/adapters` | Claude CLI, Codex CLI, direct-provider, and stub adapter surfaces. |
| `@martin/cli` | Local CLI implementation for `run`, `inspect`, `resume`, and the benchmark redirect. |
| `@martin/mcp` | MCP server tools: `martin_run`, `martin_inspect`, and `martin_status`. |
| `benchmarks/` | Workspace-only deterministic benchmark and RC validation harness. |
| `apps/control-plane/` | Hosted control-plane workstream, outside the initial npm package surface. |
| `apps/local-dashboard/` | Local dashboard/read-model viewer, not currently packaged as public npm API. |

The `@martin/core`, `@martin/adapters`, and `@martin/contracts` package manifests are still private workspace packages; the public install target is the root `martin-loop` facade.

---

## Development

Requirements: Node 20+ and pnpm 10.x.

```sh
git clone https://github.com/Keesan12/MartinLoop
cd MartinLoop/martin-loop
pnpm install

pnpm test
pnpm lint
pnpm build
```

Current RC gate commands:

```sh
pnpm oss:validate
pnpm public:smoke
pnpm repo:smoke
pnpm rc:validate
pnpm pilot:prep:validate
pnpm release:matrix:local
```

Helpful docs:

- [OSS quickstart](./docs/oss/QUICKSTART.md)
- [OSS examples](./docs/oss/EXAMPLES.md)
- [OSS boundary report](./docs/oss/OSS-BOUNDARY-REPORT.md)
- [Release surface report](./docs/oss/RELEASE-SURFACE-REPORT.md)

---

## Contributing

```sh
git checkout -b feat/your-feature
pnpm lint
pnpm test
git commit -m "feat: describe what you built"
git push -u origin feat/your-feature
```

Conventional commit prefixes: `feat:`, `fix:`, `chore:`, `docs:`, `refactor:`, and `test:`.

---

<div align="center">

**Give the repo a star** if you think AI coding needs budgets, brakes, and receipts.

**MIT Licensed** · [martinloop.com](https://martinloop.com) · [keesan@martinloop.com](mailto:keesan@martinloop.com)

*"AI coding accountability: completes good work, refuses unsafe work, stops uneconomical work."*

</div>
