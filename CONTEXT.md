# Martin Loop OSS Context

## Purpose

This repository is the public OSS execution repo for Martin Loop:

- Repo path: `./`
- Git remote: `https://github.com/Keesan12/martin-loop.git`

Use this tree for OSS-safe package, docs, and verification work only.

## Public Tree

The canonical public surface in this repo is:

- `packages/contracts`
- `packages/core`
- `packages/adapters`
- `packages/cli`
- `packages/mcp`
- `docs/oss`
- `docs/release`
- `docs/assets`
- `benchmarks`
- `demo/seeded-workspace`
- `scripts`
- root packaging and workspace config files

If a folder is not needed to ship or verify the OSS runtime, it does not belong here by default.

## Public Release Lines

Keep the root package and standalone MCP package release lines separate:

- root `martin-loop`: CLI and SDK facade
- standalone `@martinloop/mcp`: MCP server package

Current public package versions are recorded in:

- `package.json`
- `packages/mcp/package.json`
- `docs/release/VERSION-LEDGER.md`

Keep non-public service, roadmap, and operations details out of this repo.

## Non-Public Work Boundary

Archive, handoff, and internal coordination notes belong outside this public repo.

Keep these materials out of tracked public files:

- handoffs and execution notes
- quarantine or archive material moved out of the OSS repo
- non-public app, audit, or release-pack work
- internal-only plans or review packs

Do not reintroduce non-public residue into this OSS repo.

## MCP Work Lane

The active public MCP package lives in:

- `packages/mcp`

Default verification lane:

```powershell
pnpm install --frozen-lockfile
pnpm --filter @martinloop/mcp lint
pnpm --filter @martinloop/mcp test
pnpm --filter @martinloop/mcp build
pnpm --filter @martinloop/mcp smoke:pack
pnpm --filter @martinloop/mcp smoke:published:pack
```

If packaging or publish-surface files change, also run:

```powershell
pnpm --filter @martinloop/mcp verify:release
```

## Handoff Discipline

Durable handoff notes for this repo should be updated outside this public repo.

## Cleanup Rules

- Quarantine first, delete later only with explicit confirmation.
- Keep generated build, audit, and local experiment artifacts out of normal `git status`.
- Before syncing across folders, classify contamination rather than bulk-removing by keyword.
