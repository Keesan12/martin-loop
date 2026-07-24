# MartinLoop

<div align="center">
  <img src="./docs/assets/martinloop-logo.png" alt="MartinLoop" width="260">

  **Make AI coding agents safe to run. Safe to spend.**

  **MartinLoop gives AI coding agents budgets, stop conditions, rollback rules, and receipts.**

  Built from thousands of agent runs where the problem was not intelligence -- it was uncontrolled execution.

  MartinLoop is the open-source governance runtime for Claude Code, Codex, Gemini CLI, Cursor, and autonomous coding agents. It puts a hard contract around every run: what the agent may change, how much it may spend, what must pass, when it must stop, and what evidence must remain.

  **Get started:** `npx -y martin-loop@latest start`  
  **Try the demo:** `npx -y martin-loop@latest demo`  
  **Connect the MCP:** `npx -y @martinloop/mcp`

  [![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue?style=flat-square&logo=apache)](./LICENSE)
  [![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178c6?style=flat-square&logo=typescript&logoColor=white)](./tsconfig.base.json)
  [![Node](https://img.shields.io/badge/node-%3E%3D20-3c873a?style=flat-square&logo=nodedotjs&logoColor=white)](#quick-start)
  [![npm version](https://img.shields.io/npm/v/martin-loop?style=flat-square&logo=npm&logoColor=white)](https://www.npmjs.com/package/martin-loop)
  [![npm downloads](https://img.shields.io/npm/dm/martin-loop?style=flat-square&label=downloads)](https://www.npmjs.com/package/martin-loop)
  [![martin-loop MCP server](https://glama.ai/mcp/servers/Keesan12/martin-loop/badges/score.svg)](https://glama.ai/mcp/servers/Keesan12/martin-loop)

  MartinLoop is part of the NVIDIA Inception program.
  <br>
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="./docs/assets/nvidia-inception-program.png">
    <img src="./docs/assets/nvidia-inception-program-light.png" alt="NVIDIA Inception Program logo" width="280">
  </picture>
</div>

## Why MartinLoop

AI coding agents can create output. The hard part is trusting that output enough to become real software work.

A task that looks like a small fix can become repeated attempts, growing context, unexpected token spend, unsafe file changes, and a confident “done” message that has not passed the verifier. MartinLoop is not another coding agent. It is the independent enforcement layer around the agents you already use.

| Without MartinLoop | With MartinLoop |
| --- | --- |
| The agent decides when to stop | USD, token, iteration, time, command, and file-change limits |
| “Looks fixed” counts as success | Your verifier must actually pass |
| Scope can drift silently | Allowed and denied path contracts |
| Retry loops keep spending | Hard stop conditions and durable operator controls |
| Review starts from a chat summary | Inspectable run dossier, receipt, cost, verification, and artifact evidence |
| Failure destroys context | Failure classification and next-safe-action guidance |

Use it when AI coding work needs to stay bounded, inspectable, reversible, and safe to review before it becomes expensive or destructive.

## Why Teams Adopt MartinLoop

- **Engineers** get a governed run instead of an open-ended agent session.
- **Reviewers** get verification evidence, changed-file context, attempts, costs, and trust boundaries.
- **Platform teams** get one policy surface across Claude Code, Codex, Gemini CLI, and other MCP-capable hosts.
- **FinOps and engineering leaders** can tie agent spend to a task, outcome, and receipt instead of an unexplained token bill.
- **Agents** get explicit next steps, machine-readable resources, and a workflow that blocks execution until required checks exist.

Teams use MartinLoop when they need governed agent execution that can be reviewed and trusted.

## 2-Minute Install Path

```sh
npx -y martin-loop@latest start
npx -y martin-loop@latest demo
cd martin-loop-demo
npm install
npx -y martin-loop@latest run "Summarize the demo workspace and prove tests still pass" --verify "npm test" --budget-usd 2 --max-iterations 1
```

The run will not be treated as complete unless the verifier passes. MartinLoop records the budget posture, attempts, stop reason, verification state, and evidence boundary.

## Quick Start

Try MartinLoop in a disposable demo workspace:

```sh
npx -y martin-loop@latest start
npx -y martin-loop@latest demo
npx -y martin-loop@latest --version
cd martin-loop-demo
npm install
npx -y martin-loop@latest run "Summarize the demo workspace and prove tests still pass" --verify "npm test" --budget-usd 2 --max-iterations 1
npx -y martin-loop@latest dossier --latest
npx -y martin-loop@latest share --latest
```

Optional global install:

```sh
npm install -g martin-loop
martin-loop --version
```

If this flow is useful, open an issue with feedback so we can keep improving the public experience.

`start` prints the first-run guided path. `run` auto-checks `doctor`, `session-start`, and `preflight`, then executes when the environment is ready.

Inspect-first flow:

```sh
npx -y martin-loop@latest doctor
npx -y martin-loop@latest session-start
npx -y martin-loop@latest preflight "Summarize the demo workspace and prove tests still pass" --verify "npm test"
```

`share --latest` writes `run-receipt.json` and `run-receipt.md` into the selected run directory under `share/`. Proof-card images are opt-in with `--with-proof-card` or `--proof-card-format`.

Release notes for the current root package: [MartinLoop 0.4.5](./docs/release/OSS-0.4.5-RELEASE-NOTES.md).

## Visual Proof

MartinLoop turns an AI coding run into an inspectable execution record: budget used, verifier result, changed files, rollback evidence, and final receipt.

<div align="center">
  <img src="./docs/assets/cli-animated.svg" alt="MartinLoop CLI showing a governed agent run" width="720">
</div>

Ungoverned agents can retry until cost and scope drift. MartinLoop adds budget caps, verifier gates, and audit evidence so the run has a clear stop condition.

<div align="center">
  <img src="./docs/assets/side-by-side.svg" alt="MartinLoop governed run compared with an unbounded retry loop" width="720" height="1080">
</div>

### Proof Receipts

Proof receipts are local share bundles for governed AI coding runs. They show the task, spend, budget, verifier result, receipt integrity, and any evidence boundary that should not be rounded into confidence.

This real governed run spent `$0.51` against a `$3.00` budget. The verifier passed and the receipt integrity was signed, but the proof stayed at `EVIDENCE_BOUNDARY` because rollback evidence was not recorded.

<div align="center">
  <img src="./docs/assets/proof-receipt-live-governed.png" alt="MartinLoop CLI proof receipt for a governed run with spend, budget, verifier, integrity, and evidence boundary" width="720">
</div>

Generate your own receipt:

```sh
npx -y martin-loop@latest run "Summarize the demo workspace and prove tests still pass" --verify "npm test"
npx -y martin-loop@latest runs verify --latest
npx -y martin-loop@latest share --latest
```

Example receipt files: [Markdown](./docs/examples/proof-receipts/live-governed-run-receipt.md) and [JSON](./docs/examples/proof-receipts/live-governed-run-receipt.json).

## See It In Action

The point is not that every governed run is always cheaper. The point is that every run becomes inspectable and enforceable: budget policy, verifier result, stop reason, and evidence are explicit.

Run the public benchmark suites:

```sh
npx martin-loop bench --suite under-3-challenge
npx martin-loop bench --suite ralphy-engineering-50
```

Run a deterministic public audit from a clean directory:

```sh
npx -y martin-loop@latest --version
npx -y martin-loop@latest start
npx -y martin-loop@latest demo
cd martin-loop-demo
npm install
npx -y martin-loop@latest run "Summarize the demo workspace and prove tests still pass" --verify "npm test" --budget-usd 2 --max-iterations 1 --json
npx -y martin-loop@latest dossier --latest --json
npx -y martin-loop@latest share --latest --json
```

## Ralph-Style Loops

A Ralph-style loop is the failure mode where an AI coding agent keeps trying without knowing when continuing is unsafe, uneconomical, or unlikely to succeed.

MartinLoop keeps the useful part of iterative agent work, then adds brakes:

- stop before budget overspend
- block execution when required preflight evidence is missing
- classify unsafe, invalid, or unproductive attempts
- preserve rollback and verifier evidence for review
- reduce runaway context growth with compact run summaries
- produce a durable record of why the run stopped

## Failure Taxonomy (13 Runtime Classes)

Public governed runs use one canonical taxonomy: the 13 runtime `FailureClass` values from `@martin/contracts`.

See the canonical table: [Failure Taxonomy (13 Runtime Classes)](./docs/oss/FAILURE-TAXONOMY-13.md).

## What It Does

- **Hard budgets:** stop before configured USD, token, iteration, time, command, or file-change limits are exceeded.
- **Verifier gates:** require a real command such as `npm test` to exit successfully before completion.
- **Scope contracts:** constrain work with allowed and denied paths.
- **Preflight enforcement:** block execution until environment, task, budget, and verifier inputs are valid.
- **Operator controls:** durable pause, continue, and cancel receipts instead of silent process control.
- **Failure triage:** classify runtime failures and identify the next safe action.
- **Run dossiers:** collect attempts, spend, verifier evidence, artifacts, and trust boundaries in one reviewable record.
- **Shareable receipts:** export redacted JSON and Markdown summaries for handoff or PR review.
- **MCP integration:** expose planning, execution, inspection, review, resources, and prompts to MCP-capable agents.

## How It Works

```text
objective
   ↓
doctor → estimate → plan → preflight
   ↓
governed execution
   ├─ budget gate
   ├─ scope gate
   ├─ policy gate
   └─ verifier gate
   ↓
dossier → evaluation → receipt → PR review
```

| Layer | Purpose |
| --- | --- |
| Task contract | Objective, verifier plan, repo root, allowed paths, denied paths, acceptance criteria, workspace, project, and budget. |
| Policy and budget | Defaults come from `martin.config.yaml`; CLI flags can override them. Budget preflight blocks attempts that would exceed policy. |
| Agent adapters | Claude CLI, Codex CLI, Gemini CLI, direct-provider, and verifier-only adapters normalize execution results. |
| Safety and verification | Scope checks, verifier command checks, prompt integrity, grounding, and verification decide whether work can continue. |
| Persistence | Run records, evidence summaries, and repo-backed artifacts make every run inspectable later. Integrity checks expose `verified`, `tamper_detected`, or `unsigned` states. |

### Trust Boundaries

- Cost and token outputs include provenance: `actual`, `estimated`, or `unavailable`.
- A passed verifier does not prove every product requirement; it proves the configured verification commands passed.
- Receipt integrity must be `verified` before a run is treated as trustworthy evidence for external review.
- Unknown, missing, contradicted, or failed verification is never rounded into success.

## CLI

```text
martin-loop doctor
martin-loop demo
martin-loop session-start [--host <claude|codex|gemini|generic>]
martin-loop phase status|contract|session-start|preflight|run [--execute]
martin-loop preflight <objective> [options]
martin-loop run <objective> [options]
martin-loop bench --suite <suiteId>
martin-loop triage
martin-loop dossier (--latest | --loop-id <id> | --file <path>)
martin-loop runs list|get|attempt|verify ...
martin-loop mcp print-config --host <codex|claude|gemini|generic>
martin-loop mcp install --host <codex|claude|gemini|generic>
martin-loop challenge [--loop-id <id> | --file <path> | --latest]
martin-loop share (--loop-id <id> | --file <path> | --latest) [--out-dir <path>]
martin-loop badge [--format svg|json] [--runs-dir <path>]
```

Common options:

```text
--budget <n>            Hard cost cap in USD
--budget-usd <n>        Alias for --budget
--soft-limit-usd <n>    Soft budget threshold in USD
--verify <cmd>          Verifier command after each attempt
--proof                 Explicitly opt into a no-spend proof adapter lane
--max-iterations <n>    Maximum number of attempts
--max-tokens <n>        Maximum token budget
--engine <name>         Adapter to use: claude, codex, gemini, or openai
--cwd <path>            Repo root for the run
--allow-path <glob>     Restrict writes to this path pattern; repeatable
--deny-path <glob>      Block this path pattern; repeatable
--runs-dir <path>       Override the local Martin runs root
```

Use `martin-loop share --latest` after `dossier` when you want a redacted bundle you can hand to another person without sending raw run-store files.

More detail: [CLI reference](./docs/reference/cli.md) and [configuration reference](./docs/reference/config.md).

<div align="center">
  <img src="./docs/assets/cli-static.svg" alt="MartinLoop CLI terminal output" width="720">
</div>

## Benchmarks

MartinLoop ships a public deterministic benchmark workspace in `benchmarks/` plus the installed-package `bench` command.

From an installed package:

```sh
npx martin-loop bench --suite under-3-challenge
npx martin-loop bench --suite ralphy-engineering-50
```

From a clean public clone:

```sh
pnpm install --frozen-lockfile
pnpm bench:build
pnpm bench:eval
pnpm bench:report:ralphy
```

Equivalent workspace-filter commands:

```sh
pnpm --filter @martin/benchmarks build
pnpm --filter @martin/benchmarks test
pnpm --filter @martin/benchmarks eval
pnpm --filter @martin/benchmarks report:ralphy
```

The installed-package command reads shipped public fixtures. The repo-clone workflow runs the public benchmark workspace directly.

## MCP

<div align="center">
  <a href="https://glama.ai/mcp/servers/Keesan12/martin-loop">
    <img src="https://glama.ai/mcp/servers/Keesan12/martin-loop/badges/card.svg" alt="MartinLoop MCP server on Glama">
  </a>
</div>

The standalone `@martinloop/mcp` package gives MCP-capable agents a governed path from task intake to verified evidence.

### Connect in one command

| Host | Command |
| --- | --- |
| Claude Code | `claude mcp add martin-loop -- npx -y @martinloop/mcp` |
| Codex | `codex mcp add martin-loop -- npx -y @martinloop/mcp` |
| Gemini CLI | `gemini mcp add martin-loop -- npx -y @martinloop/mcp` |
| Any stdio MCP host | `npx -y @martinloop/mcp` |

Windows Claude Code:

```sh
claude mcp add --transport stdio --scope user martin-loop -- cmd /c npx -y @martinloop/mcp
```

### Agent operating sequence

```text
martin_doctor
  → martin_estimate
  → martin_plan
  → martin_preflight
  → martin_run
  → martin_dossier
  → martin_eval
```

`martin_run` is intentionally write-capable and hard-blocks until the required planning and preflight receipts exist for the same task. Inspection, status, dossier, verification, and triage tools are read-only.

For agents integrating MartinLoop:

1. Start with `martin_doctor`.
2. Estimate before spending.
3. Keep the objective and scope consistent through plan, preflight, and run.
4. Treat failed, contradicted, missing, or unknown verification as incomplete.
5. Prefer read-only tools until a human or governing workflow has authorized execution.
6. Read `martin://agent/next-step` or `martin://guides/agent-start` when the next action is unclear.

Generate host config from the root CLI:

```sh
npx martin-loop mcp print-config --host codex --transport stdio --profile minimal
npx martin-loop mcp print-config --host claude --transport stdio --profile diagnostic
npx martin-loop mcp print-config --host gemini --transport stdio --profile full-local
npx martin-loop mcp print-config --host generic --transport stdio --profile github-review
```

The root `martin-loop` package and standalone `@martinloop/mcp` package use independent version lines. The registry/server identifier is `io.github.Keesan12/martin-loop`.

Read the focused package guide: [`@martinloop/mcp` README](./packages/mcp/README.md).  
More detail: [MCP setup](./docs/getting-started/mcp.md), [MCP tool reference](./docs/reference/mcp-tools.md), and [MCP compatibility](./docs/reference/mcp-compatibility.md).

Related MCP servers commonly used alongside MartinLoop:

- [GitHub MCP Server](https://glama.ai/mcp/servers/github/github-mcp-server) for repository, issue, and pull-request operations.
- [Git MCP server](https://glama.ai/mcp/servers/modelcontextprotocol/git) for local repository inspection and version-control actions.
- [Playwright MCP](https://glama.ai/mcp/servers/microsoft/playwright-mcp) for browser verification and end-to-end testing.

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
      maxUsd: 3,
      softLimitUsd: 2.25,
      maxIterations: 3,
      maxTokens: 20_000,
    },
  },
});

const result = await loop.run({
  task: {
    title: "Fix auth regression",
    objective: "Fix the failing auth regression tests",
    verificationPlan: ["pnpm test"],
    repoRoot: process.cwd(),
  },
});

console.log(result.decision.status);
```

The root SDK also exports `createCodexCliAdapter`, `createGeminiCliAdapter`, `createDirectProviderAdapter`, `createOpenAiCompatibleAdapter`, and `createVerifierOnlyAdapter`.

More detail: [SDK reference](./docs/reference/sdk.md) and [package map](./docs/reference/packages.md).

## Examples

- [Quickstart](./docs/getting-started/quickstart.md)
- [Examples](./docs/getting-started/examples.md)
- [Failure Taxonomy (13 Runtime Classes)](./docs/oss/FAILURE-TAXONOMY-13.md)
- [PRE-028-PUBLIC-SURFACE-DIFF.md](./docs/oss/PRE-028-PUBLIC-SURFACE-DIFF.md)
- [Claude Code walkthrough](./docs/getting-started/claude-code.md)
- [Codex setup](./docs/getting-started/codex.md)
- [MCP setup](./docs/getting-started/mcp.md)
- [MCP tool reference](./docs/reference/mcp-tools.md)
- [Agent run receipts](./docs/oss/AGENT-RUN-RECEIPTS.md)
- [Benchmark and receipt page](./docs/oss/BENCHMARK-RECEIPT-PAGE.md)
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
pnpm lint
pnpm test
pnpm build
pnpm public:copy-scan
pnpm public:git-surface
pnpm oss:validate
pnpm public:smoke
pnpm release:matrix:local
```

Standalone MCP validation:

```sh
pnpm --filter @martinloop/mcp lint
pnpm --filter @martinloop/mcp test
pnpm --filter @martinloop/mcp build
pnpm --filter @martinloop/mcp smoke:pack
pnpm --filter @martinloop/mcp smoke:published:pack
pnpm --filter @martinloop/mcp verify:release
```

## Contributing

Issues, bug reports, workflow feedback, and focused pull requests are welcome. Public-facing docs should stay concise, user-centered, and accurate.

```sh
git checkout -b feat/your-feature
pnpm lint
pnpm test
git commit -m "feat: describe what you built"
git push -u origin feat/your-feature
```

<p align="center">
  <strong>Star this repo</strong> if you think AI coding needs budgets, brakes, and receipts.
</p>
<p align="center">
  <a href="https://martinloop.com">martinloop.com</a> · <a href="mailto:support@martinloop.com">support@martinloop.com</a>
</p>

## License

Apache-2.0. See [LICENSE](./LICENSE).
