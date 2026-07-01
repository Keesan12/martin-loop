# @martinloop/mcp 0.3.7 Release Notes

## Release Summary

`0.3.7` advances the standalone MartinLoop MCP package to the receipt-first trust model used across the current OSS train.

The server still stays local-first and stdio-first, but hosts are now guided toward the smallest trustworthy context first: next-step guidance, latest summary, and structured receipt data.

## What this release adds

- a canonical `martin://runs/latest/receipt` resource for machine consumers
- discovery guidance that treats proof-card views as optional derived artifacts
- receipt-first host guidance centered on `martin://agent/next-step` and `martin://runs/latest/summary`
- release-doc validation that follows current package metadata instead of a stale hardcoded MCP version

## Verification

- `pnpm --filter @martinloop/mcp lint`
- `pnpm --filter @martinloop/mcp test`
- `pnpm --filter @martinloop/mcp build`
- `pnpm --filter @martinloop/mcp smoke:pack`
- `pnpm --filter @martinloop/mcp smoke:published:pack`
- `pnpm --filter @martinloop/mcp verify:release`
