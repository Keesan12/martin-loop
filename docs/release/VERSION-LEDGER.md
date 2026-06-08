# Version Ledger

This file is the release source of truth for package/version mapping in this repo. Check it before you cut a branch, update docs, or talk about npm state.

## Root package: `martin-loop`

- live npm dist-tag `latest`: `0.3.0`
- live public GitHub release: `v0.3.0`
- live public baseline in this train: `0.3.0`
- root public baseline: `0.3.0`
- releases consumed since the original `0.2.8` launch:
  - `0.2.9` fixed proof-run classification, Windows `.cmd` resolution, and public provider defaults
  - `0.2.10` tightened verifier evidence, `--runs-dir` consistency, and public help output
  - `0.2.11` fixed `runs verify --latest` selector parity in the public CLI
- current in-repo root release line: `0.3.1` for production claim parity hardening and CLI/public benchmark reliability
- next planned root follow-on: `0.3.2`

## Standalone package: `@martinloop/mcp`

- live npm dist-tag `latest`: `0.3.0`
- live public GitHub release: `mcp-v0.3.0`
- live public baseline in this train: `0.3.0`
- standalone MCP public baseline: `0.3.0`
- next planned standalone release: `0.3.1` for review and handoff controls
- next planned follow-ons:
  - `0.3.2` opt-in execution controls

## Release rules

- The root package line and the standalone MCP line move independently.
- Do not infer standalone MCP release state from the root package, or the other way around.
- Public release notes must be written for customers and evaluators, not for internal operators.
- Public-facing examples, screenshots, README copy, and changelog entries must stay free of internal repo names, absolute system paths, private branch names, or process noise.
- Publish only through GitHub Actions trusted publishing / OIDC.

## Validation baseline before any public prep branch

- `pnpm install --frozen-lockfile`
- `pnpm lint`
- `pnpm test`
- `pnpm build`
- `pnpm public:git-surface`
- `pnpm oss:validate`
- `pnpm public:smoke`
- `pnpm release:matrix:local`
- `pnpm --filter @martinloop/mcp lint`
- `pnpm --filter @martinloop/mcp test`
- `pnpm --filter @martinloop/mcp build`
- `pnpm --filter @martinloop/mcp smoke:pack`
- `pnpm --filter @martinloop/mcp smoke:published:pack`
- `pnpm --filter @martinloop/mcp verify:release`
