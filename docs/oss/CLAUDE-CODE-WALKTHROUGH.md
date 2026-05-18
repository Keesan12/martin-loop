# Claude Code Walkthrough

This walkthrough shows how to put MartinLoop around a Claude Code-driven coding task so the run has a budget, a verifier gate, an explicit stop reason, and an inspectable run record.

Back to the repo overview: [README.md](../../README.md)

## What MartinLoop adds around Claude Code

Claude Code is the coding engine. MartinLoop is the governance layer around it.

- **Budget**: hard USD, token, and iteration limits decide how far the run can go.
- **Verifier**: the run only counts as complete when the post-run verification command passes.
- **Stop reason**: MartinLoop records why the run stopped, such as `completed`, `budget_exit`, or `human_escalation`.
- **Run record**: each run appends a JSONL record under `~/.martin/runs/` so you can inspect it later.

## Prerequisites

- Node.js 20+
- `pnpm` 10.x if you are running from this repo
- Claude Code CLI installed and authenticated
- A repo you want Claude Code to work in

## Install MartinLoop

For the published CLI:

```bash
npm install -g martin-loop
```

For repo-local development in this monorepo:

```bash
pnpm install
pnpm build
```

## Simple local run

Run MartinLoop with the default Claude adapter and a verifier command:

```bash
martin run "fix the auth regression" \
  --engine claude \
  --budget 3.00 \
  --verify "pnpm test"
```

What happens:

- MartinLoop hands the objective to Claude Code
- Claude Code attempts the work
- MartinLoop runs the verifier command
- the loop only finishes as `completed` when the agent result and verifier both pass

## Budget example

Use a hard cap and a smaller iteration budget when you want Claude Code to stay tightly bounded:

```bash
martin run "tighten the login retry handling" \
  --engine claude \
  --budget 2.00 \
  --soft-limit-usd 1.25 \
  --max-iterations 2 \
  --max-tokens 20000 \
  --verify "pnpm --filter @martin/core test"
```

This is the key MartinLoop value-add for Claude Code workflows: the agent can keep trying, but only inside a contract you can review before the spend drifts.

## Verifier example

Use a verifier that matches the exact scope of the change:

```bash
martin run "update the OSS quickstart wording" \
  --engine claude \
  --cwd . \
  --allow-path README.md \
  --allow-path docs/oss/** \
  --deny-path demo/seeded-workspace/** \
  --accept "Only documentation files may change" \
  --verify "pnpm --filter @martin/core test"
```

The verifier gate matters because Claude Code producing a patch is not the same thing as the repo being in a valid state.

## Inspect example

After a run, inspect the persisted JSONL record:

```bash
martin inspect --file ~/.martin/runs/<workspaceId>.jsonl
```

Look for:

- the final lifecycle state and stop reason
- budget and token totals
- verifier outcome
- attempt count and failure classification

## Safe repo-local dry run

If you want to validate the MartinLoop flow without real model spend, use stub mode first:

### PowerShell

```powershell
$env:MARTIN_LIVE='false'
$repoRoot = (Get-Location).Path
pnpm run:cli -- run `
  --cwd $repoRoot `
  --objective "Summarize the current runtime state" `
  --verify "pnpm --filter @martin/core test"
Remove-Item Env:MARTIN_LIVE
```

This does not invoke Claude Code, and it will usually end with a recorded non-success stop reason because no live provider request was attempted. That is still the fastest way to confirm the loop, persistence, and verifier path are wired correctly before you switch to a live Claude run.

## Common errors and troubleshooting

### `claude` is not found

MartinLoop can only use the Claude adapter when the Claude Code CLI is installed and available on `PATH`. Confirm the CLI itself works before you debug MartinLoop.

### The run stops with `budget_exit`

The configured budget, iteration limit, or token ceiling was too tight for the requested task. Either narrow the task or raise the budget intentionally.

### The verifier fails even though Claude Code produced a patch

That means MartinLoop did its job. The patch was attempted, but the repo did not reach a verified state. Tighten the scope, change the verifier, or ask Claude Code to address the failing checks directly.

### The run exits with `human_escalation`

That usually means MartinLoop detected a path that should not proceed unattended, such as an unsafe verifier or a control boundary that needs review.

### `martin inspect` cannot find the file

Run another task first, or point `inspect` at the correct JSONL file under `~/.martin/runs/`.
