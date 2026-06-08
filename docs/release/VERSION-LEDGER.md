# Version Ledger

This file is the canonical version map for release work. Do not push, tag, or publish from memory when the root `martin-loop` package and the standalone `@martinloop/mcp` package move on different lines.

## Public Baselines

- root public baseline: `0.2.11`
- standalone MCP public baseline: `0.3.0`
- current in-repo root release line: `0.3.0`
- next planned root follow-on: `0.3.1`
- next planned standalone release: `0.3.1`

## Active 0.3.x Train

- `0.3.0` adoption release
- `0.3.1` review and handoff release
- `0.3.2` opt-in execution controls

## Release Rules

- treat the root `martin-loop` package and the standalone `@martinloop/mcp` package as separate public version lines
- keep release notes, README links, and slice maps aligned to the exact version under validation
- keep private continuity notes out of public-facing release packets and docs
- before any push candidate, confirm this ledger against:
  - `npm view martin-loop version versions --json`
  - `npm view @martinloop/mcp version versions --json`
  - public GitHub `main`
  - the exact repo and branch under validation

## Current Internal Harvest Status

- active private OSS integration branch: `codex/oss-m2-merge-ready-mainline`
- repair lineage supersedes the earlier closed PR lanes for `oss-audit-recovery-sync` and `oss-m2-merge-ready`
- release-memory note for this chain: [OSS-M2-HARVEST-HANDOFF.md](./OSS-M2-HARVEST-HANDOFF.md)
- routing rule: use the repaired mainline branch as the current truth candidate for validation, trust classification, and later `0.3.1` extraction
