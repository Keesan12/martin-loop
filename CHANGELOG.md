# Changelog

## [0.3.2]

### Fixed
- **`npx martin-loop` now reports the published CLI version deterministically** - doctor/version output no longer drifts when invoked from inside a monorepo workspace with local bins on path.
- **Public MCP release docs now reflect live registry truth** - standalone MCP baseline references are aligned to `@martinloop/mcp@0.3.1`.
- **Governed run gate parity is now consistent across CLI and MCP** - preflight receipts recorded without explicit path filters now satisfy run-gate validation correctly.

### Added
- **Public receipt specification for governed runs** - added a customer-facing receipt reference that documents receipt structure, trust boundaries, and replay expectations without internal-only language.

### Changed
- Root release docs now point to the `0.3.2` line with explicit claim-to-code language for governed workflow evidence.

## [0.3.1]

### Fixed
- **Public benchmark repro is deterministic from source** - benchmark eval and report commands now execute built runtime output with pre-build hooks, removing fragile local toolchain assumptions.
- **Public CLI now exposes a version command** - `martin-loop --version`/`version`/`-V` now return a clean version string for automation and operator checks.
- **Doctor version reporting now matches the public release line** - `doctor --json` now reports the root package version in `cliVersion` for release clarity.

### Changed
- Root benchmark helper scripts now route through workspace benchmark commands (`bench:build`, `bench:test`, `bench:eval`, `bench:report:ralphy`) for consistent docs, CI checks, and local reproduction.
- Public release notes and CLI docs now include explicit install/version verification before governed-run onboarding.

## [0.3.0]

### Added
- **`martin share --latest`** - the public CLI can now write a local share bundle for the latest governed run, including a redacted JSON receipt, a Markdown recap, and a proof-card SVG.

### Changed
- Root public docs now treat share receipts as a first-class part of the governed workflow instead of an internal follow-up step.
- Public release bookkeeping now reflects the live standalone MCP `0.3.0` baseline and keeps the root and MCP lines separate.

## [0.2.11]

### Fixed
- **`runs verify --latest` now works on the public CLI** - the persisted verification view now honors `--latest` the same way `dossier` and `runs get` already do, including when `--runs-dir` points at an explicit store.
- **Post-release selector parity is now aligned** - public phase guidance, release notes, and the shipped root package no longer disagree about the supported verification selector path.

## [0.2.10]

### Fixed
- **Verifier receipts now stay trustworthy** - `verification.completed` now reflects the MartinLoop-launched verifier only, with persisted step-by-step evidence for launch state, exit code, timeout state, and concise command output.
- **Contradictions are surfaced instead of hidden** - when adapter output says a tool or verifier failed before execution but MartinLoop’s own verifier passed, the run now keeps the pass result and records a warning/contradiction receipt instead of presenting a silent clean pass.
- **`--runs-dir` is consistent across the governed flow** - `doctor`, `start`, `preflight`, `run`, `dossier`, and `badge` now honor the same explicit runs root without relying on `MARTIN_RUNS_DIR`.
- **Public help is honest again** - `run --help` and `preflight --help` exit cleanly before any governed-flow checks, root-version reporting now uses the published `martin-loop` version, and `bench` is not part of the public `0.2.10` CLI surface while the public harness is being prepared.

### Changed
- CLI and MCP verification views now include verifier warnings plus step-level evidence, so operators can inspect what actually launched instead of trusting a single summary line.
- Badge generation now uses a lightweight persisted-run probe for readiness evidence, which keeps the default command responsive even when the local runs store is large.

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
