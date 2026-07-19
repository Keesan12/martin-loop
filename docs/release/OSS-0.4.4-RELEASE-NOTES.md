# MartinLoop 0.4.4 — Cost accounting and reliability fixes

`0.4.4` is a focused patch on top of `0.4.3` that tightens cost accounting accuracy, hardens the streaming budget guard, and fixes a payload packaging issue.

## What changed

- cost accounting now uses model-specific per-token pricing instead of uniform defaults
- cache-aware cost accounting correctly handles prompt cache read/write pricing in supported models
- streaming budget guard now correctly skips aggregate usage from result events that duplicate streamed per-message usage
- keyed npm-pack payload now resolves correctly for multi-workspace monorepo installations

## Why it matters

Accurate cost accounting is the foundation of MartinLoop's budget governance. When per-message token usage was double-counted against the budget, runs terminated earlier than the configured limit. This patch brings measured spend in line with actual API cost.

## Upgrade / audit lane

```sh
npx -y martin-loop@0.4.4 --version
npx -y martin-loop@0.4.4 start
npx -y martin-loop@0.4.4 demo
cd martin-loop-demo
npm install
npx -y martin-loop@0.4.4 run "Summarize the demo workspace and prove tests still pass" --verify "npm test" --budget-usd 2 --max-iterations 1 --json
npx -y martin-loop@0.4.4 dossier --latest --json
npx -y martin-loop@0.4.4 share --latest --json
```

## Package lines in this release

- root package advances to `0.4.4`
- standalone `@martinloop/mcp` advances to `0.3.8`

See [VERSION-LEDGER.md](./VERSION-LEDGER.md) for the canonical version map.
