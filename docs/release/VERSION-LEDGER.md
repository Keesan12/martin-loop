# Version Ledger

This file is the canonical version map for release work. Do not push, tag, or publish from memory when the root `martin-loop` package and the standalone `@martinloop/mcp` package move on different lines.

## Root package: `martin-loop`

- live npm dist-tag `latest` before `v0.2.6`: `0.2.5`
- public GitHub `main` target for the `v0.2.6` release: `0.2.6`
- release rule: treat the root package as its own semver line and do not infer standalone MCP versioning from it

## Standalone MCP package: `@martinloop/mcp`

- live npm dist-tag `latest` before `mcp-v0.2.5`: `0.2.0`
- public GitHub `main` target for `mcp-v0.2.5`: `0.2.5`
- public release lineage:
  - `0.1.4` for operator foundation
  - `0.2.0` for cockpit expansion
  - `0.2.5` for the stable cockpit line

## Rules

- do not use `0.3.0` as an active standalone MCP release label in OSS or mirror surfaces
- do not let the root package version line drive standalone MCP release numbering
- keep public docs scoped to the documented package surface
- do not use public MCP release docs to imply undocumented hosted or transport features
- before any push candidate, confirm this ledger against:
  - `npm view martin-loop version versions --json`
  - `npm view @martinloop/mcp version versions --json`
  - public GitHub `main`
  - the exact local release candidate tree
