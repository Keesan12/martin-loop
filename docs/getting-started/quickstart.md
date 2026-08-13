# Quickstart

Use this guide to get one governed MartinLoop run and one evidence review in a few minutes.

## Prerequisites

- Node.js 20+
- npm for the packaged demo
- pnpm 10.x if you are working from this repository
- optional for live runs: Claude Code or Codex CLI installed and authenticated

## Recommended First Run

```sh
npx -y martin-loop@latest start
npx -y martin-loop@latest demo
cd martin-loop-demo
npm install
npx -y martin-loop@latest run "Summarize the demo workspace and prove tests still pass" --verify "npm test" --budget-usd 2 --max-iterations 1
npx -y martin-loop@latest dossier --latest
npx -y martin-loop@latest share --latest
```

This path proves the run/dossier loop with a real spend-governed execution. `run` auto-checks `doctor`, `session-start`, and `preflight`, then executes when the environment is ready.

## Install the CLI

```sh
npm install -g martin-loop
npx -y martin-loop@latest doctor
```

`doctor` checks whether MartinLoop can find the local tools, agents, and run directories it needs.

For deterministic package-line verification in fresh environments:

```sh
npx -y martin-loop@0.3.2 --version
npm view martin-loop version
npm view @martinloop/mcp version
```

If `npx martin-loop --version` differs from npm live, run `npx -y martin-loop@latest --version` or pin `@0.3.2` to avoid local cache drift.

## Run a Governed Task

```sh
npx -y martin-loop@latest preflight "fix the auth regression" --verify "pnpm test"
npx -y martin-loop@latest run "fix the auth regression" --budget 3.00 --verify "pnpm test"
```

By default, MartinLoop auto-checks `doctor`, `session-start`, and `preflight` for the same repo and task before a real run will spend money. If preflight finds a real blocker, MartinLoop stops before live spend and tells you what to fix.

For explicit no-spend validation, pass `--proof` intentionally:

```sh
npx -y martin-loop@latest run "fix the auth regression" --proof --budget 1.00 --verify "pnpm test"
```

If you want to inspect the governed checks first:

```sh
npx -y martin-loop@latest doctor
npx -y martin-loop@latest session-start
npx -y martin-loop@latest preflight "fix the auth regression" --verify "pnpm test"
```

## Review Evidence

```sh
npx -y martin-loop@latest triage
npx -y martin-loop@latest dossier --latest
npx -y martin-loop@latest share --latest
```

Use `triage` to rank saved runs by urgency. Use `dossier` when you want one run receipt: stop reason, verifier evidence, budget status, rollback or artifact evidence, and the next safe action. Use `share` when you want a redacted bundle you can attach to a ticket, send to a teammate, or keep with the run directory.

The share bundle contains `run-receipt.json`, `run-receipt.md`, and `proof-card.svg`.

To print exact artifact paths from your latest run:

```sh
npx -y martin-loop@latest share --latest --json
```

## Repository Development

```sh
pnpm install --frozen-lockfile
pnpm lint
pnpm test
pnpm build
```

More detail:

- [CLI reference](../reference/cli.md)
- [Config reference](../reference/config.md)
- [Examples](./examples.md)
- [MCP setup](./mcp.md)
