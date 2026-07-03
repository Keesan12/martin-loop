# MartinLoop 0.4.1 — Preflight receipt chain and receipt-first trust defaults

`0.4.1` is a targeted patch on top of `0.4.0` that fixes a broken governed receipt chain on CI environments and completes the receipt-first trust surface work.

## What changed

- `martin preflight` now writes the workflow receipt correctly on all platforms and CI environments — the previous release used the raw Codex availability check instead of the test-injectable wrapper, so CI runners without Codex installed silently skipped writing the preflight receipt, breaking the full session-start → preflight → run governed chain
- receipts are now the default share artifact — `martin share` outputs `run-receipt.json` and `run-receipt.md` by default; proof-card images are opt-in with `--with-proof-card`
- `martin share` appends stable `run-receipts.md` and `run-receipts.jsonl` ledgers alongside per-run share bundles, keyed by receipt-state revision so repeated shares do not overwrite prior evidence
- MCP discovery now centers receipt-first trust surfaces: `martin://agent/next-step`, `martin://runs/latest/summary`, and `martin://runs/latest/receipt` are the default low-context workflow; proof-card views are optional derived artifacts
- workspace pnpm policy is now authoritative in `pnpm-workspace.yaml`, matching the repo-pinned `pnpm@10.33.0` toolchain

## Why it matters

The `0.4.0` preflight receipt bug was silent: Windows developers with Codex installed saw no failure locally, but CI and any environment without Codex produced a broken governed chain. Tests that validated the full session-start → preflight → run flow were failing on all three CI platforms. This patch fixes the root cause with a single-line correction in the availability check call site.

## Upgrade / audit lane

```sh
npx -y martin-loop@0.4.1 --version
npx -y martin-loop@0.4.1 start
npx -y martin-loop@0.4.1 demo
cd martin-loop-demo
npm install
npx -y martin-loop@0.4.1 run "Summarize the demo workspace and prove tests still pass" --verify "npm test" --budget-usd 2 --max-iterations 1 --json
npx -y martin-loop@0.4.1 dossier --latest --json
npx -y martin-loop@0.4.1 share --latest --json
```

## Package lines in this release

- root package advances to `0.4.1`
- standalone `@martinloop/mcp` remains on `0.3.7`

See [VERSION-LEDGER.md](./VERSION-LEDGER.md) for the canonical version map.
