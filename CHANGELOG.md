# Changelog

## [0.2.9]

### Fixed
- **No-spend proof runs now complete honestly** - `martin-loop run ... --proof` no longer misclassifies a clean verifier-only pass as `no_code_change`, which previously cascaded into a false `budget_exit`.
- **Portable Windows Codex execution** - Windows command resolution now handles npm-style `.cmd` shims correctly, including real `codex.cmd` and verifier commands launched through npm wrappers.
- **Hosted OpenAI defaults** - `--engine openai` now targets the hosted OpenAI endpoint by default, so local proofs do not require `MARTIN_OPENAI_BASE_URL` just to avoid a localhost misroute.
- **Claude live runs honor provider permissions again** - the public Claude adapter no longer force-adds `--dangerously-skip-permissions` on live governed runs.

### Changed
- Public CLI guidance now consistently uses `martin-loop` in help, tour, onboarding, workflow receipts, and MCP config hints.
- The public root tarball no longer exposes the vendored internal CLI bin surface inside `dist/vendor/cli/package.json`.

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
