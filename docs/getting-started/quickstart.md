# Quickstart

Use this guide to get one governed MartinLoop run and one evidence review in a few minutes.

## Prerequisites

- Node.js 20+
- npm for the packaged demo
- pnpm 10.x if you are working from this repository
- optional for live runs: Claude Code or Codex CLI installed and authenticated

## Try The Demo

```sh
npx martin-loop demo
cd martin-loop-demo
npm install
MARTIN_LIVE=false npx martin-loop run "Summarize the demo workspace and confirm the verifier is green" --verify "npm test"
npx martin-loop dossier --latest
```

This uses no-spend proof mode, so it validates the loop, verifier, persistence, and dossier path without model spend.

## Install The CLI

```sh
npm install -g martin-loop
npx martin-loop doctor
```

`doctor` checks whether MartinLoop can find the tools and local run directories it needs.

## Run A Governed Task

```sh
npx martin-loop run "fix the auth regression" --budget 3.00 --verify "pnpm test"
```

The run can only finish as complete when the adapter result and verifier state both pass.

## Review Evidence

```sh
npx martin-loop triage
npx martin-loop dossier --latest
```

Use `triage` to rank saved runs by urgency. Use `dossier` when you want the receipt for one run: stop reason, verifier evidence, budget status, rollback or artifact evidence, and the next safe action.

## Repository Development

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm test
pnpm lint
```

More detail:

- [CLI reference](../reference/cli.md)
- [Config reference](../reference/config.md)
- [Examples](./examples.md)
- [MCP setup](./mcp.md)
