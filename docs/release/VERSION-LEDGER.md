# Version Ledger

This file is the release source of truth for package/version mapping in this repo. Check it before you cut a branch, update docs, or talk about npm state.

## Root package: `martin-loop`

- live npm dist-tag `latest`: `0.5.1`
- live public GitHub release: `v0.5.1`
- live public baseline in this train: `0.5.1`
- root public baseline: `0.5.1`
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
  - `0.3.18` root release smoke and release-surface fixes
  - `0.3.19` governed workspace-root config resolution, public Codex integration truth, OSS surface hygiene
  - `0.4.0` receipt-first share ledgers, receipt-default sharing, MCP discovery updates, and release-surface guards
  - `0.4.1` CI preflight receipt consistency and receipt-first trust surfaces
  - `0.4.2` error normalization and Codex launch diagnostics
  - `0.4.3` start-budget consistency and execution-bound preflight reuse
  - `0.4.4` model-specific pricing, cache-aware accounting, and streaming budget enforcement
  - `0.4.5` MartinLoop Arcade for interactive governed runs
  - `0.5.0` fail-closed verification authority, workspace-bound evidence, native install, execution-surface hardening, and MCP lifecycle expansion
- current in-repo root release target: `0.5.1` (released publicly)
- next planned root follow-on: not scheduled

## Standalone package: `@martinloop/mcp`

- live npm dist-tag `latest`: `0.5.1`
- live public GitHub release: `mcp-v0.5.1`
- live public baseline in this train: `0.5.1`
- standalone MCP public baseline: `0.5.1`
- current in-repo standalone release target: `0.5.1` (released publicly)
- live MCPB baseline: `0.5.1`
- current in-repo MCPB release target: `0.5.1` with manifest schema `0.3` (released publicly)
- next planned standalone release: not scheduled

## Release rules

- This release aligns the root package, standalone MCP package, and MCPB product version at `0.5.1`; later lines may move independently.
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
