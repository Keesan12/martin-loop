# MartinLoop

<div align="center">
  <img src="./docs/assets/martinloop-logo.png" alt="MartinLoop" width="260" />

  **The open-source control plane for AI coding agents.**

  [![npm version](https://img.shields.io/npm/v/martin-loop)](https://www.npmjs.com/package/martin-loop)

  MartinLoop gives AI coding agents budgets, stop conditions, rollback rules, and receipts.

  **Get started:** `npx -y martin-loop@latest start`

  **Try the demo:** `npx -y martin-loop@latest demo`
</div>

## Why MartinLoop

Built from thousands of agent runs where the problem was not intelligence -- it was uncontrolled execution.

MartinLoop gives AI coding agents budgets, stop conditions, rollback rules, and receipts. Ungoverned agents can retry until cost and scope drift turn a small fix into an expensive, hard-to-review mess.

## Why Teams Adopt MartinLoop

- Teams need bounded spend before they trust AI coding agents in real repositories.
- Teams need verifier-backed completion instead of chat-only success claims.
- Teams need receipts they can review after the run, not just terminal scrollback.

## Quick Start

## 2-Minute Install Path

```sh
npx -y martin-loop@latest start
npx -y martin-loop@latest demo
cd martin-loop-demo
npm install
npx martin-loop doctor
npx martin-loop session-start
npx martin-loop preflight "Summarize the demo workspace and prove tests still pass" --verify "npm test"
npx martin-loop run "Summarize the demo workspace and prove tests still pass" --proof --verify "npm test"
npx martin-loop dossier --latest
```

You can also install it globally:

```sh
npm install -g martin-loop
```

Release notes for the current root package: [MartinLoop 0.3.2](./docs/release/OSS-0.3.2-RELEASE-NOTES.md)

## Visual Proof

<img src="./docs/assets/cli-animated.svg" alt="MartinLoop CLI showing a governed agent run" />

<img src="./docs/assets/cli-static.svg" alt="MartinLoop CLI terminal output" />

## See It In Action

<img src="./docs/assets/side-by-side.svg" alt="MartinLoop governed run compared with an unbounded retry loop" />

MartinLoop turns an AI coding run into an inspectable execution record with bounded budget, explicit verifier output, and a review-ready receipt.

## Ralph-Style Loops

Ralph-style loops are what MartinLoop is designed to stop: repeated attempts, widening diffs, rising cost, and weaker trust. MartinLoop keeps the loop bounded, makes failure explicit, and preserves the evidence needed for review.

## Failure Taxonomy (12 Runtime Classes)

MartinLoop classifies governed runtime failures into a canonical public taxonomy so teams can compare outcomes consistently across repos and providers.

[Failure Taxonomy (12 Runtime Classes)](./docs/oss/FAILURE-TAXONOMY-12.md)

## What It Does

- Budget caps stop the next attempt before configured USD, token, or iteration limits are exceeded.
- Verifier gates require a real check such as `npm test` before a run can count as complete.
- Policy checks block unsafe verifier commands, risky path changes, and secret-like task inputs before execution.
- Run receipts capture stop reason, verifier evidence, budget posture, and the next safe action.
- `martin share --latest` turns the latest governed run into a redacted JSON receipt, Markdown recap, and proof-card SVG.

## How It Works

| Layer | Purpose |
| --- | --- |
| Task contract | Objective, verifier plan, repo root, allowed paths, denied paths, acceptance criteria, and budget. |
| Policy and budget | Defaults come from config; CLI flags can override them. Budget preflight blocks attempts that exceed policy. |
| Agent adapters | Claude CLI, Codex CLI, Gemini CLI, direct-provider, and verifier-only adapters normalize execution results. |
| Safety and verification | Scope checks, verifier command checks, prompt integrity, and grounding decide whether work can continue. |
| Persistence | JSONL run records, receipts, and artifacts make every run inspectable later. |

## CLI

```text
martin-loop start
martin-loop doctor
martin-loop session-start
martin-loop preflight <objective> --verify "<command>"
martin-loop run <objective> --budget <n> --allow-path <glob>
martin-loop run <objective> --proof --verify "npm test"
martin-loop dossier --latest
martin-loop share --latest
martin-loop bench --suite under-3-challenge
```

If this flow is useful, open an issue with feedback so we can keep improving the public experience.

## Benchmarks

```sh
npx martin-loop bench --suite under-3-challenge
npx martin-loop bench --suite ralphy-engineering-50
pnpm --filter @martin/benchmarks build
pnpm --filter @martin/benchmarks eval
```

More benchmark context: [PRE-028-PUBLIC-SURFACE-DIFF.md](./docs/oss/PRE-028-PUBLIC-SURFACE-DIFF.md)

## MCP

```sh
npx -y @martinloop/mcp
npx martin-loop mcp print-config --host codex --transport stdio --profile minimal
```

The root `martin-loop` package and the standalone `@martinloop/mcp` package move on separate version lines. The root package line here is `0.3.2`; the current standalone MCP package is `0.3.1`.

## SDK

```sh
npm install martin-loop
```

```typescript
import { MartinLoop, createClaudeCliAdapter } from "martin-loop";

const loop = new MartinLoop({
  adapter: createClaudeCliAdapter({ workingDirectory: process.cwd() }),
});
```

## Examples

- [Quickstart](./docs/getting-started/quickstart.md)
- [Examples](./docs/getting-started/examples.md)
- [Claude Code walkthrough](./docs/getting-started/claude-code.md)
- [Codex setup](./docs/getting-started/codex.md)
- [MCP setup](./docs/getting-started/mcp.md)
- [Agent run receipts](./docs/oss/AGENT-RUN-RECEIPTS.md)

## Development

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

Issues, bug reports, workflow feedback, and focused pull requests are welcome.

Star this repo if you want to follow the public release line.

<a href="https://martinloop.com">martinloop.com</a>
<br />
<a href="mailto:support@martinloop.com">support@martinloop.com</a>
<br />
<img src="./docs/assets/nvidia-inception-program-light.png" alt="NVIDIA Inception Program" width="160" />

## License

Apache-2.0. See [LICENSE](./LICENSE).
