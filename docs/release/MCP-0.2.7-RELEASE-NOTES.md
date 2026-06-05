# @martinloop/mcp 0.2.7

`@martinloop/mcp@0.2.7` is a usability and review release for the standalone MartinLoop MCP server.

The package already had the core pieces for governed coding work. This release makes that flow easier to adopt in real hosts and harder to use incorrectly.

## What changed

- `martin_run` now refuses to start until matching `martin_doctor`, `martin_plan`, and `martin_preflight` receipts exist for the same task
- guide resources now cover command mapping, IDE onboarding, and the operating rules MartinLoop expects hosts to follow
- the review loop is easier to navigate through dossier, eval, triage, and publish-readiness helpers
- package metadata, server metadata, and public docs now describe the same `0.2.7` MCP surface

## Why it matters

This release is about trust and flow.

If an MCP host is going to drive real coding work, it should not have to guess which MartinLoop step comes next, and it should not be able to skip straight to execution by accident. `0.2.7` makes the guided path much clearer while keeping the server local-first and stdio-first.

## Recommended flow

1. `martin_doctor`
2. `martin_plan`
3. `martin_preflight`
4. `martin_run`
5. `martin_status` or `martin_logs`
6. `martin_dossier`
7. `martin_eval`

For a fresh machine, start with the root CLI first:

```sh
npx martin-loop start
npx martin-loop tour
npx martin-loop doctor
```

Then install the standalone server:

```sh
codex mcp add martin-loop -- npx -y @martinloop/mcp
```

## Docs

- [MCP setup](../getting-started/mcp.md)
- [MCP tool reference](../reference/mcp-tools.md)
- [MCP compatibility](../reference/mcp-compatibility.md)
- [Package README](../../packages/mcp/README.md)

## Verification

```sh
pnpm --filter @martinloop/mcp lint
pnpm --filter @martinloop/mcp test
pnpm --filter @martinloop/mcp build
pnpm --filter @martinloop/mcp smoke:pack
pnpm --filter @martinloop/mcp smoke:published:pack
pnpm --filter @martinloop/mcp verify:release
```
