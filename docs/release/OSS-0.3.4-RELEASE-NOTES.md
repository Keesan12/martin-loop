# MartinLoop 0.3.4 Governed Integrity Hardening Release

`0.3.4` tightens governed preflight and persisted-run verification so unsafe selectors and receipt edge cases fail fast with explicit operator guidance.

## What Changed

- Path policy hardening:
  - `--allow-path` and `--deny-path` now reject traversal (`..`) and absolute path patterns.
- Explicit integrity verdict classes in `runs verify`:
  - `tampered_payload`
  - `missing_integrity_material`
  - `schema_unknown_fields`
- Canonical selector enforcement:
  - `runs verify --file` now rejects non-canonical selectors outside the configured runs root.
- OpenAI hosted preflight blockers:
  - missing `MARTIN_OPENAI_API_KEY` is now a hard blocker on hosted endpoints.
  - missing model and quota-vs-auth troubleshooting guidance are surfaced in warnings.
- MCP scope messaging:
  - unsupported local-scope host paths now suggest valid alternatives (`--scope user|project` or Claude local scope).

## Why This Matters

- Unsafe path globs are blocked before spend-bearing runs.
- Integrity failures are easier to triage because class labels are machine-parseable.
- Selector ambiguity and out-of-root file targets are rejected early.
- Hosted OpenAI setup failures are diagnosed faster with clearer preflight guidance.

## Quick Check

```sh
npx -y martin-loop@latest preflight "probe" --allow-path "..\\..\\*" --verify "pnpm --filter @martin/cli lint"
npx -y martin-loop@latest preflight "probe" --engine openai
npx -y martin-loop@latest runs verify --latest
```
