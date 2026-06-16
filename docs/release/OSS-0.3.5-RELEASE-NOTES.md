# MartinLoop 0.3.5 Proof Receipt Release

`0.3.5` upgrades MartinLoop share receipts so governed runs produce a sharper CLI-style proof card and clearer public documentation.

## What Changed

- Proof cards now render as dark terminal receipts with line rules, monospaced evidence rows, and explicit pass/boundary coloring.
- Share receipts include stronger visible context: task class, spend, budget, remaining budget, overspend ratio, verifier status, integrity state, runtime, and event rail when present in the local run record.
- Missing rollback, verifier, budget, or integrity evidence stays visible as an evidence boundary instead of being softened into a success claim.
- README and agent docs now show how to create and inspect share bundles with `runs verify --latest` and `share --latest`.
- Public tests now block rounded-card, blue-palette, gradient, and typography regressions in proof-card SVG output.

## Why This Matters

AI coding work needs evidence that can be checked after the run. A verifier pass is useful, but it is not the whole proof. The receipt should also show what it cost, what evidence exists, and what evidence is missing.

## Quick Check

```sh
npx -y martin-loop@0.3.5 run "Summarize the demo workspace and prove tests still pass" --proof --verify "npm test"
npx -y martin-loop@0.3.5 runs verify --latest
npx -y martin-loop@0.3.5 share --latest
```

Expected share bundle outputs:

- `share/run-receipt.json`
- `share/run-receipt.md`
- `share/proof-card.svg`
