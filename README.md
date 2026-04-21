<div align="center">

<!-- <img src="docs/assets/martinloop_logo_1.png" alt="MartinLoop" width="200"> -->

# MartinLoop

### The agentic AI governance runtime. Hard enforcement, not suggestions.

[![License: MIT](https://img.shields.io/badge/license-MIT-7c3aed?style=flat-square)](./LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178c6?style=flat-square&logo=typescript&logoColor=white)](./tsconfig.json)
[![Node](https://img.shields.io/badge/node-%3E%3D20-3c873a?style=flat-square&logo=nodedotjs&logoColor=white)](#quick-start)
[![npm](https://img.shields.io/badge/npm-martin--loop-cc3534?style=flat-square&logo=npm&logoColor=white)](https://npmjs.com/package/martin-loop)

<br>

> **Your overnight AI pipeline estimated $2.40.**
> **You woke up to $165.**
>
> 47 retries. No hard stop. No rollback. No audit trail. Nothing merged.
> **MartinLoop exists so that never happens again.**

</div>

---

## ⚡ Quick Start

### 1. Install

```sh
npm install -g martin-loop
```

This gives you two commands: `martin` and `martin-loop` (both identical).

### 2. Run a governed task

```sh
martin run "fix the auth regression" \
  --budget 3.00 \
  --verify "pnpm test"
```

What each flag does:
- `--budget 3.00` — hard kill at $3.00. The subprocess is terminated at the limit.
- `--verify "pnpm test"` — shell command run after each attempt. Loop only exits success when it passes.

The first argument after `run` is your objective. You can also use `--objective`:

```sh
martin run --objective "fix the auth regression" --budget 3.00 --verify "pnpm test"
```

### 3. Resume an interrupted run

```sh
martin resume <loopId>
```

Loads the persisted loop record from `~/.martin/runs/` by ID.

### 4. Inspect a run file

```sh
martin inspect --file ~/.martin/runs/<workspaceId>.jsonl
```

Prints a portfolio summary (total cost, attempts, outcomes) for all loops in the file.

---

## 🖥️ All CLI Flags

```
martin run <objective> [options]

  --objective <text>      The task to accomplish (or pass as first positional arg)
  --budget <n>            Hard cost cap in USD (subprocess killed at limit)
  --budget-usd <n>        Alias for --budget
  --verify <cmd>          Shell command used as the verifier after each attempt
  --max-iterations <n>    Maximum number of attempts (default: 3)
  --engine <name>         Adapter to use: claude (default) or codex
  --model <name>          Override the model (e.g. claude-sonnet-4-6)
  --cwd <path>            Repo root for the run (default: current directory)
  --allow-path <glob>     Restrict agent to this path pattern (repeatable)
  --deny-path <glob>      Block agent from this path pattern (repeatable)
  --accept <criterion>    Add an acceptance criterion injected into the prompt (repeatable)
  --config <path>         Path to a martin.config.yaml policy file
  --workspace <id>        Workspace ID for the run record (default: ws_default)
  --project <id>          Project ID for the run record (default: proj_default)
  --metadata <key=value>  Attach metadata to the run record (repeatable)
```

---

## 📋 Policy File (martin.config.yaml)

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

The CLI picks this up automatically. CLI flags always override the config file.

---

## 📦 TypeScript SDK

Install as a library:

```sh
npm install martin-loop
```

```typescript
import {
  MartinLoop,
  createClaudeCliAdapter,
  createCodexCliAdapter
} from 'martin-loop'

const loop = new MartinLoop({
  adapter: createClaudeCliAdapter({ workingDirectory: process.cwd() }),
  defaults: {
    budget: {
      maxUsd: 3.00,
      softLimitUsd: 2.25,
      maxIterations: 3,
      maxTokens: 20_000
    }
  }
})

const result = await loop.run({
  workspaceId: 'my-workspace',
  projectId: 'my-project',
  task: {
    title: 'Fix auth regression',
    objective: 'Fix the failing auth regression tests',
    verificationPlan: ['pnpm test'],
    repoRoot: process.cwd()
  },
  budget: {
    maxUsd: 3.00,
    softLimitUsd: 2.25,
    maxIterations: 3,
    maxTokens: 20_000
  }
})

// result.decision.status          → 'completed' | 'exited' | 'failed'
// result.decision.lifecycleState  → 'completed' | 'budget_exit' | 'human_escalation' | ...
// result.loop.cost.actualUsd      → actual USD spent
// result.loop.attempts.length     → number of attempts made
// result.decision.reason          → why the loop exited
```

### Using Codex instead of Claude

```typescript
const loop = new MartinLoop({
  adapter: createCodexCliAdapter({ workingDirectory: process.cwd() })
})
```

### Using the lower-level `runMartin` directly

```typescript
import { runMartin, createClaudeCliAdapter } from 'martin-loop'

const result = await runMartin({
  workspaceId: 'ws_default',
  projectId: 'proj_default',
  task: {
    title: 'Fix auth regression',
    objective: 'Fix the failing auth regression tests',
    verificationPlan: ['pnpm test'],
    repoRoot: process.cwd()
  },
  budget: {
    maxUsd: 3.00,
    softLimitUsd: 2.25,
    maxIterations: 3,
    maxTokens: 20_000
  },
  adapter: createClaudeCliAdapter({ workingDirectory: process.cwd() })
})
```

---

## 🧠 Architecture

Five governance layers from policy to runtime enforcement.

```
┌──────────────────────────────────────────────────────────┐
│                   MartinLoop Governance Stack            │
├──────────────────────┬───────────────────────────────────┤
│  Autonomy Envelope   │  Surface · Path · Command         │
│  (policy-enforced)   │  Leash — pre-execution gate       │
├──────────────────────┼───────────────────────────────────┤
│  Model Router        │  Cost-aware adapter selection     │
│                      │  Fallback chain + model override  │
├──────────────────────┼───────────────────────────────────┤
│  Agent Adapters      │  Claude Code · Codex · any CLI   │
│                      │  Direct + stub adapters           │
├──────────────────────┼───────────────────────────────────┤
│  Safety Leash        │  Pre-execution verification gate  │
│                      │  Filesystem + secret + command    │
├──────────────────────┼───────────────────────────────────┤
│  Persistence         │  Per-run JSONL in ~/.martin/runs/ │
│                      │  Portfolio inspect + resume       │
└──────────────────────┴───────────────────────────────────┘
```

---

## 🛡️ What MartinLoop Enforces Today

**1. Hard budget cap.**
Every run has a `maxUsd` limit. When the cost reaches that limit the subprocess is terminated — not warned.

**2. Iteration cap.**
Every run has a `maxIterations` limit. The loop exits when it is hit, regardless of progress.

**3. Filesystem leash.**
If `allowedPaths` or `deniedPaths` are configured, any attempt that writes outside the envelope is blocked and rolled back before the patch is kept.

**4. Secret leash.**
Values that look like secrets (API keys, tokens) in the task objective or acceptance criteria are blocked before any attempt runs.

**5. Verifier gate.**
The loop only marks a run successful if the verifier command exits `0`. A passing verifier is required for a `completed` lifecycle state.

**6. Rollback on failure.**
When an attempt is discarded (failed verifier, safety violation, patch decision), MartinLoop restores the filesystem to the pre-attempt state using a git-backed snapshot.

**7. Run persistence.**
Every run is written to `~/.martin/runs/<workspaceId>.jsonl`. Use `martin resume` and `martin inspect` to read it back.

---

## 📦 OSS Packages

| Package | What It Does |
|---------|-------------|
| `martin-loop` | Self-contained facade — everything below, vendored and published |
| `@martin/core` | Runtime controller, leash, router, rollback, policy engine |
| `@martin/cli` | `martin run` · `inspect` · `resume` CLI commands |
| `@martin/adapters` | Claude Code, Codex CLI, direct-provider, stub adapters |
| `@martin/contracts` | Shared types: loop, policy, leash, budget, rollback |

All `@martin/*` packages are workspace-internal. Install `martin-loop` from npm — it bundles them all.

---

## 🔧 Development

**Requirements:** Node 20+ · pnpm 8+

```sh
# Clone and install
git clone https://github.com/Keesan12/MartinLoop
cd martin-loop && pnpm install

# Full test suite
pnpm test

# Type check all packages
pnpm -r lint

# Build all packages + public facade
pnpm build

# Publish (after build)
npm publish
```

---

## 🤝 Contributing

```sh
git checkout -b feat/your-feature

# Make changes, then:
pnpm -r lint && pnpm test   # must stay green

git commit -m "feat: describe what you built"
git push -u origin feat/your-feature
# Open a PR against main
```

Conventional commits: `feat:` · `fix:` · `chore:` · `docs:` · `refactor:` · `test:`

---

<div align="center">

**MIT Licensed** · [martinloop.com](https://martinloop.com) · [keesan@martinloop.com](mailto:keesan@martinloop.com)

*"AI coding accountability: completes good work · refuses bad work · stops uneconomical work."*

</div>
