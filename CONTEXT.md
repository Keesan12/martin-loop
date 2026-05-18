# Martin Loop OSS Context

## Purpose

This repository is the public OSS execution repo for Martin Loop:

- Repo path: `C:\Users\Torram\OneDrive\Documents\Codex Main\Setup Stuff\martin-loop_OSS_CORE`
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

## Private Workspace Boundary

Private archive, handoff, and internal coordination work belongs in:

- `C:\Users\Torram\OneDrive\Documents\Codex Main\Setup Stuff\martin-loop_MAIN_FULL_REPO`

Use the private workspace for:

- handoffs and execution notes
- quarantine or archive material moved out of the OSS repo
- private app, enterprise, audit, or release-pack work
- internal-only plans or review packs

Do not reintroduce private residue into this OSS repo.

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

Durable handoff notes for this repo should be updated in the private workspace, not inside this OSS repo.

Current private handoff lane:

- `C:\Users\Torram\OneDrive\Documents\Codex Main\Setup Stuff\martin-loop_MAIN_FULL_REPO\DEVELOPMENT_HANDOFF.md`
- `C:\Users\Torram\OneDrive\Documents\Codex Main\Setup Stuff\martin-loop_MAIN_FULL_REPO\docs\handoffs\from-martin-loop\`

## Cleanup Rules

- Quarantine first, delete later only with explicit confirmation.
- Keep generated build, audit, and local experiment artifacts out of normal `git status`.
- Before syncing across folders, classify contamination rather than bulk-removing by keyword.
