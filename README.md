# MartinLoop

<div align="center">
  <img src="./docs/assets/martinloop-logo.png" alt="MartinLoop" width="260">

  **The open-source control plane for AI coding agents.**

  MartinLoop wraps Claude Code, Codex, Gemini, and MCP-aware agent workflows with budgets, verifier gates, policy checks, run receipts, and review-ready evidence.
</div>

## Why MartinLoop

AI coding agents are useful, but unbounded retry loops are expensive.

A task that looked like a small fix can become dozens of attempts, a blown token budget, and a diff nobody trusts. MartinLoop gives every run an explicit contract: objective, verifier, budget, scope, receipts, and a clear stop condition.

Use it when AI coding work needs to stay bounded, inspectable, and safe to review before it becomes expensive or destructive.

## Quick Start

Try MartinLoop in a disposable demo workspace:

```sh
npx -y martin-loop@latest demo
npx -y martin-loop@latest --version
cd martin-loop-demo
npm install
npx -y martin-loop@latest doctor
npx -y martin-loop@latest session-start
npx -y martin-loop@latest preflight "Summarize the demo workspace and prove tests still pass" --verify "npm test"
npx -y martin-loop@latest run "Summarize the demo workspace and prove tests still pass" --proof --verify "npm test"
npx -y martin-loop@latest dossier --latest
npx -y martin-loop@latest share --latest
```

`doctor`, `session-start`, and `preflight` create the local receipts MartinLoop expects before a real governed run.

`share --latest` writes three files into the selected run directory under `share/`: `run-receipt.json`, `run-receipt.md`, and `proof-card.svg`.

Release notes for the current root package: [MartinLoop 0.3.2](./docs/release/OSS-0.3.2-RELEASE-NOTES.md).

## Run This Audit Yourself

Use this lane from a clean temp directory to verify the public CLI flow exactly as shipped:

```sh
npx -y martin-loop@0.3.2 --version
npx -y martin-loop@0.3.2 demo
cd martin-loop-demo
npm install
npx -y martin-loop@0.3.2 doctor --json
npx -y martin-loop@0.3.2 session-start --json
npx -y martin-loop@0.3.2 preflight "Summarize the demo workspace and prove tests still pass" --verify "npm test" --json
npx -y martin-loop@0.3.2 run "Summarize the demo workspace and prove tests still pass" --proof --verify "npm test" --json
npx -y martin-loop@0.3.2 dossier --latest --json
npx -y martin-loop@0.3.2 share --latest --json
```

For deterministic installs, pin the package line (`martin-loop@0.3.2`) or use `martin-loop@latest`. Plain `npx martin-loop` can resolve a stale local cache on some machines.

Expected share bundle outputs:

- `share/run-receipt.json`
- `share/run-receipt.md`
- `share/proof-card.svg`

## What It Does

- Budget caps stop the next attempt before a configured USD, token, or iteration limit is exceeded.
- Verifier gates require a real check, such as `npm test`, before a run can count as complete.
- Policy checks block unsafe verifier commands, risky path changes, and secret-like task inputs before execution.
- Run receipts capture stop reason, verifier evidence, budget posture, integrity state, and the next safe action.
- `martin share --latest` turns the latest governed run into a local share bundle with a redacted JSON receipt, Markdown recap, and proof-card SVG.
- MCP integration gives hosts one write-capable execution entrypoint plus richer planning, inspection, and review helpers.

## How It Works

| Layer | Purpose |
| --- | --- |
| Task contract | Objective, verifier plan, repo root, allowed paths, denied paths, acceptance criteria, workspace, project, and budget. |
| Policy and budget | Defaults come from `martin.config.yaml`; CLI flags can override them. Budget preflight blocks attempts that would exceed policy. |
| Agent adapters | Claude CLI, Codex CLI, Gemini CLI, direct-provider, and verifier-only adapters normalize execution results. |
| Safety and verification | Scope checks, verifier command checks, prompt integrity, and grounding decide whether work can continue. |
| Persistence | JSONL run records, evidence summaries, and repo-backed artifacts make every run inspectable later. Each loop record is locally signed (HMAC, per-runs-root key) and `dossier`/`runs get`/`runs verify`/`challenge`/`badge` report an `integrity` verdict (`verified` / `tamper_detected` / `unsigned`) so post-hoc edits to a record are detectable, not just inspectable. |

## Trust Boundaries

- Cost and token outputs always include provenance (`actual`, `estimated`, or `unavailable`).
- For Codex specifically, MartinLoop reports authoritative usage only when the host exposes it; otherwise MartinLoop labels usage as estimated and avoids presenting it as settled accounting.
- Receipt integrity must be `verified` before a run is treated as trustworthy evidence for external review.

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

Examples below use `npx martin-loop` so they work without a global install. If you install `martin-loop` globally, the `martin` alias works too.

Use `martin-loop share --latest` after `dossier` when you want a redacted bundle you can hand to another person without sending raw run-store files.

More detail: [CLI reference](./docs/reference/cli.md) and [configuration reference](./docs/reference/config.md).

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

The installed-package command reads the shipped public fixtures. The repo-clone workflow runs the public benchmark workspace directly.

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

The root `martin-loop` package and the standalone `@martinloop/mcp` package move on separate version lines. The root package line here is `0.3.2`; the current standalone MCP package is `0.3.1`.

The public MCP release train labels are:

- `0.1.4` operator foundation
- `0.2.0` cockpit expansion
- `0.2.5` public MCP package line
- `0.2.7` usability and review release
- `0.3.0` host adoption and onboarding release
- `0.3.1` review and handoff release

The standalone MCP registry/server identifier is `io.github.Keesan12/martin-loop`.

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
- [Claude Code walkthrough](./docs/getting-started/claude-code.md)
- [Codex setup](./docs/getting-started/codex.md)
- [MCP setup](./docs/getting-started/mcp.md)
- [MCP tool reference](./docs/reference/mcp-tools.md)
- [Agent run receipts](./docs/oss/AGENT-RUN-RECEIPTS.md)
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

## License

Apache-2.0. See [LICENSE](./LICENSE).
