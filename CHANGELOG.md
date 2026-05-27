# Changelog

## [0.2.6] - 2026-05-27

### Changed

- Strengthened verifier-command blocking for destructive command patterns that should be rejected before a run starts.
- Expanded prompt and verifier-output integrity checks so high-signal override attempts are less likely to re-enter the loop.
- Improved secret redaction, safe-path validation, model-aware budget pricing, and grounding-cache handling.
- Updated the root package documentation so the CLI and SDK surface is easier to evaluate and safer to adopt.

## [0.2.5] - 2026-05-26

### Added

- Added triage views for saved MartinLoop runs so operators can review persisted records faster.
- Added compact proof resources for `@martinloop/mcp` so hosts can inspect saved run evidence with smaller responses.

### Changed

- Inspection flows can now skip unreadable saved entries and continue with warnings.
- Tightened packaged host setup guidance for Codex, Claude, Gemini, and generic MCP hosts.

## [0.2.4] - 2026-05-25

### Added

- Added MCP prompt support and expanded discovery metadata for host integrations.

## [0.2.3] - 2026-05-25

### Added

- Added compact receipt and dossier flows for reviewing persisted runs.

### Changed

- Improved run-record summaries and next-step recommendations for context-constrained agents.

## [0.2.2] - 2026-05-24

### Added

- Added run triage for persisted MartinLoop records.

### Changed

- Improved behavior when a saved run entry is unreadable, so triage can continue and report a warning.

## [0.2.1] - 2026-05-23

### Added

- Added local MCP install and config generation profiles for common hosts.

### Changed

- Improved host-specific guidance for Codex, Claude, Gemini, and generic MCP wrappers.

## [0.2.0] - 2026-05-22

### Added

- Added the first public CLI first-value path for governed agent runs, demo setup, and evidence review.

### Changed

- Improved package boundaries and public validation checks.

## [0.1.5] - 2026-05-08

### Added

- Added early public CLI and runtime packaging.

## [0.1.4] - 2025-04-25

### Added

- Added the initial MCP server package foundation.

## [0.1.0] - Initial release

### Added

- Initial MartinLoop runtime packages, contracts, adapters, and CLI surface.
