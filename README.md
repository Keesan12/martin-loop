# MartinLoop

<div align="center">

<img src="./docs/assets/martinloop-logo.png" alt="MartinLoop" width="260">

**The open-source control plane for AI coding agents.**

[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue?style=flat-square&logo=apache)](./LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178c6?style=flat-square&logo=typescript&logoColor=white)](./tsconfig.base.json)
[![Node](https://img.shields.io/badge/node-%3E%3D20-3c873a?style=flat-square&logo=nodedotjs&logoColor=white)](#quick-start)
[![npm version](https://img.shields.io/npm/v/martin-loop?style=flat-square&logo=npm&logoColor=white)](https://www.npmjs.com/package/martin-loop)
[![npm downloads](https://img.shields.io/npm/dm/martin-loop?style=flat-square&label=downloads)](https://www.npmjs.com/package/martin-loop)

MartinLoop wraps Claude Code, Codex, and custom coding agents with budget caps, verifier gates, rollback evidence, policy checks, and auditable run records.

</div>

---

## Why MartinLoop

Your AI coding run estimated `$2.40`. It kept retrying until the bill hit `$65`: 47 attempts, no hard stop, no rollback, no audit trail, and nothing clean to merge.

AI coding agents are powerful, but unbounded retry loops are dangerous. A task can keep spending tokens, editing files, and trying again without a clear answer to:

- What changed?
- What did it cost?
- Why did it continue?
- Why did it stop?
- Did it actually pass verification?

MartinLoop gives each run a contract: budget, scope, verifier, policy, and receipt. Use it when AI coding work needs to be bounded, inspectable, and safe to review before it becomes expensive or destructive.

## Quick Start

Try MartinLoop in a disposable demo workspace:

```sh
npx martin-loop demo
cd martin-loop-demo
npm install
MARTIN_LIVE=false npx martin-loop run "Summarize the demo workspace and confirm the verifier is green" --verify "npm test"
npx martin-loop dossier --latest
```

For a global install:

```sh
npm install -g martin-loop
npx martin-loop doctor
```

`dossier --latest` prints a receipt-style summary: what happened, verifier evidence, budget status, rollback or artifact evidence, and the next safe action.

## Visual Proof

MartinLoop turns an AI coding run into an inspectable execution record: budget used, verifier result, changed files, rollback evidence, and final receipt.

<div align="center">
  <img src="./docs/assets/cli-animated.svg" alt="MartinLoop CLI showing a governed agent run" width="720">
</div>

Ungoverned agents can retry until cost and scope drift. MartinLoop adds budget caps, verifier gates, and audit evidence so the run has a clear stop condition.

<div align="center">
  <img src="./docs/assets/side-by-side.svg" alt="MartinLoop governed run compared with an unbounded retry loop" width="720" height="1080">
</div>

## What It Does

- **Budget caps** stop the next attempt before a configured USD, token, or iteration limit is exceeded.
- **Verifier gates** require a real check, such as `npm test`, before a run can count as complete.
- **Policy checks** block unsafe verifier commands, risky path changes, and secret-like task inputs before execution.
- **Rollback evidence** records restore boundaries and outcomes for repo-backed attempts.
- **Run records** append structured JSONL evidence under `~/.martin/runs/`.
- **Failure classification** separates completed work from budget exits, verifier failures, grounding issues, unsafe actions, and human escalation.
- **MCP integration** exposes one governed execution entrypoint plus read-only tools, resources, and prompts for inspecting runs.

## How It Works

MartinLoop sits around the coding agent instead of replacing it:

| Layer | Purpose |
|---|---|
| Task contract | Objective, verifier plan, repo root, allowed paths, denied paths, acceptance criteria, workspace, project, and budget. |
| Policy and budget | Defaults from `martin.config.yaml`; CLI flags override. Budget preflight blocks attempts that would exceed policy. |
| Agent adapters | Claude CLI, Codex CLI, direct-provider, and stub adapters normalize execution results. |
| Safety and verification | Scope checks, verifier command checks, prompt/context integrity, and grounding decide whether work can continue. |
| Persistence | JSONL run records, evidence summaries, and repo-backed artifacts make each run inspectable later. |

## See It In Action

In the public demo comparison, the governed MartinLoop run completes in one verified attempt at `$2.30`. The uncontrolled retry loop spends `$5.20`, retries four times, and fails without a comparable audit trail.

The point is not that every governed run is always cheaper. The point is that the run becomes inspectable and enforceable: budget policy, verifier success, stop reason, and evidence are explicit.

Read the challenge page: [Can your AI coding agent finish this task under $3?](./docs/concepts/under-3-challenge.md)

## Ralph-Style Loops

A Ralph-style loop is the failure mode where an AI coding agent keeps trying without knowing when continuing is unsafe, uneconomical, or unlikely to succeed.

MartinLoop keeps the useful part of the loop, then adds brakes:

- stop before budget overspend
- classify unsafe or invalid actions before execution
- write an audit record for every attempt
- preserve rollback evidence when repo-backed runs are configured
- reduce runaway context growth with compact run summaries

## CLI

```text
martin-loop run <objective> [options]
martin-loop doctor
martin-loop demo
martin-loop triage
martin-loop dossier (--latest | --loop-id <id> | --file <path>)
```

Common options:

```text
--budget <n>            Hard cost cap in USD
--soft-limit-usd <n>    Soft budget threshold in USD
--verify <cmd>          Verifier command after each attempt
--max-iterations <n>    Maximum number of attempts
--max-tokens <n>        Maximum token budget
--engine <name>         Adapter to use: claude or codex
--cwd <path>            Repo root for the run
--allow-path <glob>     Restrict writes to this path pattern; repeatable
--deny-path <glob>      Block this path pattern; repeatable
--accept <criterion>    Add an acceptance criterion; repeatable
```

More detail: [CLI reference](./docs/reference/cli.md) and [configuration reference](./docs/reference/config.md).

<div align="center">
  <img src="./docs/assets/cli-static.svg" alt="MartinLoop CLI terminal output" width="720">
</div>

## MCP

Run the MCP server directly:

```sh
npx -y @martinloop/mcp
```

Install it in common hosts:

```sh
codex mcp add martin-loop -- npx -y @martinloop/mcp
claude mcp add --transport stdio --scope user martin-loop -- npx -y @martinloop/mcp
```

Generate host config from the CLI:

```sh
npx martin-loop mcp print-config --host codex --transport stdio --profile starter
npx martin-loop mcp print-config --host claude --transport stdio --profile full
npx martin-loop mcp print-config --host gemini --transport stdio --profile starter
```

The MCP package exposes one execution tool, `martin_run`, and read-only inspection tools for status, triage, run records, attempts, verifier results, and dossiers.

More detail: [MCP setup](./docs/getting-started/mcp.md), [MCP tool reference](./docs/reference/mcp-tools.md), and [MCP compatibility](./docs/reference/mcp-compatibility.md).

## SDK

```sh
npm install martin-loop
```

```typescript
import { MartinLoop, createClaudeCliAdapter } from "martin-loop";

const loop = new MartinLoop({
  adapter: createClaudeCliAdapter({ workingDirectory: process.cwd() }),
  defaults: {
    workspaceId: "my-workspace",
    projectId: "my-project",
    budget: {
      maxUsd: 3.0,
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

More detail: [SDK reference](./docs/reference/sdk.md) and [package map](./docs/reference/packages.md).

## Examples

- [Quickstart](./docs/getting-started/quickstart.md)
- [Examples](./docs/getting-started/examples.md)
- [Claude Code walkthrough](./docs/getting-started/claude-code.md)
- [Codex setup](./docs/getting-started/codex.md)
- [MCP setup](./docs/getting-started/mcp.md)
- [GitHub Actions budget gate](./examples/github-actions-budget-gate/)
- [OpenCode-style adapter](./examples/opencode-adapter/)

## Development

Requirements:

- Node.js 20+
- pnpm 10.x

```sh
git clone https://github.com/Keesan12/martin-loop.git
cd martin-loop
pnpm install --frozen-lockfile
pnpm test
pnpm lint
pnpm build
```

## Contributing

Issues, bug reports, workflow feedback, and focused pull requests are welcome. Public-facing docs should be concise, user-centered, and accurate.

```sh
git checkout -b feat/your-feature
pnpm lint
pnpm test
git commit -m "feat: describe what you built"
git push -u origin feat/your-feature
```

Conventional commit prefixes: `feat:`, `fix:`, `chore:`, `docs:`, `refactor:`, and `test:`.

## License

Apache-2.0. See [LICENSE](./LICENSE).

<div align="center">

**Star the repo** if you think AI coding needs budgets, brakes, and receipts.

[martinloop.com](https://martinloop.com) · [support@martinloop.com](mailto:support@martinloop.com)

<br>
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/Keesan12/martin-loop/main/docs/assets/nvidia-inception-program.png">
  <img src="https://raw.githubusercontent.com/Keesan12/martin-loop/main/docs/assets/nvidia-inception-program-light.png" alt="NVIDIA Inception Program logo" width="280">
</picture>

</div>
