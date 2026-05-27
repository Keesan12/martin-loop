<div align="center">

<img src="./docs/assets/martinloop-logo.png" alt="MartinLoop" width="260">

### Governed AI coding loops with budgets, verifier gates, rollback evidence, and receipts.

[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue?logo=apache)](./LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178c6?style=flat-square&logo=typescript&logoColor=white)](./tsconfig.base.json)
[![Node](https://img.shields.io/badge/node-%3E%3D20-3c873a?style=flat-square&logo=nodedotjs&logoColor=white)](#quick-start)
[![npm](https://img.shields.io/badge/npm-martin--loop-cc3534?style=flat-square&logo=npm&logoColor=white)](https://www.npmjs.com/package/martin-loop)

MartinLoop has been accepted into the NVIDIA Inception program.

<br>

**Your AI coding run estimated $2.40.**
**It kept retrying until the bill hit $65.**
<br>47 attempts. No hard stop. No rollback. No audit trail. Nothing merged.
<br><br>
MartinLoop makes that failure visible, bounded, and reviewable.
<br>

> AI coding agents are useful. Unbounded retry loops are not.
>
> MartinLoop wraps Claude Code, Codex, and custom agent runs with budget caps, policy checks, verifier gates, rollback evidence, and inspectable JSONL run records.
<br>
<img src="./docs/assets/cli-animated.svg" alt="MartinLoop CLI — governed agent run" width="720">

</div>

---

## The Problem

A typical autonomous coding loop keeps attempting work until tests pass. Without a governance layer, that loop can keep spending, mutate files outside the intended scope, lose track of why it failed, and leave teams without a clean audit trail.

Autonomous coding loops are powerful, but the usual pattern is attempt, check, retry, repeat, with no strong answer to:

- What changed?
- What did it cost?
- Why was it allowed?
- Why did it stop?
- Can we inspect or resume it later?

MartinLoop governs the failure mode.

---

## The Solution

MartinLoop wraps AI coding loops with a governance layer.

It does not try to replace the agent pattern. It makes that pattern safe to run.

### What MartinLoop Does Today

| Capability | Current behavior |
|---|---|
| Budget governance | Enforces `maxUsd`, `softLimitUsd`, `maxIterations`, and `maxTokens`; rejects attempts projected to exceed remaining budget and exits on budget or iteration exhaustion. Hard USD budget caps that stop work before the next attempt breaches policy. |
| Verifier gate | A run only reaches `completed` when the adapter result and verifier state pass. Unsafe verifier commands are blocked before agent execution. |
| Failure taxonomy | Classifies failures across 11 current classes, including hallucination, test regression, scope creep, repo grounding failure, environment mismatch, and budget pressure, that distinguishes real success from unsafe, invalid, or terminal behavior.|
| Safety leash | Evaluates verifier commands, file scope, dependency or migration changes that require approval, and secret-like values in task text. **Policy-as-code**. |
| Context integrity | Scans user prompts and tool output for injection patterns (authority inversion, instruction override, identity redefinition) before any attempt is admitted. Aborts with human escalation on detection. |
| Red-Blue Testing | Adversarial probe suite that runs before a patch is accepted. Six deterministic probes detect assertion deletion, silent reverts, context poisoning, budget self-reporting, and grounding evasion. Three risk tiers: `baseline`, `high_risk`, and `release_critical` (adds a Haiku model call). A single block-severity finding rejects the patch. |
| Rollback evidence | Captures rollback boundaries and restore outcomes for repo-backed attempts when a persistence store is configured. |
| Context distillation | Carries a distilled summary of recent attempts and remaining constraints into subsequent attempts. |
| Run records | The CLI appends JSONL loop records under `~/.martin/runs/<workspaceId>.jsonl`; lower-level stores can also persist contracts, ledgers, and attempt artifacts. |


The result is a runtime that can complete good work, refuse unsafe work, stop uneconomical work, and leave evidence behind.
---

## Ralph-Style Loops Need a Control Layer

The **Ralph Loop** is the failure mode where an AI coding agent keeps trying without knowing when it should stop.

The pattern is simple: attempt the task, run checks, retry on failure, repeat. The problem is not that the loop exists. The problem is that most implementations have no hard budget cap, no signed evidence layer, and no pre-execution control system. They know how to keep trying. They do **not** know when continuing is unsafe, uneconomical, or impossible.

MartinLoop solves the Ralph Loop problem by enforcing rules **before** damage happens:

- it stops the next attempt before budget overspend
- it classifies unsafe or invalid actions before execution
- it appends a structured JSONL audit record for every attempt
- it rolls back failed runs instead of leaving broken state behind
- it reduces runaway token growth with context distillation

If a Ralph-style loop has ever burned budget without producing a verified result, MartinLoop is designed to stop that failure mode before the next unsafe attempt runs.

<div align="center">
  <img src="./docs/assets/martin-ralph-loop.jpg" alt="Martin vs Ralph — governed vs ungoverned agent loop" width="240">
</div>

### How It Works — Five Layers

| Layer | What it does |
|---|---|
| **1. Task Contract** | Objective, verifier plan, repo root, allowed/denied paths, acceptance criteria, workspace, project, and budget. |
| **2. Policy & Budget** | Defaults from `martin.config.yaml`; CLI flags override. Budget preflight rejects attempts before execution. |
| **3. Agent Adapters** | Claude CLI, Codex CLI, direct-provider, and stub adapters normalize execution results into the core runtime contract. |
| **4. Safety & Verification** | Verifier commands, file scope, approval-boundary changes, secret-like values, and grounding determine whether work is kept. |
| **5. Persistence** | CLI writes JSONL records under `~/.martin/runs/`. Repo-backed runs can also persist contracts, ledgers, diffs, and rollback artifacts. |

---

## See It In Action

Same task, same starting state. MartinLoop completes in one verified attempt at `$2.30`. The uncontrolled loop retries four times, spends `$5.20`, and fails with no audit trail.

Martin Loop matters because it turns AI coding from an opaque experiment into something that can be governed, replayed, verified, and trusted.

<div align="center">
  <img src="./docs/assets/side-by-side.svg" alt="Martin vs Ralph — governed vs ungoverned agent loop side-by-side benchmark comparison" width="720" height="1080">
</div>


Try the packaged demo locally:

```sh
npx martin-loop demo
cd martin-loop-demo
npm install
MARTIN_LIVE=false npx martin-loop run "Summarize the demo workspace and confirm the verifier is green" --verify "npm test"
```

Challenge page: [Can your AI coding agent finish this task under $3?](./docs/distribution/UNDER-3-CHALLENGE.md)

If the problem is familiar, star the repo so other builders can find the runtime before their next unbounded agent loop.

---

## Feedback

If you try MartinLoop, I would value blunt feedback on where a control layer should sit in a real workflow: local CLI wrapper, MCP boundary, CI gate, or somewhere else.

- Join the current feedback thread: [Where would a control layer actually fit in your AI coding workflow?](https://github.com/Keesan12/martin-loop/discussions/65)
- Open a bug, feature request, or workflow feedback issue: [GitHub issues](https://github.com/Keesan12/martin-loop/issues)
- Want to help more builders find it? A GitHub star still helps a lot at this stage.

---

## Quick Start

```sh
npm install -g martin-loop
```

This installs the public `martin-loop` CLI package. This README is synced for `martin-loop@0.2.6`.

Want a safe sandbox first? Run `npx martin-loop demo` and MartinLoop will copy a disposable local workspace into `./martin-loop-demo`.

### Three-Minute First Value

Start with the local readiness check:

```sh
npx martin-loop doctor
```

Then run the no-spend proof path:

```sh
npx martin-loop demo
cd martin-loop-demo
npm install
MARTIN_LIVE=false npx martin-loop run "Summarize the demo workspace and confirm the verifier is green" --verify "npm test"
npx martin-loop dossier --latest
```

`dossier --latest` gives you the receipt-style follow-up and Context Diet packet: what happened, a compact proof card, budget status, verifier evidence, rollback or artifact evidence, directional token and cost totals, and the next safe action.

When you want to decide which saved run needs attention first, use triage:

```sh
npx martin-loop triage
```

`triage` ranks persisted runs using failure categories such as failed verification, budget exits, human escalation, and missing verification evidence. If a saved run entry is unreadable, MartinLoop skips it and surfaces a warning instead of aborting the whole review.

### What's New In 0.2.6

`martin-loop@0.2.6` closes the public root-package remediation slice while keeping the standalone MCP package on the stable `0.2.5` line.

- hardened verifier blocking for destructive command bypass families and high-signal secret patterns
- broader context-integrity scanning across task metadata and verifier output before those channels re-enter the loop
- model-aware budget pricing, grounding cache invalidation, and safer local `martin_run` abuse controls
- release-proof updates across README, release notes, workflow checks, and package metadata

See [OSS-0.2.6 release notes](./docs/release/OSS-0.2.6-RELEASE-NOTES.md) and [MCP 0.2.5 release notes](./docs/release/MCP-0.2.5-RELEASE-NOTES.md) for the public feature contract.

### Public Package Surface

The public package surface is:

- Install target: `npm install martin-loop`
- CLI target: `npx martin-loop`
- SDK target: `import { MartinLoop } from "martin-loop"`
- MCP target: `npx -y @martinloop/mcp`

`martin-loop` and `@martinloop/mcp` are published separately. The root package is for CLI and SDK use; the MCP package is for MCP hosts.

### MCP server

`@martinloop/mcp@0.2.5` exposes eleven stdio tools plus read-only resources, resource templates, and prompts. `martin_run` remains the only tool that can execute work; the cockpit tools are review helpers for triage, recent runs, compact proof receipts, dossiers, attempts, and verifier results.

Recommended first-use flow:

1. `martin_doctor`
2. `martin_preflight`
3. `martin_run`
4. `martin_triage_runs`
5. `martin://agent/next-step` or `martin://runs/latest/summary`
6. `martin_run_dossier`, `martin_inspect`, or `martin_status`

### MCP install

Use the published MCP package directly:

- Codex: `codex mcp add martin-loop -- npx -y @martinloop/mcp`
- Claude Code macOS/Linux: `claude mcp add --transport stdio --scope user martin-loop -- npx -y @martinloop/mcp`
- Claude Code Windows PowerShell/cmd: `claude mcp add --transport stdio --scope user martin-loop -- cmd /c npx -y @martinloop/mcp`

When you want a host-specific config block instead of the default full server install, generate one from the published CLI:

- Codex starter profile: `npx martin-loop mcp print-config --host codex --profile starter`
- Claude full profile: `npx martin-loop mcp print-config --host claude --profile full`
- Gemini starter profile: `npx martin-loop mcp print-config --host gemini --profile starter`
- Generic stdio profile: `npx martin-loop mcp print-config --host generic --transport stdio --profile starter`

Profile guide:

- `starter` is the default generated profile: `martin_doctor`, `martin_preflight`, `martin_run`, `martin_triage_runs`, and `martin_run_dossier`
- `full` adds the deeper inspection tools: `martin_inspect`, `martin_status`, `martin_list_runs`, `martin_get_run`, `martin_get_attempt`, and `martin_get_verification_results`
- both generated profiles include `martin_run`, because the current public CLI only emits execution-capable profile blocks
- if you need a strict read-only allow-list, start from the manual config example in `packages/mcp/README.md` or `docs/oss/MCP-FOR-AI-AGENTS.md` and omit `martin_run`

If you just want to launch the server manually, the one-line command is:

```sh
npx -y @martinloop/mcp
```

For standalone package validation, keep these proof gates green:

```sh
pnpm --filter @martinloop/mcp smoke:published:pack
pnpm --filter @martinloop/mcp verify:release
```

The standalone server identifier is `io.github.Keesan12/martin-loop`.

### Run a governed task

```sh
npx martin-loop run "fix the auth regression" \
  --budget 3.00 \
  --verify "pnpm test"
```

You can also pass the objective explicitly:

```sh
npx martin-loop run --objective "fix the auth regression" --budget 3.00 --verify "pnpm test"
```

For a no-spend repo-local dry run, use the stub adapter:

```powershell
$env:MARTIN_LIVE='false'
npx martin-loop run --objective "Summarize the current runtime state" --verify "pnpm --filter @martin/core test"
Remove-Item Env:MARTIN_LIVE
```

### Inspect, triage, or resume runs

```sh
npx martin-loop triage
```

Use `triage` first when you want the fastest evidence-first ranking of persisted runs.

```sh
npx martin-loop inspect --file ~/.martin/runs/<workspaceId>.jsonl
npx martin-loop resume <loopId>
```

`inspect` prints a portfolio summary for records in the file. `resume` looks up a persisted loop record by ID under `~/.martin/runs/`.

For the richer operator view, use:

```sh
npx martin-loop dossier --latest
```

For host setup flows, the CLI also exposes:

```sh
npx martin-loop mcp print-config --host codex|claude|gemini|generic --transport stdio|remote --profile starter|full
npx martin-loop mcp install --host codex|claude|gemini|generic --scope user|project [--dry-run]
```

---

## CLI

```text
martin-loop run <objective> [options]
martin-loop doctor
martin-loop dossier (--latest | --loop-id <id> | --file <path>)

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

The public CLI includes `doctor`, `demo`, `triage`, `dossier`, `inspect`, and `resume`. `triage` is the fastest way to rank persisted runs by urgency, while `dossier` is the fastest way to review one run with receipt-style evidence and emit a compact Context Diet handoff packet. `inspect` and `resume` remain useful compatibility views.

<div align="center">
  <img src="./docs/assets/cli-static.svg" alt="MartinLoop CLI terminal output" width="720">
</div>

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

## Package Map

| Package or app | Role |
|---|---|
| `martin-loop` | Root public npm facade that vendors the runtime, CLI, adapters, and contracts into `dist/`. |
| `@martin/contracts` | Shared types for loops, policy, governance, budget, telemetry, and rollback. |
| `@martin/core` | Runtime controller, policy engine, safety leash, grounding, persistence, and rollback logic. |
| `@martin/adapters` | Claude CLI, Codex CLI, direct-provider, and stub adapter surfaces. |
| `@martin/cli` | CLI implementation for `run`, `demo`, `inspect`, and `resume`. |
| `@martinloop/mcp` | MCP server with governed execution plus read-only run review tools. |

Users install the root `martin-loop` package for the CLI and SDK, or the standalone `@martinloop/mcp` package for MCP hosts.

---
## Development

Requirements:

- Node 20+
- pnpm 10.x

```bash
git clone https://github.com/Keesan12/martin-loop.git
cd martin-loop
pnpm install

pnpm test
pnpm lint
pnpm build

```

Current RC gate commands:

```sh
pnpm oss:validate
pnpm public:smoke
pnpm rc:validate
pnpm --filter @martinloop/mcp smoke:published:pack
pnpm --filter @martinloop/mcp verify:release
```

> **Caution:** This package is live on npm. Public releases should use the guarded GitHub Actions release workflow, with versioning and public copy verified before publishing.

Helpful docs:

- [OSS quickstart](./docs/oss/QUICKSTART.md)
- [Agent Start Here](./docs/oss/AGENT-START-HERE.md)
- [OSS examples](./docs/oss/EXAMPLES.md)
- [Under-$3 benchmark challenge](./docs/distribution/UNDER-3-CHALLENGE.md)
- [Directory submission pack](./docs/distribution/DIRECTORY-SUBMISSIONS.md)
- [Integration outreach pack](./docs/distribution/INTEGRATION-OUTREACH.md)
- [Claude Code walkthrough](./docs/oss/CLAUDE-CODE-WALKTHROUGH.md)
- [Ralph-style loop safety guide](./docs/oss/RALPH-LOOP-SAFETY.md)
- [OSS surface overview](./docs/oss/README.md)

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

**⭐Give the repo a star⭐** if you think AI coding needs budgets, brakes, and receipts.

**APACHE 2.0 Licensed** · [martinloop.com](https://martinloop.com) · [keesan@martinloop.com](mailto:support@martinloop.com)

*"AI coding accountability: completes good work, refuses unsafe work, stops uneconomical work."*

</div>

<div align="center">
  <br>
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/Keesan12/martin-loop/main/docs/assets/nvidia-inception-program.png">
    <img src="https://raw.githubusercontent.com/Keesan12/martin-loop/main/docs/assets/nvidia-inception-program-light.png" alt="NVIDIA Inception Program logo" width="280">
  </picture>
  <br>
</div>
