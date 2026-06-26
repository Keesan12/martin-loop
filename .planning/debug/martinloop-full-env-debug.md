---
status: investigating
slug: martinloop-full-env-debug
trigger: "Full environment debug — PowerShell/VSCode terminal/agent panel/MCP all failing differently for users across environments"
created: 2026-06-26
updated: 2026-06-26
---

## Current Focus

hypothesis: Governance gate reorder (PR #145) introduced a test assertion mismatch in cli-integration.test.ts; MCP hook paths may produce Windows-only syntax; TTL staleness may cause spurious gate blocks in long-running VS Code sessions; resolveNpmShimScript may not cover npm 10.x shim format.

next_action: Fix baseline test failure in cli-integration.test.ts:347, then run environment matrix E.0

## Evidence

- timestamp: 2026-06-26T18:39Z
  finding: pnpm -r test shows 1/221 failing — cli-integration.test.ts:347 expects "Governed run preflight blocked execution" but governance gate reorder now produces "Governed run blocked until MartinLoop receipts exist" first
  source: local test run after pull of PR #145

## Eliminated

## Resolution
root_cause:
fix:
verification:
files_changed:
