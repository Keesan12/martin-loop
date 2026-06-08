# Martin Loop OSS Context

## Purpose

This repository is the public Martin Loop OSS surface.

Use it for:

- the root `martin-loop` package
- the standalone `@martinloop/mcp` package
- public docs, examples, fixtures, and release proof

Keep this tree focused on what can ship, be verified locally, and be understood from the public source alone.

## Public Tree

The canonical public surface in this repo is:

- `packages/contracts`
- `packages/core`
- `packages/adapters`
- `packages/cli`
- `packages/mcp`
- `benchmarks`
- `demo/seeded-workspace`
- `docs/oss`
- `docs/release`
- `docs/assets`
- `scripts`
- root packaging and workspace config files

## Public Version Lines

Treat the root package and the standalone MCP package as separate public version lines.

- Root package: `martin-loop`
- Standalone MCP package: `@martinloop/mcp`

Current standalone MCP release train labels:

- `0.1.4` operator foundation
- `0.2.0` cockpit expansion
- `0.2.5` public MCP package line

Check [`docs/release/VERSION-LEDGER.md`](./docs/release/VERSION-LEDGER.md) before making release or version claims.

## Public Validation Defaults

Repo-wide public validation:

```powershell
pnpm install --frozen-lockfile
pnpm lint
pnpm test
pnpm build
pnpm oss:validate
pnpm public:smoke
pnpm release:matrix:local
```

Standalone MCP validation:

```powershell
pnpm --filter @martinloop/mcp lint
pnpm --filter @martinloop/mcp test
pnpm --filter @martinloop/mcp build
pnpm --filter @martinloop/mcp smoke:pack
pnpm --filter @martinloop/mcp smoke:published:pack
pnpm --filter @martinloop/mcp verify:release
```

## Public Surface Hygiene

Before publishing, tagging, or opening a public PR:

- remove local machine paths
- remove internal repo names or non-public coordination language
- remove non-public planning or handoff language
- keep examples and claims reproducible from this repo alone
- prefer GitHub Actions as the publish authority

## Durable Notes

Public release memory belongs in `docs/release/`.

Do not add scratch notes, handoffs, or internal coordination docs to this repo.
