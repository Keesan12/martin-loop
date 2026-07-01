# MartinLoop 0.4.0 — Success-path conversion and public release-surface reset

`0.4.0` turns the first post-`0.3.19` root release into a public conversion and release-hygiene pass.

## What changed

- successful, verifier-passed `martin run` executions now return a public repo star CTA without breaking JSON consumers
- the CLI only emits that CTA when the run actually completed and the persisted verification summary passed
- public release surfaces now have an explicit stale-license regression test for Apache 2.0 correctness
- release metadata, README audit commands, and the version ledger now align with the `0.4.0` root package line

## Why it matters

MartinLoop already had public usage, but it was not converting successful runs into repo support. This release fixes that at the product boundary while tightening the public docs and release checks that sit in front of a broader visibility push.

## Upgrade / audit lane

```sh
npx -y martin-loop@0.4.0 --version
npx -y martin-loop@0.4.0 start
npx -y martin-loop@0.4.0 demo
cd martin-loop-demo
npm install
npx -y martin-loop@0.4.0 run "Summarize the demo workspace and prove tests still pass" --verify "npm test" --budget-usd 2 --max-iterations 1 --json
npx -y martin-loop@0.4.0 dossier --latest --json
npx -y martin-loop@0.4.0 share --latest --json
```

## Package lines in this release

- root package advances to `0.4.0`
- standalone `@martinloop/mcp` remains on `0.3.6`

See [VERSION-LEDGER.md](./VERSION-LEDGER.md) for the canonical version map.
