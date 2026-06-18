# Quickstart

Use this guide to get one governed MartinLoop run and one evidence review in a few minutes.

## Prerequisites

- Node.js 20+
- npm for the packaged demo
- pnpm 10.x if you are working from this repository
- optional for live runs: Claude Code or Codex CLI installed and authenticated

## Recommended First Run

```sh
npx martin-loop demo
cd martin-loop-demo
npm install
npx martin-loop start
npx martin-loop doctor
npx martin-loop session-start
npx martin-loop preflight "Summarize the demo workspace and prove tests still pass" --verify "npm test"
npx martin-loop run "Summarize the demo workspace and prove tests still pass" --verify "npm test" --budget-usd 2 --max-iterations 1
npx martin-loop review
npx martin-loop receipts explain --latest
npx martin-loop dossier --latest
npx martin-loop share --latest
```

This path creates the local receipts MartinLoop expects before a real governed run, then proves the run/dossier/share loop with a real spend-governed execution.

`martin start` gives a guided first-run summary and suggested next commands. `martin enable` writes repo-local defaults and keeps control explicit; MartinLoop does not silently intercept other agent tools globally.

## Install the CLI

```sh
npm install -g martin-loop
npx martin-loop doctor
```

`doctor` checks whether MartinLoop can find the local tools, agents, and run directories it needs.

## Run a Governed Task

```sh
npx martin-loop preflight "fix the auth regression" --verify "pnpm test"
npx martin-loop run "fix the auth regression" --budget 3.00 --verify "pnpm test"
```

By default, MartinLoop expects recent `doctor`, `session-start`, and `preflight` receipts for the same repo and task before a real run will start. If you intentionally need to bypass that local gate for a one-off run, use `--unsafe-allow-unguarded-run` explicitly.

For explicit no-spend validation, pass `--proof` intentionally:

```sh
npx martin-loop run "fix the auth regression" --proof --budget 1.00 --verify "pnpm test"
```

You can set repo-local defaults once:

```sh
npx martin-loop enable --engine claude --verify "pnpm test" --budget-usd 2 --max-iterations 1
```

After enablement, objective shorthand routes through governed run behavior:

```sh
npx martin-loop "fix the failing auth test and keep pnpm test green"
```

## Review Evidence

```sh
npx martin-loop triage
npx martin-loop review
npx martin-loop env
npx martin-loop receipts explain --latest
npx martin-loop dossier --latest
npx martin-loop share --latest
```

Use `triage` to rank saved runs by urgency. Use `dossier` when you want one run receipt: stop reason, verifier evidence, budget status, rollback or artifact evidence, and the next safe action. Use `share` when you want a redacted bundle you can attach to a ticket, send to a teammate, or keep with the run directory.

The share bundle contains `run-receipt.json`, `run-receipt.md`, and `proof-card.svg`.

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
