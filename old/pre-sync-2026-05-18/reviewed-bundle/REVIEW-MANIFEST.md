# Review Bundle Classification

Source bundle: `C:\Users\Gobi\Downloads\GOBI TO REVIEW-20260421T170632Z-3-001\GOBI TO REVIEW`

This folder contains repo-local review copies. The original Downloads folder was not modified.

## Repo Truth Used

- Public package: `martin-loop` version `0.1.2`
- Current config file: `martin.config.yaml`
- Current failure taxonomy: 11 `FailureClass` values in `@martin/contracts`
- Current audit surface: JSONL loop records and optional persisted run artifacts, not Ed25519 signed receipts
- Current benchmark commands: `pnpm --filter @martin/benchmarks ...`, not `bun run benchmark`
- Current public CLI: `run`, `inspect`, `resume`, plus a `bench` redirect; no shipped `explain`, `audit`, or `doctor` commands
- Current budget language: budget governance, preflight, and lifecycle exits; do not claim a guaranteed public-facing hard subprocess kill

## Folder Meanings

- `good-to-go/`: usable assets after review and, where needed, correction.
- `way-off/`: original assets whose claims are too stale or risky for public use without full rewrite.
- `needs-rewrite/`: reserved for future partial rewrites.
- `accepted-true/`: archival copy of the two files that arrived already accepted from the source bundle's `Reviewed\Good To go` folder.
- `not-accepted-false/`: now empty; original false files were moved into `way-off/`.

## Good To Go

| File | Source | What changed |
|---|---|---|
| `README.md` | Current repo README | Replaced stale bundle README with the current accurate repo README. |
| `phase3c-sidesidebyside-demo.html` | Current repo asset | Replaced stale bundle copy with the current repo demo copy. |
| `cli-animated.svg` | Source bundle `Reviewed\Good To go` | Accepted as-is after stale-claim scan. |
| `cli-animation-gif-ready.html` | Source bundle `Reviewed\Good To go` | Accepted as-is after stale-claim scan. |
| `cli-scenarios.html` | Source bundle `Reviewed\Good To go` | Patched hard-kill/subprocess-termination wording to budget-governance wording. |
| `cli-static.svg` | New corrected asset | Recreated with current `martin.config.yaml`, verifier, JSONL record, and inspect flow. |
| `benchmark-consolidated.html` | Rewritten asset | Rebuilt as a current validation-surface report using `pnpm` commands and RC gates. |
| `claims-spreadsheet.html` | Rewritten asset | Rebuilt as a conservative claims register with cleared, careful, and do-not-use categories. |
| `competitor-benchmark.html` | Rewritten asset | Rebuilt as a field-position page focused on current capability surfaces. |
| `dashboard.html` | Rewritten asset | Rebuilt as a current operator snapshot using repo validation and package status. |
| `feature-showcase-updated.html` | Rewritten asset | Rebuilt as a current feature showcase. |
| `feature-table.html` | Rewritten asset | Rebuilt as a current feature reference. |
| `github-hero-v2.svg` | Rewritten asset | Rebuilt as a clean terminal-style SVG using current config and JSONL record language. |
| `phase3a-architecture.html` | Rewritten asset | Rebuilt around current runtime layers and persistence. |
| `phase3b-leash-14classes.html` | Rewritten asset | Rebuilt around current safety leash behavior and 11 failure classes while preserving the filename. |
| `README-github.md` | Rewritten asset | Rebuilt as a GitHub-ready README using current package, CLI, config, and validation commands. |
| `deck-v1-full.html` | Rewritten asset | Rebuilt as a short current-truth HTML deck. |

## Way Off

These are the remaining files that still need rebuilds or non-text regeneration.

| File | Main issue |
|---|---|
| `deck-v1-full.docx` | 14-class, Ed25519, old benchmark, `martin.policy.yaml`, and unsupported command claims. |
| `martinloop-business-plan.html` | Many stale version, signed-proof, benchmark, and unsupported CLI/product claims. |
| `MartinLoop-SEO-AEO-Pack.docx` | 14-class, Ed25519, old benchmark, `bun run benchmark`, and unsupported command claims. |
| `README.md.docx` | Mirrors stale README claims. |
| `social-10-terminal-demo.png` | Visual review shows stale `martin.policy.yaml`, 14 classes, `claude-sonnet-4`, signed audit trail, and Ed25519 signature claims. |

## Verification

`good-to-go/` was scanned for these stale/risky phrases and returned no hits:

- `14 classes`, `14-Class`
- `Ed25519`
- `martin.policy`
- `$11.90`, `$30.70`, `417`, `63/63`, `45/45`
- `bun run benchmark`
- `v1.3.0`
- `explain`, `doctor`
- `hard kill`, `subprocess terminated`, `kills the subprocess`
- `SLSA`, `third-party audited`, `independently certified`
