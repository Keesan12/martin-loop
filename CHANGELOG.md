# Changelog

## [0.1.7] — 2026-05-20

### Changed
- Refresh public README and npm package copy for the `martin-loop@0.1.7` root package.
- Clarify the current `npx martin-loop` CLI, packaged demo flow, and `@martinloop/mcp@0.2.0` read-only cockpit surface.
- Add public README guardrails so stale version text and non-public workspace wording stay out of the package README.

## [0.1.5] — 2026-05-08

### Added
- **Context Integrity Pre-gate** — Scans user prompts and tool output for injection patterns before any attempt is admitted to the ADMIT phase. Detects authority inversion, instruction override, identity redefinition, and hidden command injection. Aborts with `human_escalation` lifecycle state on detection, with a signed artifact written to the run directory (`context-integrity-precheck.json`). Exported as `runContextIntegrityPrecheck` from `@martin/core`.

## [0.1.4] — 2025-04-25

- MCP server published as `@martinloop/mcp`
- Windows smoke test hardening
- One-line install docs updated

## [0.1.0] — Initial release

- Budget governance (maxUsd, softLimitUsd, maxIterations, maxTokens)
- Verifier gate
- 11-class failure taxonomy
- Safety leash (verifier commands, file scope, approval, secrets)
- Rollback evidence
- Context distillation
- JSONL run records
