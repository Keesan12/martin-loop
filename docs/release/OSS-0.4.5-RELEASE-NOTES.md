# MartinLoop 0.4.5 — Pre Work Burn tracking and routing economics

`0.4.5` is a focused patch on top of `0.4.4` that adds Pre Work Burn tracking, routing economics, route classification, and cost-per-outcome data to governed run receipts.

## What changed

- Pre Work Burn tracking records the proportion of budget consumed before execution begins, exposing setup overhead in run receipts
- routing economics surfaces structured cost data so teams can compare routes across runs
- route classification distinguishes cost-effective execution from over-budget routes in dossier output
- cost-per-outcome normalizes run spend against verifier results for cross-run comparison

## Why it matters

Budget governance requires knowing not just what a run cost, but when cost was incurred. Pre Work Burn separates planning and setup overhead from execution cost, making the budget ledger more accurate and easier to act on.

## Upgrade / audit lane

```sh
npx -y martin-loop@0.4.5 --version
npx -y martin-loop@0.4.5 start
npx -y martin-loop@0.4.5 demo
cd martin-loop-demo
npm install
npx -y martin-loop@0.4.5 run "Summarize the demo workspace and prove tests still pass" --verify "npm test" --budget-usd 2 --max-iterations 1 --json
npx -y martin-loop@0.4.5 dossier --latest --json
npx -y martin-loop@0.4.5 share --latest --json
```

## Package lines in this release

- root package advances to `0.4.5`
- standalone `@martinloop/mcp` advances to `0.3.9`

See [VERSION-LEDGER.md](./VERSION-LEDGER.md) for the canonical version map.
