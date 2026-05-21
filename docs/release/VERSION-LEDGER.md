# Version Ledger

This file is the canonical version map for release work. Do not push, tag, or publish from memory when the root `martin-loop` package and the standalone `@martinloop/mcp` package move on different lines.

## Root package: `martin-loop`

- live npm dist-tag `latest`: `0.1.7`
- live npm versions include: `0.1.0`, `0.1.1`, `0.1.2`, `0.1.3`, `0.1.4`, `0.1.5`, `0.1.6`, `0.1.7`, and a historical anomaly `1.3.0`
- public GitHub `main`: `0.1.7`
- local OSS integrated tree: `0.1.7`
- release rule: treat the root package as a separate `0.1.x` line and do not infer standalone MCP versioning from it

## Standalone MCP package: `@martinloop/mcp`

- live npm dist-tag `latest`: `0.2.0`
- live npm versions include: `0.1.1`, `0.1.2`, `0.1.3`, `0.1.4`, `0.2.0`
- public GitHub `main`: `0.2.0`
- local OSS integrated tree: `0.2.5`
- public scheduled release train:
  - `0.1.4` for operator foundation
  - `0.2.0` for cockpit expansion
  - `0.2.5` for the stable cockpit line

## Tier Boundary

- Free / OSS is the public package lane in this repo: root `martin-loop` on `0.1.x` plus the standalone `@martinloop/mcp` train.
- Pro, Growth, Enterprise, and Internal are private paid-tier names. They do not inherit semver from either public OSS package.
- The public MCP train labels are:
  - `0.1.4` operator foundation
  - `0.2.0` cockpit expansion
  - `0.2.5` stable cockpit line

## Rules

- do not use `0.3.0` as an active standalone MCP release label in OSS or mirror surfaces
- do not let the root package version line drive standalone MCP release numbering
- do not use public MCP release docs to imply promotion of the private Pro, Growth, Enterprise, or Internal tiers
- do not use public MCP release docs to imply promotion of the private Pro remote MCP beta or principal-aware remote config lanes
- keep private control-plane, autonomy, and router internals out of OSS release docs
- before any push candidate, confirm this ledger against:
  - `npm view martin-loop version versions --json`
  - `npm view @martinloop/mcp version versions --json`
  - public GitHub `main`
  - local OSS source of truth
