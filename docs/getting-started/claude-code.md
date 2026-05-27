# Claude Code Setup

MartinLoop can wrap Claude Code so each coding run has a budget, a verifier gate, an explicit stop reason, and an inspectable run record.

## Prerequisites

- Node.js 20+
- MartinLoop CLI
- Claude Code CLI installed and authenticated
- A repository you want Claude Code to work in

## Install MartinLoop

```sh
npm install -g martin-loop
npx martin-loop doctor
```

For repo-local development:

```sh
pnpm install --frozen-lockfile
pnpm build
```

## Run With Claude Code

```sh
npx martin-loop run "fix the auth regression" \
  --engine claude \
  --budget 3.00 \
  --verify "pnpm test"
```

MartinLoop gives the objective to Claude Code, runs the verifier after each attempt, and only records completion when the verifier passes.

## Use A Tight Budget

```sh
npx martin-loop run "tighten the login retry handling" \
  --engine claude \
  --budget 2.00 \
  --soft-limit-usd 1.25 \
  --max-iterations 2 \
  --max-tokens 20000 \
  --verify "pnpm --filter @martin/core test"
```

## Limit Scope

```sh
npx martin-loop run "update the quickstart wording" \
  --engine claude \
  --cwd . \
  --allow-path README.md \
  --allow-path docs/** \
  --deny-path demo/seeded-workspace/** \
  --accept "Only documentation files may change" \
  --verify "pnpm --filter @martin/core test"
```

## Review The Run

```sh
npx martin-loop triage
npx martin-loop dossier --latest
```

Look for the final lifecycle state, stop reason, budget totals, verifier outcome, attempt count, and any failure classification.
