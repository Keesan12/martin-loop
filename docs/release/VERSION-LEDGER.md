# Version Ledger

This file is the canonical version map for release work. Do not push, tag, or publish from memory when the root `martin-loop` package and the standalone `@martinloop/mcp` package move on different lines.

## Root package: `martin-loop`

- live npm dist-tag `latest`: `0.2.11`
- live npm versions include: `0.1.0`, `0.1.1`, `0.1.2`, `0.1.3`, `0.1.4`, `0.1.5`, `0.1.6`, `0.1.7`, `0.1.8`, `0.2.0`, `0.2.1`, `0.2.2`, `0.2.3`, `0.2.4`, `0.2.5`, `0.2.6`, `0.2.7`, `0.2.8`, `0.2.9`, `0.2.10`, `0.2.11`, and a historical anomaly `1.3.0`
- public GitHub `main`: `0.2.11`
- current repo package manifest: `0.2.11`
- next root-package target version: derive from the approved release scope; do not assume from history alone
- release rule: treat the root package as its own public semver line and do not infer standalone MCP versioning from it

## Standalone MCP package: `@martinloop/mcp`

- live npm dist-tag `latest`: `0.2.7`
- live npm versions include: `0.1.1`, `0.1.2`, `0.1.3`, `0.1.4`, `0.2.0`, `0.2.5`, `0.2.7`
- public GitHub `main`: `0.2.7`
- current repo package manifest: `0.2.7`
- public scheduled release train:
  - `0.1.4` for operator foundation
  - `0.2.0` for cockpit expansion
  - `0.2.5` for the public MCP package line
  - `0.2.7` for usability and review hardening

## Public Release Labels

The public MCP train labels are:

- `0.1.4` operator foundation
- `0.2.0` cockpit expansion
- `0.2.5` public MCP package line
- `0.2.7` usability and review release

## Rules

- do not use `0.3.0` as an active standalone MCP release label in OSS or mirror surfaces
- do not let the root package version line drive standalone MCP release numbering
- do not use public MCP release docs to imply capabilities that are not shipped from this repo
- keep non-public operational details out of OSS release docs
- before any push candidate, confirm this ledger against:
  - `npm view martin-loop version versions --json`
  - `npm view @martinloop/mcp version versions --json`
  - public GitHub `main`
  - current repo package manifests
