# AGENTS.md

## Project Overview
- Martin Loop ships both a repo-wide OSS/RC surface and a standalone publishable MCP package at `packages/mcp`.

## Build and Verify
- For MCP-only changes, run `pnpm --filter @martinloop/mcp test`, `pnpm --filter @martinloop/mcp build`, and `pnpm --filter @martinloop/mcp smoke:pack`.
- For release-surface or packaging changes that could affect CI, run `pnpm release:matrix:local`.

## Release Defaults
- Reload the release-memory docs before making MCP version or publish-path assumptions: `docs/release/VERSION-LEDGER.md`, `docs/release/MCP-DELIVERY-SLICE-MAP.md`, and `docs/release/MCP-PUBLISHING.md`.
- For public OSS releases, GitHub Actions is the required publish authority for both npm and GitHub releases. Use only tag-driven or workflow-dispatch GitHub Actions paths unless Keesan explicitly approves an exception after GitHub Actions is shown to be unavailable.

## Operating Memory Schema
- Treat remembered operating constraints as incomplete unless they include all three parts:
- `Rule = policy`
- `Guardrail = enforcement`
- `Verification = proof`

### Release-memory activation
- Rule: do not start OSS release work in blank-slate mode.
- Guardrail: read the release-memory docs and the closest instruction layer before touching workflows, tags, versions, or publish paths.
- Verification: the first execution step and release lane must visibly follow those docs instead of ad hoc assumptions.

### Browser cleanup
- Rule: if browser tabs are used during repo work, cleanup is part of done.
- Guardrail: before claiming completion on browser-involved work, explicitly check whether extra tabs opened for the run should be closed.
- Verification: either the extra tabs are closed, or the final status states why they were intentionally left open.

### Mirror parity exception
- Rule: treat `ML_Core_OSS_Internal` as mirroring local truth from `martin-loop_OSS_CORE`, with one explicit preserved exception.
- Guardrail: ignore `old/pre-sync-2026-05-18` during parity discussions, drift checks, and sync decisions unless Keesan explicitly asks to revisit that archive.
- Verification: parity summaries and sync work should not flag `old/pre-sync-2026-05-18` as drift or ask for it to be explained again.

## MCP Registry Guardrails
- Do not call `packages/mcp` registry-ready unless `packages/mcp/package.json` includes `mcpName` and `packages/mcp/server.json` exists with matching `name`, `version`, and npm package `identifier`.
- npm publication happens before official MCP Registry publication.
- The official MCP Registry flow runs from `packages/mcp`: `mcp-publisher login github`, then `mcp-publisher publish`.
- The current official registry server name for the public MCP package is `io.github.Keesan12/martin-loop`.
