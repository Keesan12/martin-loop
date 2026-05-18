# Version Ledger

This file is the canonical version map for release work. Do not push, tag, or publish from memory when the root `martin-loop` package and the standalone `@martinloop/mcp` package move on different lines.

## Root package: `martin-loop`

- live npm dist-tag `latest`: `0.1.5`
- live npm versions include: `0.1.0`, `0.1.1`, `0.1.2`, `0.1.3`, `0.1.4`, `0.1.5`, and a historical anomaly `1.3.0`
- public GitHub `main`: `0.1.6`
- local OSS integrated tree: `0.1.6`
- release rule: treat the root package as a separate `0.1.x` line and do not infer standalone MCP versioning from it

## Standalone MCP package: `@martinloop/mcp`

- live npm dist-tag `latest`: `0.1.3`
- live npm versions include: `0.1.1`, `0.1.2`, `0.1.3`
- public GitHub `main`: `0.1.3`
- local OSS integrated tree: `0.2.5`
- public scheduled release train:
  - `0.1.4` for operator-foundation delivery
  - `0.2.0` for cockpit-expansion delivery
  - `0.2.5` for polish/hardening delivery

## Rules

- do not use `0.3.0` as an active standalone MCP release label in OSS or mirror surfaces
- do not let the root package version line drive standalone MCP release numbering
- before any push candidate, confirm this ledger against:
  - `npm view martin-loop version versions --json`
  - `npm view @martinloop/mcp version versions --json`
  - public GitHub `main`
  - local OSS source of truth
