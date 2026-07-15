# MartinLoop 0.4.3 — Loop workflow consistency fixes

`0.4.3` is a focused patch on top of `0.4.2` that tightens the local loop workflow around budget preferences, command context, and preflight approval boundaries.

## What changed

- `martin start` now uses the stored default budget consistently across recommended estimate, run, proof-run, and enable commands
- generated next-step commands now preserve explicit `--cwd` and `--runs-dir` values so users can keep governing the intended workspace and run store
- preflight receipts are now tied to execution bounds: changing engine, verifier, path scope, or budget requires a fresh preflight, while unchanged bounds continue normally

## Why it matters

The first-run workflow is where users learn whether MartinLoop is a real governance layer or just another wrapper. This patch keeps the generated command path faithful to the user's selected workspace, run directory, budget, verifier, engine, and file scope.

## Upgrade / audit lane

```sh
npx -y martin-loop@0.4.3 --version
npx -y martin-loop@0.4.3 start
npx -y martin-loop@0.4.3 demo
cd martin-loop-demo
npm install
npx -y martin-loop@0.4.3 run "Summarize the demo workspace and prove tests still pass" --verify "npm test" --budget-usd 2 --max-iterations 1 --json
npx -y martin-loop@0.4.3 dossier --latest --json
npx -y martin-loop@0.4.3 share --latest --json
```

## Package lines in this release

- root package advances to `0.4.3`
- standalone `@martinloop/mcp` remains on `0.3.7`

See [VERSION-LEDGER.md](./VERSION-LEDGER.md) for the canonical version map.
