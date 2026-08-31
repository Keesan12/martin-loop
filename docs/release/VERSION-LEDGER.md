# Version Ledger

This file is the release source of truth for package/version mapping in this repo. Check it before you cut a branch, update docs, or talk about npm state.

## Root package: `martin-loop`

- live npm dist-tag `latest`: `0.5.5`
- live public GitHub release: `v0.5.5`
- live public baseline in this train: `0.5.5`
- root public baseline: `0.5.5`
- releases consumed since the original `0.2.8` launch:
  - `0.2.9` fixed proof-run classification, Windows `.cmd` resolution, and public provider defaults
  - `0.2.10` tightened verifier evidence, `--runs-dir` consistency, and public help output
  - `0.2.11` fixed `runs verify --latest` selector parity in the public CLI
  - `0.3.3` guided first-run entrypoint, execution-first governed run startup
  - `0.3.4` allow/deny path policy, run verification integrity verdicts, OpenAI auth preflight
  - `0.3.5` CLI-style proof receipts, public failure taxonomy
  - `0.3.6` CLI version reporting parity, release guard version check
  - `0.3.8` budget circuit breaker fix, engine auto-discovery, verification diagnostics, resilience defaults
  - `0.3.9` Pre Work Burn tracking, routing economics, route classification, cost-per-outcome
  - `0.3.10` Codex config fix, subpath exports, CLI command restoration
  - `0.3.11` auto-governance (estimate tool, governance-status resource, host-specific hooks), MCP isolation fix, budget cap hardening, 68 audit-ready tests
  - `0.3.12` hard governance enforcement, memory store, trace wiring
  - `0.3.13` autonomous model selection, portable governance hooks, 28 new tests
  - `0.3.14` Electron/IDE Node conflict fix — resolveSystemNode() finds system node.exe, not Electron's bundled Node
  - `0.3.15` martin mode, martin clean, preflight gate objective-hash removed, session-start optional when estimate present
  - `0.3.16` governance hooks on re-install, gate fires before engine check, estimate persistence, OpenAI 429/5xx retry
  - `0.5.0` fail-closed verification authority, workspace-bound evidence, native install, and MCP lifecycle expansion
  - `0.5.1` Governed Run Plan, Verified Handoff, cost provenance, grounding truth, presentation hardening, and MCPB distribution
  - `0.5.2` aligned preflight readiness with the immediately following run admission gate
  - `0.5.3` capability-driven Codex execution and aligned public package metadata
  - `0.5.4` provider-neutral governed autonomy and exact-binary Codex negotiation
  - `0.5.5` governed-autonomous execution with deterministic install metadata
  - `0.5.6` portable MCP package validation, read-only Arcade resources, hosted sync contract alignment, and permanent release-authority gates
  - `0.5.7` release tooling, OSS boundary, and packaged MCP hardening
- current in-repo root release target: `0.5.8` (pending publication)
- next planned root follow-on: not scheduled

## Standalone package: `@martinloop/mcp`

- live npm dist-tag `latest`: `0.5.5`
- live public GitHub release: `mcp-v0.5.5`
- live public baseline in this train: `0.5.5`
- standalone MCP public baseline: `0.5.5`
- official MCP Registry version: `0.5.5` (verified)
- live MCPB baseline: `0.5.5`
- live MCPB SHA-256: `6f3da0e77978a47bbc7ffec8db6b3a42bff2cb7e8642372523eab53af79c05d2`
- live MCPB size: `8,113,133` bytes
- current in-repo standalone release target: `0.5.8` (pending publication)
- current in-repo MCPB release target: `0.5.8` with manifest schema `0.3` (pending publication)
- next planned standalone release: not scheduled

## Release rules

- Live public baselines describe artifacts that actually exist. In-repo targets may advance before publication and must remain marked pending until trusted publishing succeeds.
- The `0.5.6` train aligns the root package, standalone MCP package, plugin metadata, and MCPB product version at `0.5.6`. MCPB manifest schema remains `0.3`.
- Do not infer standalone MCP release state from the root package, or the other way around.
- Public release notes must be written for customers and evaluators, not for internal operators.
- Public-facing examples, screenshots, README copy, and changelog entries must stay free of internal repo names, absolute system paths, private branch names, or process noise.
- Publish only through GitHub Actions trusted publishing / OIDC.
- A release is not complete until npm packages, GitHub releases, release assets, checksums, and applicable registry listings have been verified live.

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
