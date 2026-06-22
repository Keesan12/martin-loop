# Changelog

## [Unreleased]

## [0.3.8]

### Fixed
- **Budget circuit breaker** — the streaming usage inspector previously only matched `type=assistant` events from Claude's `stream-json` output. If the event shape changed, the inspector silently did nothing and the subprocess ran unguarded. Now matches usage on any event, checks `total_cost_usd` mid-stream, applies an 80% safety margin, and falls back to a byte-ceiling kill switch when no usage events arrive at all.
- **Shell operators in verify commands** — `bun run lint && bun run test` was tokenized literally (`["bun", "run", "lint", "&&", ...]`), which always failed. Commands with `&&`, `||`, `;`, or `|` now route through the platform shell.

### Added
- **Engine auto-discovery** — if `claude`, `codex`, or `gemini` isn't on PATH, the CLI searches common install directories (npm global, AppData, homebrew, `.local/bin`, nvm, scoop) before reporting unavailable. When truly missing, prints a copy-pasteable install command for the current platform.
- **Diagnostic hints on failed attempts** — `LoopAttempt.diagnosticHint` carries specific context into the next attempt's prompt: which tool is missing, which module failed to resolve, how many assertions broke. Replaces the generic "verification failed" message.
- **Git retry and fallback** — git operations retry once after 500ms (handles `.git/index.lock` contention). `git restore` falls back to `git checkout` on failure.

### Changed
- **Invalid CLI args default instead of crashing** — unknown `--profile` falls back to `minimal` with a warning. Invalid `--run-scan-limit` clamps to 50.

## [0.3.6]

### Fixed
- **Root CLI version reporting now matches the installed package** - the packaged CLI manifest now uses the `martin-loop` package version, so `npx -y martin-loop@0.3.6 --version` reports `0.3.6`.
- **Release guard now checks root/version parity** - root release validation fails if the vendored CLI manifest version drifts from the root package version again.

## [0.3.5]

### Added
- **CLI-style proof receipts** - `share --latest` proof cards now render as dark terminal receipts with spend, budget, verifier, integrity, timeline, and evidence-boundary lines.
- **Public proof receipt example** - README and receipt docs now include a real governed run receipt showing `$0.51` spend against a `$3.00` budget with signed integrity and an explicit evidence boundary.
- **Proof receipt design guardrails** - Public agent docs and tests now block rounded-card, blue-palette, gradient, and inflated-proof regressions in proof-card output.
- Restored pre-`0.2.8` public narrative sections in README (updated to current `0.3.4` behavior), including `See It In Action`, `Ralph-Style Loops`, CLI common options, and footer trust CTA.
- Added canonical public failure taxonomy reference: [docs/oss/FAILURE-TAXONOMY-14.md](./docs/oss/FAILURE-TAXONOMY-14.md).
- Added public historical diff note for `v0.2.7 -> v0.2.8`: [docs/oss/PRE-028-PUBLIC-SURFACE-DIFF.md](./docs/oss/PRE-028-PUBLIC-SURFACE-DIFF.md).

### Changed
- Root release docs now point to the `0.3.5` proof receipt line and keep the root package separate from the standalone `@martinloop/mcp` release line.

## [0.3.4]

### Fixed
- **Allow/deny path policy now fails closed on traversal and absolute patterns** - governed preflight/run rejects unsafe `--allow-path` and `--deny-path` values before execution.
- **Run verification now emits explicit integrity verdict classes** - `runs verify` classifies receipt problems as `tampered_payload`, `missing_integrity_material`, or `schema_unknown_fields`.
- **Non-canonical run selectors now fail fast** - `runs verify --file` rejects selectors outside the configured runs root and points operators to canonical selector forms.
- **OpenAI hosted preflight now blocks missing auth with actionable guidance** - missing `MARTIN_OPENAI_API_KEY` on hosted endpoints is now a hard blocker with model/quota hints.
- **MCP scope errors now guide operators to valid alternatives** - unsupported `--scope local` host errors now include direct `user/project` and Claude-local alternatives.

## [0.3.3]

### Added
- **Guided first-run entrypoint** - `martin-loop start` is now the default onboarding command, with `martin-loop tour` as a compatibility alias.

### Changed
- **Execution-first governed run startup** - `run` now auto-checks doctor/session-start/preflight prerequisites before enforcing the local gate, so healthy environments proceed without extra manual setup steps.
- **Install prompt and docs clarity** - postinstall guidance, help output, and quickstart language now point to deterministic `npx -y martin-loop@latest ...` command paths.
- **Release docs naming and readability** - public release notes now frame this line as reliability hardening with user-facing language.

### Fixed
- **Packaged smoke reliability coverage** - release validation now catches regressions where `--unsafe-allow-unguarded-run` could incorrectly fail through receipt-gate policy behavior in packaged installs.
- **Command-center compatibility** - `phase session-start` now resolves to the documented session-start compatibility path.

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
