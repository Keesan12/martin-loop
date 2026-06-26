# E-LEDGER — Full Environment Debug + Hardening

## Governed Run Receipts

| Slice | Run ID | Objective | Cost | Outcome | Changed Files |
|-------|--------|-----------|------|---------|---------------|

## Failures Where MartinLoop Itself Failed

| Step | Environment | Error | Root Cause | Fix Applied |
|------|-------------|-------|-----------|-------------|

## Reproduction Matrix

| Env | Step 1 `martin --version` | Step 2 `martin doctor` | Step 3 `martin estimate` | Step 4 `martin gate` | Step 5 `martin run` | Step 6 file changed |
|-----|--------------------------|----------------------|------------------------|--------------------|--------------------|---------------------|
| A PowerShell (standalone) | | | | | | |
| B VS Code integrated terminal | | | | | | |
| C VS Code + Claude Code agent panel | | | | | | |
| D VS Code + Codex in terminal | | | | | | |
| E Claude Code desktop (MCP) | | | | | | |

## MCP Break-it Results

| Test | Expected | Actual | Pass/Fail |
|------|----------|--------|-----------|
| Delete estimate receipt, call martin_gate | policy_blocked | | |
| budget_usd: 0 to martin_run | block | | |
| Invalid engine name | clear error, no crash | | |
| Restart Claude Code, call tools | tools still work | | |

## Pre-flight Notes

- 2026-06-26: Baseline cli-integration.test.ts:347 failing — governance gate reorder (PR #145)
  made governance fire before engine-availability check. Test was asserting old engine-check
  message. Fixed: assertion updated to match "Governed run blocked until MartinLoop receipts
  exist" + "martin-loop doctor". Now 221/221 passing.
