# MartinLoop 0.4.2 — Error normalization & diagnostics fixes

`0.4.2` is a targeted patch on top of `0.4.1` that restores error normalization, improves Codex failure diagnostics, and adds a regression guard against a misplaced CLI flag.

## What changed

- `failure.message` now consistently carries the normalized, parseable failure signal that downstream consumers depend on — raw stderr is preserved in the `summary` field for diagnostics; the regression was introduced in `0.4.1`
- when Codex exits immediately with no output, the failure summary now surfaces the actual exit code and stderr content instead of a generic message, making the failure actionable without manual log inspection
- `--max-tokens` (which does not exist in the Claude CLI) is now explicitly tested as absent — token enforcement is via the streaming budget circuit breaker, not a subprocess flag; test is a regression guard to prevent re-introduction

## Why it matters

The error normalization regression in `0.4.1` caused `failure.message` to carry raw, unparseable stderr in some adapter paths. Downstream triage, atlas classification, and any consumer reading the structured failure signal were affected. This patch restores the correct normalization contract across all adapter paths.

## Upgrade / audit lane

```sh
npx -y martin-loop@0.4.2 --version
npx -y martin-loop@0.4.2 start
npx -y martin-loop@0.4.2 demo
cd martin-loop-demo
npm install
npx -y martin-loop@0.4.2 run "Summarize the demo workspace and prove tests still pass" --verify "npm test" --budget-usd 2 --max-iterations 1 --json
npx -y martin-loop@0.4.2 dossier --latest --json
npx -y martin-loop@0.4.2 share --latest --json
```

## Package lines in this release

- root package advances to `0.4.2`
- standalone `@martinloop/mcp` remains on `0.3.7`

See [VERSION-LEDGER.md](./VERSION-LEDGER.md) for the canonical version map.
