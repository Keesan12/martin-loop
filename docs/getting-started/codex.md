# Codex Setup

MartinLoop can wrap Codex CLI runs with the same budget, verifier, scope, and evidence model used for other coding agents.

## Prerequisites

- Node.js 20+
- MartinLoop CLI
- Codex CLI installed and authenticated
- A repository you want Codex to work in

## Run With Codex

```sh
npx martin-loop run "fix the auth regression" \
  --engine codex \
  --budget 3.00 \
  --verify "pnpm test"
```

## Use A No-Spend Proof Path First

```sh
npx martin-loop demo
cd martin-loop-demo
npm install
npx martin-loop run "Summarize the demo workspace and confirm the verifier is green" --proof --verify "npm test"
npx martin-loop dossier --latest
```

`--proof` is explicit opt-in. Default `martin-loop run` commands execute live governed runs with real spend controls.

## Install MCP For Codex

```sh
codex mcp add martin-loop -- npx -y @martinloop/mcp
```

Or generate a config block:

```sh
npx martin-loop mcp print-config --host codex --transport stdio --profile starter
```

The generated starter profile includes `martin_run`, so use a manual allow-list if you want a read-only setup.

## Troubleshooting

- If Codex is not found, confirm the Codex CLI works on `PATH`.
- If the run exits on budget, narrow the task or intentionally raise the budget.
- If the verifier fails, inspect the failed check before asking the agent to continue.
