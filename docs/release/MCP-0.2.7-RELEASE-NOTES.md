# @martinloop/mcp 0.2.7

`@martinloop/mcp@0.2.7` is the current public baseline for the standalone MartinLoop MCP server.

## What changed

- made the guided MartinLoop flow clearer inside MCP hosts
- tightened the run gate so hosts cannot jump straight to execution without matching planning and preflight receipts
- cleaned up package metadata, docs, and release surfaces so they describe the same product

## Why it matters

This release is less about adding more surface area and more about making the existing surface easier to trust.

A host should not have to guess which MartinLoop command comes next, and it should not be able to skip the safety steps by accident.

## Recommended flow

1. `martin_doctor`
2. `martin_plan`
3. `martin_preflight`
4. `martin_run`
5. `martin_status` or `martin_logs`
6. `martin_dossier`
7. `martin_eval`

## Verification

- `pnpm --filter @martinloop/mcp lint`
- `pnpm --filter @martinloop/mcp test`
- `pnpm --filter @martinloop/mcp build`
- `pnpm --filter @martinloop/mcp smoke:pack`
- `pnpm --filter @martinloop/mcp smoke:published:pack`
- `pnpm --filter @martinloop/mcp verify:release`
