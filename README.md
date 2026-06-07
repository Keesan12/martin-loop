# MartinLoop

<div align="center">
  <img src="./docs/assets/martinloop-logo.png" alt="MartinLoop" width="260">

  **The open-source control plane for AI coding agents.**

  MartinLoop wraps Claude Code, Codex, and MCP-aware agent workflows with budgets, verifier gates, policy checks, run receipts, and review-ready evidence.
</div>

## Why MartinLoop

AI coding agents are useful, but unbounded retry loops are expensive.

A task that looked like a $2.40 fix can become dozens of attempts, a blown token budget, and a diff nobody trusts. MartinLoop gives every run an explicit contract: objective, verifier, budget, scope, receipts, and a clear stop condition.

Use it when AI coding work needs to stay bounded, inspectable, and safe to review before it becomes expensive or destructive.

## Quick Start

Try MartinLoop in a disposable demo workspace:

```sh
npx martin-loop start
npx martin-loop tour
npx martin-loop demo
cd martin-loop-demo
npm install
npx martin-loop doctor
npx martin-loop session-start
npx martin-loop preflight "Summarize the demo workspace and prove tests still pass" --verify "npm test"
npx martin-loop run "Summarize the demo workspace and prove tests still pass" --proof --verify "npm test"
npx martin-loop dossier --latest
```

`start` and `tour` walk a new operator through the product flow. `doctor`, `session-start`, and `preflight` create the local receipts MartinLoop expects before a real governed run. If you intentionally need to bypass that local gate for a one-off run, use `--unsafe-allow-unguarded-run` explicitly.

Release notes for the current root package: [MartinLoop 0.2.10](./docs/release/OSS-0.2.10-RELEASE-NOTES.md).

## What It Does

- Budget caps stop the next attempt before a configured USD, token, or iteration limit is exceeded.
- Verifier gates require a real check, such as `npm test`, before a run can count as complete.
- Policy checks block unsafe verifier commands, risky path changes, and secret-like task inputs before execution.
- Run receipts capture stop reason, verifier evidence, verifier-step warnings, budget posture, and next safe action.
- Local onboarding commands (`start`, `tour`, `guide`, `session-start`) help operators adopt the governed flow without memorizing it.
- MCP integration gives hosts one primary coding execution entrypoint plus richer planning, inspection, and review helpers.

## How It Works

| Layer | Purpose |
| --- | --- |
| Task contract | Objective, verifier plan, repo root, allowed paths, denied paths, acceptance criteria, workspace, project, and budget. |
| Policy and budget | Defaults come from `martin.config.yaml`; CLI flags can override them. Budget preflight blocks attempts that would exceed policy. |
| Agent adapters | Claude CLI, Codex CLI, direct-provider, and verifier-only adapters normalize execution results. |
| Safety and verification | Scope checks, verifier command checks, prompt integrity, and grounding decide whether work can continue. |
| Persistence | JSONL run records, evidence summaries, and repo-backed artifacts make every run inspectable later. |

## CLI

```text
martin-loop start [--host <codex|claude|gemini|generic>]
martin-loop tour [--host <codex|claude|gemini|generic>]
martin-loop guide [topic]
martin-loop doctor
martin-loop demo
martin-loop session-start [--host <claude|codex|generic>]
martin-loop phase status|contract|preflight|run [--execute]
martin-loop preflight <objective> [options]
martin-loop run <objective> [options]
martin-loop triage
martin-loop dossier (--latest | --loop-id <id> | --file <path>)
martin-loop runs list|get|attempt|verify ...
martin-loop mcp print-config --host <codex|claude|gemini|generic>
martin-loop mcp install --host <codex|claude|gemini|generic>
martin-loop challenge [--loop-id <id> | --file <path> | --latest]
martin-loop badge [--format svg|json] [--runs-dir <path>]
```

The local-first onboarding flow is:

1. `martin-loop start`
2. `martin-loop tour`
3. `martin-loop doctor`
4. `martin-loop session-start`
5. `martin-loop preflight ...`
6. `martin-loop run ...`
7. `martin-loop dossier --latest`

More detail: [CLI reference](./docs/reference/cli.md) and [configuration reference](./docs/reference/config.md).

## MCP

Run the standalone MCP package directly:

```sh
npx -y @martinloop/mcp
```

Add it to common hosts:

```sh
codex mcp add martin-loop -- npx -y @martinloop/mcp
claude mcp add --transport stdio --scope user martin-loop -- npx -y @martinloop/mcp
claude mcp add --transport stdio --scope user martin-loop -- cmd /c npx -y @martinloop/mcp
```

Generate host config from the root CLI:

```sh
npx martin-loop mcp print-config --host codex --transport stdio --profile minimal
npx martin-loop mcp print-config --host claude --transport stdio --profile diagnostic
npx martin-loop mcp print-config --host gemini --transport stdio --profile full-local
npx martin-loop mcp print-config --host generic --transport stdio --profile github-review
```

The root `martin-loop` package and the standalone `@martinloop/mcp` package move on separate version lines. The root package is `0.2.10`; the current standalone MCP package is `0.2.7`.

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
pnpm lint
pnpm test
pnpm build
pnpm public:copy-scan
pnpm public:git-surface
pnpm oss:validate
pnpm public:smoke
pnpm release:validate-local
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

## License

Apache-2.0. See [LICENSE](./LICENSE).
