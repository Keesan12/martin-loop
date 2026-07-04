# Benchmark + Receipt Page

This page is the clean, reproducible path to one benchmark run and one governed receipt bundle.

## Goal

Prove three things in one pass:

1. Budget caps are active.
2. Stop conditions are explicit.
3. Receipt artifacts are generated for review.

## Quick benchmark lane

```sh
npx martin-loop bench --suite under-3-challenge
```

For repo-local deterministic execution:

```sh
pnpm install --frozen-lockfile
pnpm --filter @martin/benchmarks build
pnpm --filter @martin/benchmarks eval
pnpm --filter @martin/benchmarks report:ralphy
```

## Governed receipt lane

```sh
npx -y martin-loop@latest doctor
npx -y martin-loop@latest session-start
npx -y martin-loop@latest preflight "Summarize the workspace and prove tests still pass" --verify "npm test"
npx -y martin-loop@latest run "Summarize the workspace and prove tests still pass" --proof --verify "npm test"
npx -y martin-loop@latest dossier --latest
npx -y martin-loop@latest runs verify --latest
npx -y martin-loop@latest share --latest
```

Default receipt bundle outputs:

- `share/run-receipt.json`
- `share/run-receipt.md`

Optional proof-card outputs:

- `share/proof-card-r<revision>-<hash>.svg`
- `share/proof-card-r<revision>-<hash>.png`

## Screenshot: budget cap, stop condition, receipt

![Budget cap, stop condition, and receipt screenshot](../assets/budget-stop-receipt-screenshot.png)

Use this screenshot as the visual proof anchor in issues, demos, and external walkthroughs.

## Related docs

- [Agent run receipts](./AGENT-RUN-RECEIPTS.md)
- [Budget caps](../concepts/budget-caps.md)
- Agent failure atlas — maintained in internal documentation
