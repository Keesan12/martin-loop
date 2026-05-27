# Changelog

## [0.2.6] — 2026-05-28

### Added
- **Audit remediation closure** — Added the root `0.2.6` public release notes for the completed OSS security and correctness follow-up slice.

### Changed
- **Runtime hardening** — Closed the remaining root-package remediation items across verifier-command blocking, context-integrity coverage, secret redaction, safe-path validation, pricing, and cache invalidation.
- **Release proof lane** — Synced the root package version, public README surfaces, quickstart docs, and root release guard to the shipped `0.2.6` contract while keeping `@martinloop/mcp` on `0.2.5`.

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

## [0.2.3] — 2026-05-25

### Added
- **Compact Context Diet receipts** — Added latest summary, proof-card, budget-status, verifier-evidence, rollback-evidence, and next-step surfaces for low-context follow-up.

### Changed
- **Receipt docs** — Synced the public README and OSS guides to the compact dossier and receipt workflow.

## [0.2.2] — 2026-05-24

### Added
- **Run triage lane** — Added the public persisted-run triage workflow with urgency-first ranking and warning-aware review.

### Changed
- **Degraded run-store handling** — Unreadable or conflicting persisted verification evidence now surfaces warnings instead of breaking the whole review flow.

## [0.2.1] — 2026-05-23

### Added
- **MCP install profiles** — Added generated `starter` and `full` host-config profiles plus public guidance for manual read-only allow-lists.

### Changed
- **Host setup docs** — Synced Codex, Claude, Gemini, and generic MCP install guidance to the shipped public CLI commands.

## [0.2.0] — 2026-05-22

### Added
- **First-value OSS lane** — Added the public `doctor`, `demo`, and `dossier --latest` path for getting from install to proof quickly.

### Changed
- **OSS quickstart surface** — Synced the root package README and quickstart docs to the governed local demo and receipt workflow.

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
