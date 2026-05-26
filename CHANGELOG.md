# Changelog

## [0.2.5] — 2026-05-26

### Added
- **Stable cockpit line** — Promoted the public `@martinloop/mcp@0.2.5` surface with run triage, compact proof resources, and richer discovery guidance.
- **Run-store hardening** — Discovery and review flows now degrade cleanly when run-store entries or explicit `runsDir` paths are missing or unreadable.

### Changed
- **Release proof lane** — Synced root README, MCP release docs, package metadata, smoke scripts, and trusted-publishing workflows to the shipped `0.2.5` contract.

## [0.2.4] — 2026-05-25

### Added
- **Agent prompt pack** — Added the public `martin_start`, `martin_preflight`, `martin_triage`, `martin_resume`, `martin_prove`, and `martin_release_check` prompts plus compatibility aliases.
- **Prompt-pack docs** — Added guidance for when to use prompt-led kickoff, proof review, and release-check flows in agent hosts.

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
