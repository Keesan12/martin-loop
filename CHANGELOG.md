# Changelog

## [0.2.3] — 2026-05-26

### Added
- **Context Diet release surface** — Promote `npx martin-loop dossier --latest` as the compact context packet for handoffs: summary, proof card, budget status, verifier evidence, rollback or artifact evidence, and the next safe action.

### Changed
- Refresh the public README, OSS quickstart, and CLI-facing docs so operators and agents can pass smaller evidence-rich run context without digging through raw logs.
- Keep the standalone `@martinloop/mcp` package on `0.2.0` for this slice; `0.2.3` is a root `martin-loop` release only.

## [0.2.2] — 2026-05-24

### Added
- **Persisted-run triage in the public release surface** — Promote `npx martin-loop triage` as the fastest way to rank saved runs by failure category, budget pressure, human escalation, and missing verification evidence.

### Changed
- Refresh the public README, quickstart, CLI docs, and release notes so the `0.2.2` package surface clearly documents triage-first operator review and degraded run-store warnings.
- Keep the standalone `@martinloop/mcp` package on `0.2.0` for this slice; `0.2.2` is a root `martin-loop` release only.

## [0.2.1] — 2026-05-23

### Added
- **Local MCP install profiles** — Add `minimal`, `diagnostic`, and `full-local` profile generation for `martin mcp print-config` and `martin mcp install`, with `minimal` as the default local stdio profile.
- **Read-only-by-default host setup** — Document the default allow-list so local MCP installs start with setup, preflight, run listing, triage, and dossier review before exposing execution.

### Changed
- Refresh the public README, quickstart, CLI docs, and MCP host guidance so `0.2.1` clearly shows how to choose the right local MCP profile for Codex, Claude Code, Gemini, and generic hosts.
- Keep the root `martin-loop` package on the `0.2.x` line while leaving `@martinloop/mcp@0.2.0` unchanged for this slice.

## [0.2.0] — 2026-05-22

### Added
- **First-value local CLI path** — Add `npx martin-loop doctor` for local readiness checks and `npx martin-loop dossier --latest` for receipt-style follow-up after a run.
- **No-spend demo proof flow** — Document the fastest local path from install to proof: doctor, demo workspace, stubbed run, and dossier review.

### Changed
- Promote the root `martin-loop` package to the `0.2.x` line while keeping the `0.1.8` Red-Blue Testing and public git-surface guard as baseline features, not new `0.2.0` launch claims.
- Refresh the packed README and quickstart so the published npm surface shows the `doctor`, no-spend demo, and `dossier --latest` flow directly.

## [0.1.8] — 2026-05-21

### Added
- **Red-Blue Testing** — Adversarial probe suite that runs before a patch is accepted. Detects patch-level cheating across six deterministic probes: assertion deletion (T01), silent export reverts (T02), manifest scope creep (T03), context directory poisoning (T07), budget self-reporting (T10), and grounding evasion pragmas (T11). Runs in three risk tiers — `baseline` (6-probe sweep), `high_risk` (paranoid 12-probe scan), and `release_critical` (paranoid scan + optional Haiku model call). A single `block`-severity finding rejects the patch; `warn` findings are recorded but do not block. Exported as `runRedPhase`, `shouldAcceptPatch`, `buildRedFindings`, and `resolveRedBudgetPolicy` from `@martin/core`.

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
