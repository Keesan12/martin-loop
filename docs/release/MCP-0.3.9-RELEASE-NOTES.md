# @martinloop/mcp 0.3.9 Release Notes

## Release Summary

`0.3.9` advances the standalone MartinLoop MCP server with Pre Work Burn tracking, routing economics, and cost-per-outcome data surfaced through the governed run layer.

The server remains local-first and stdio-first.

## What this release adds

- Pre Work Burn tracking: MCP-initiated runs now surface the proportion of budget consumed before execution begins
- routing economics: structured cost-per-outcome data is available through `martin_dossier` and the run summary resource
- route classification: the server distinguishes between cost-effective and over-budget execution routes in structured output
- cost-per-outcome: governed run receipts include normalized cost metrics for comparison across runs

## Verification

- `pnpm --filter @martinloop/mcp lint`
- `pnpm --filter @martinloop/mcp test`
- `pnpm --filter @martinloop/mcp build`
- `pnpm --filter @martinloop/mcp smoke:pack`
- `pnpm --filter @martinloop/mcp smoke:published:pack`
- `pnpm --filter @martinloop/mcp verify:release`
