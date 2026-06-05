# Changelog

## [0.2.8]

### Added
- **Native phase command-center flow** - Adds local `martin-loop phase status`, `martin-loop phase contract`, `martin-loop phase preflight`, `martin-loop phase run`, and `martin-loop session-start` commands.
- **Local phase contracts** - Converts local phase state into an explicit MartinLoop run contract with objective, allowed paths, blocked paths, verifier commands, budget, risk, and approval posture.
- **Safe session start** - Shows the latest local run state, phase state, recommended next action, and common command hints without executing work.
- **Built-in onboarding** - Adds `martin-loop start`, `martin-loop guide`, and `martin-loop tour` so the install flow, command tour, and MCP bootstrap path live inside the product.

### Safety
- `martin-loop phase preflight` and `martin-loop phase run` are dry-run by default and require `--execute` before they call the normal MartinLoop preflight/run path.
- Missing phase state, missing allowed paths, or missing verifiers fail closed with `contract_requires_approval`.
- Run-store inspection is bounded to recent run directories so large local histories do not stall session startup.
- `martin-loop run` now hard-blocks by default until MartinLoop has recent local `doctor`, session, and `preflight` receipts for the same repo and task.

## [0.1.5] - 2026-05-08

### Added
- **Context Integrity Pre-gate** - Scans user prompts and tool output for injection patterns before any attempt is admitted to the ADMIT phase. Detects authority inversion, instruction override, identity redefinition, and hidden command injection. Aborts with `human_escalation` lifecycle state on detection, with a signed artifact written to the run directory (`context-integrity-precheck.json`). Exported as `runContextIntegrityPrecheck` from `@martin/core`.

## [0.1.4] - 2025-04-25

- MCP server published as `@martinloop/mcp`
- Windows smoke test hardening
- One-line install docs updated

## [0.1.0] - Initial release

- Budget governance (maxUsd, softLimitUsd, maxIterations, maxTokens)
- Verifier gate
- 11-class failure taxonomy
- Safety leash (verifier commands, file scope, approval, secrets)
- Rollback evidence
- Context distillation
- JSONL run records
