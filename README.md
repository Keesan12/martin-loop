<div align="center">

<!-- <img src="docs/assets/martinloop_logo_1.png" alt="MartinLoop" width="200"> -->

# MartinLoop

⭐**The control plane for autonomous AI coding agents.**⭐

Martin Loop is a governed runtime for AI coding loops. It lets teams run AI coding agents with hard budget caps, pre-execution safety checks, signed audit trails, rollback protection, and policy-as-code enforcement.

AI coding tools are getting more capable, but most still operate like unchecked loops: they keep trying, keep spending, and keep mutating files until something passes or the user intervenes. Martin Loop exists to make that behavior accountable, bounded, and production-safe.

## The Problem

> <br> ****"Your CFO is like what do you mean each engineer now costs $2000 extra per month in LLM bills"**** - Dax Raad

⛔ AI coding agents are useful, but the default loop is unsafe.

A typical autonomous coding loop keeps attempting work until tests pass. In practice, that creates a recurring failure mode Martin Loop calls the **Ralph Loop**: an agent keeps retrying without a hard budget cap, without a tamper-evident audit record, and without pre-execution governance over what it is about to do. 


That creates five serious problems:

- **No hard budget stop** — the loop can keep spending after it becomes uneconomical.
- **No real failure taxonomy** — most tools only know pass/fail, not whether the task is recoverable, terminal, unsafe, or hallucinated. 
- **No cryptographic audit trail** — teams cannot prove what changed, what was attempted, or why the loop stopped.
- **No pre-execution safety gate** — dangerous operations may run before governance sees them. 
- **No context efficiency** — uncontrolled loops re-read more and more context each iteration, which drives quadratic token growth and hidden spend.

In other words: AI coding is moving into production, but most teams still lack the layer that controls cost, safety, evidence, and operational discipline.

## The Solution

✅ Martin Loop wraps AI coding loops with a governance layer.

It does not try to replace the agent pattern. It makes that pattern safe to run. Martin Loop adds:

- **Hard USD budget caps** that stop work before the next attempt breaches policy. 
- A **14-class verification leash** that distinguishes real success from unsafe, invalid, or terminal behavior. 
- **Ed25519-signed audit records** for every attempt, creating a tamper-evident execution trail. 
- **Policy-as-code** via `martin.policy.yaml`, so teams can version and enforce runtime rules in-repo. 
- **Filesystem rollback** on failed runs, so bad attempts do not leave half-finished damage behind. 
- **Delta re-prompting** so each retry sends only changed state instead of re-reading the entire loop history.

The result is a governed runtime that can complete good work, refuse bad work, stop uneconomical work, and leave evidence behind.

## 🛡️ What MartinLoop Enforces Today

Martin Loop gives engineering teams a control layer around AI coding agents

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


## The Ralph Loop, explained

**"Everybody has gotten infatuated with what we call these Ralph Wiggum loops, just like send the thing off and it'll just go figure something out..A, It never figures anything out. And B, you just get this ginormous bill...**" - Chamath Palihapitiya, All-In Podcast #263, March 2026

The **Ralph Loop** is the failure mode where an AI coding agent keeps trying without knowing when it should stop.

The pattern is simple: attempt the task, run checks, retry on failure, repeat. The problem is not that the loop exists. The problem is that most implementations have no hard budget cap, no signed evidence layer, and no pre-execution control system. They know how to keep trying. They do **not** know when continuing is unsafe, uneconomical, or impossible. :contentReference[oaicite:20]{index=20} :contentReference[oaicite:21]{index=21}

Martin Loop solves the Ralph Loop by enforcing rules **before** damage happens:

- it stops the next attempt before budget overspend
- it classifies unsafe or invalid actions before execution
- it records each attempt with cryptographic proof 
- it rolls back failed runs instead of leaving broken state behind 
- it reduces runaway token growth with delta re-prompting 

Ralph is an uncontrolled loop.  
Martin Loop is the governed runtime around that loop. 

## Why it matters

AI agents are already touching real repositories, real budgets, and real engineering workflows. But “faster” is not enough if teams cannot answer basic operational questions:

- What changed?
- What did it cost?
- Why was it allowed?
- Why did it stop?
- Can we prove any of it?

Martin Loop matters because it turns AI coding from an opaque experiment into something that can be governed, replayed, verified, and trusted.

On the public benchmark described in the technical whitepaper, Martin Loop achieved an **80% verifier pass rate at $11.90 per 10 tasks**, versus **40% at $30.70** for the Ralph baseline. The same materials also report **417 passing tests**, **63/63 adversarial gate checks**, and **zero false positives** on the declared safety checks.

That is the point of Martin Loop: not just more agent activity, but better governed outcomes.

P.S. — If Ralph ever burned $30.70 on your dime, you're in the right place. Martin stopped him at $4.97 with a full audit trail. LFG! 🚀 Finally a Martin Prince leash for Ralph Wiggums! :) 






## Get started

Clone the repo, install dependencies, and run the public benchmark to reproduce the benchmark claims from the paper. The whitepaper states the benchmark is reproducible with `bun run benchmark`. 


</div>

---

## ⚡ Quick Start

## Release Surface

The frozen public package surface for this RC is:

```sh
npm install martin-loop
npx martin-loop
```

```typescript
import { MartinLoop } from "martin-loop"
```

Phase 13 RC gate commands:

```sh
pnpm oss:validate
pnpm public:smoke
pnpm repo:smoke
pnpm rc:validate
pnpm pilot:prep:validate
pnpm release:matrix:local
```

Registry publication is intentionally held for a later release step; this repository can validate the package surface locally before publishing.

---

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

## Support the project

**give the repo a star** If you think AI coding needs budgets, brakes, and receipts.

A GitHub star helps more engineers discover Martin Loop, validate the category, and push governed AI coding forward.

### The agentic AI governance runtime. Hard enforcement, not suggestions.

[![License: MIT](https://img.shields.io/badge/license-MIT-7c3aed?style=flat-square)](./LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178c6?style=flat-square&logo=typescript&logoColor=white)](./tsconfig.json)
[![Node](https://img.shields.io/badge/node-%3E%3D20-3c873a?style=flat-square&logo=nodedotjs&logoColor=white)](#quick-start)
[![npm](https://img.shields.io/badge/npm-martin--loop-cc3534?style=flat-square&logo=npm&logoColor=white)](https://npmjs.com/package/martin-loop)

<br>

> **Your overnight AI pipeline estimated $2.40.**
> **You woke up to a $65 cursor bill.**
>
> 47 retries. No hard stop. No rollback. No audit trail. Nothing merged. 
> <br> **MartinLoop exists so that never happens again.** 


**MIT Licensed** · [martinloop.com](https://martinloop.com) · [keesan@martinloop.com](mailto:keesan@martinloop.com)

*"AI coding accountability: completes good work · refuses bad work · stops uneconomical work."*

</div>
