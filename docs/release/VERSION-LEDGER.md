# Version Ledger

This file is the canonical version map for release work. Do not push, tag, or publish from memory when the root `martin-loop` package and the standalone `@martinloop/mcp` package move on different lines.

## Root package: `martin-loop`

- live npm dist-tag `latest`: `0.2.7`
- live npm versions include: `0.1.0`, `0.1.1`, `0.1.2`, `0.1.3`, `0.1.4`, `0.1.5`, `0.1.6`, `0.2.0`, `0.2.1`, `0.2.2`, `0.2.3`, `0.2.4`, `0.2.5`, `0.2.6`, `0.2.7`, and a historical anomaly `1.3.0`
- public GitHub `main`: `0.2.7`
- local OSS integrated tree target after public sync: `0.2.7`
- release candidate: `0.2.8` local command center
- next root-package release candidate: `0.2.8` after explicit public approval
- release rule: treat the root package as its own public semver line and do not infer standalone MCP versioning from it

## Standalone MCP package: `@martinloop/mcp`

- live npm dist-tag `latest`: `0.2.5`
- live npm versions include: `0.1.1`, `0.1.2`, `0.1.3`, `0.1.4`, `0.2.0`, `0.2.5`
- public GitHub `main`: `0.2.5`
- local OSS integrated tree: `0.2.5`
- public scheduled release train:
  - `0.1.4` for operator foundation
  - `0.2.0` for cockpit expansion
  - `0.2.5` for the public MCP package line

## Tier Boundary

- Free / OSS is the public package lane in this repo: root `martin-loop` on the `0.2.x` line plus the standalone `@martinloop/mcp` train.
- Pro, Growth, Enterprise, and Internal are private paid-tier names. They do not inherit semver from either public OSS package.
- The public MCP train labels are:
  - `0.1.4` operator foundation
  - `0.2.0` cockpit expansion
  - `0.2.5` public MCP package line

## Rules

- do not use `0.3.0` as an active standalone MCP release label in OSS or mirror surfaces
- do not let the root package version line drive standalone MCP release numbering
- do not use public MCP release docs to imply promotion of the private Pro, Growth, Enterprise, or Internal tiers
- do not use public MCP release docs to imply promotion of private hosted or team-only capabilities
- keep server-side services, organization policy, and advanced routing internals out of OSS release docs
- before any push candidate, confirm this ledger against:
  - `npm view martin-loop version versions --json`
  - `npm view @martinloop/mcp version versions --json`
  - public GitHub `main`
  - local OSS source of truth

## Current Internal Harvest Status

- active private OSS integration branch: `codex/oss-m2-merge-ready`
- integration base used for the merge-ready branch: `08b09e1`
- verified Milestone 2 wave chain:
  - wave 1: `07f7f6d`
  - wave 2: `31c70b0`
  - wave 3: `da695e0`
  - wave 4: `0092228`
- release-memory note for this chain: [OSS-M2-HARVEST-HANDOFF.md](./OSS-M2-HARVEST-HANDOFF.md)
- routing rule: use `codex/oss-m2-merge-ready` as the candidate source for later trust classification and `0.3.1` routing; do not reuse stale non-stacked wave branches or placeholder release-prep branches
