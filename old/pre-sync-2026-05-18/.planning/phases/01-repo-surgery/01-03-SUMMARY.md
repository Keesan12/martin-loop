---
phase: 01-repo-surgery
plan: "03"
subsystem: documentation
tags: [readme, canonical-files, onboarding, r1.7, r1.8]
dependency_graph:
  requires: [01-01]
  provides: [README-canonical-map]
  affects: [onboarding, developer-orientation]
tech_stack:
  added: []
  patterns: [canonical-file-map, structured-readme]
key_files:
  created: []
  modified:
    - README.md
decisions:
  - docs/legacy referenced as a flat path in the project structure tree for grep-verifiability
metrics:
  duration: ~8min
  completed: "2026-04-01T21:54:23Z"
  tasks_completed: 1
  tasks_total: 1
  files_changed: 1
requirements: [R1.7, R1.8]
---

# Phase 1 Plan 3: README Update with Canonical Runtime Path Map Summary

README.md rewritten to prominently list all 5 canonical runtime entry points in a dedicated table, with an accurate project structure section reflecting the current repo layout including docs/legacy/ and local-dashboard.

## Tasks Completed

| # | Task | Commit | Files |
|---|------|--------|-------|
| 1 | Rewrite README.md with canonical runtime path map | cb81df3 | README.md |

## What Was Built

The root README.md was rewritten to satisfy R1.7 (canonical paths documented) and R1.8 (10-minute orientation for unfamiliar engineers). Changes:

1. Added `## Canonical Runtime Files` section immediately after "What it does" and before "Packages" — a 5-row table mapping each file to its role.
2. Added `## Project Structure` section replacing the former "Monorepo structure" stub — now includes `apps/local-dashboard/`, `docs/legacy/`, `scripts/`, `deploy/`, and `.planning/`.
3. Verified all existing accurate sections were preserved: CLI Usage (with full flags table), Config file, MCP Server (with tool examples), Environment variables, Testing, Publishing.
4. Confirmed no V3 directory or zip file references appear in the README.
5. Confirmed all pnpm commands are correct — the only `npm` references are for global tool installs of external CLIs (`@anthropic-ai/claude-code`, `@openai/codex`), which is correct.

## Verification Results

All acceptance criteria passed:

- `## Canonical Runtime Files` header: present at line 13
- All 5 canonical file paths: each appears at least once
- `docs/legacy` reference: present in project structure
- Section ordering: Canonical (line 13) before Packages (line 25)
- `## CLI Usage`, `## MCP Server`, `## Testing`: all retained
- No V3 or zip file references
- Commit message contains "canonical runtime path map"

## Deviations from Plan

**1. [Rule 2 - Structure] Flattened docs/legacy tree entry to single line**
- **Found during:** Task 1 verification
- **Issue:** The plan's tree diagram showed `docs/` and `legacy/` on separate lines, which caused `grep -c "docs/legacy" README.md` to return 0.
- **Fix:** Collapsed to `docs/legacy/` on a single line in the tree. Visually equivalent and satisfies the grep-based acceptance check.
- **Files modified:** README.md
- **Commit:** cb81df3 (same commit — caught during pre-commit verification)

## Known Stubs

None. The README documents live code paths accurately based on direct inspection of all 5 canonical runtime files.

## Self-Check: PASSED

- README.md exists: FOUND
- Commit cb81df3 exists: FOUND
- All 5 canonical file paths in README: VERIFIED
- `## Canonical Runtime Files` section header: VERIFIED
- `docs/legacy` reference: VERIFIED
- Canonical section before Packages section: VERIFIED (line 13 < line 25)
