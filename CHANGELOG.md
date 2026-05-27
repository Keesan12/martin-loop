# Changelog

## [0.2.7] - 2026-05-27

### Changed

- Republished the root package so npm and GitHub now show the cleaned README, package metadata, and release summary from the public repo.
- This patch does not change MartinLoop runtime behavior.

## [0.2.6] - 2026-05-27

### Changed

- Strengthened verifier-command blocking for destructive command patterns that should be rejected before an agent run starts.
- Expanded prompt and verifier-output integrity checks so high-signal override attempts are more likely to be caught before they re-enter the loop.
- Improved secret redaction, safe-path validation, model-aware budget pricing, and grounding-cache handling.
- Updated the root package documentation so the CLI and SDK surface is easier to evaluate and safer to adopt.

## [0.2.5] - 2026-05-26

### Added

- Added triage views for saved MartinLoop runs so operators can review persisted records faster.
- Added compact proof resources for the standalone MCP package so hosts can inspect saved run evidence with smaller responses.

### Changed

- Inspection flows can now skip unreadable saved entries and continue with warnings.
- Tightened packaged host setup guidance for Codex, Claude, Gemini, and generic MCP hosts.

## [0.2.4] - 2026-05-25

### Added

- Added MCP prompt support for common guided workflows such as kickoff, triage, resume, proof review, and release checks.
- Expanded discovery metadata so hosts can identify the surfaced MartinLoop capabilities more reliably.

## [0.2.3] - 2026-05-25

### Added

- Added compact receipt and dossier flows for reviewing a governed run without digging through raw logs.

### Changed

- Improved run summaries and next-step recommendations so context-constrained agents and operators can review results more efficiently.

## [0.2.2] - 2026-05-24

### Added

- Added triage for persisted MartinLoop runs so operators can rank saved runs by urgency and missing evidence.

### Changed

- Saved run review now reports warnings for unreadable entries instead of failing outright.

## [0.2.1] - 2026-05-23

### Added

- Added local MCP install and config generation support for common hosts.

### Changed

- Improved host-specific guidance for Codex, Claude, Gemini, and generic MCP wrappers so setup is easier to follow.

## [0.2.0] - 2026-05-22

### Added

- Added the first public CLI path for governed runs, including readiness checks, demo setup, and evidence review.

### Changed

- Improved package boundaries and validation checks for the public root package.

## [0.1.5] - 2026-05-08

### Added

- Added early public CLI and runtime packaging.

## [0.1.4] - 2025-04-25

### Added

- Added the initial MCP server package foundation.

## [0.1.0] - Initial release

### Added

- Initial MartinLoop runtime packages, contracts, adapters, and CLI surface.
