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

## Tier Boundary Map

Use the current product-lane names consistently in OSS-safe docs:

- Free / OSS: the only public tier in this tree; includes the root `martin-loop` facade and the standalone `@martinloop/mcp` package.
- Pro: private paid tier for hosted team surfaces layered on OSS receipts; do not describe it as shipped from this repo.
- Growth: private paid tier for broader team policy and collaboration controls; do not describe it as shipped from this repo.
- Enterprise: private paid tier for governance, diagnostics, scorecards, and hosted operations; do not describe it as shipped from this repo.
- Internal: private operator and shadow-promotion tier; never mirror its implementation details into this repo.

The public MCP schedule inside the Free / OSS lane is:

- `0.1.4` operator foundation
- `0.2.0` cockpit expansion
- `0.2.5` public MCP package line

Do not treat a public `@martinloop/mcp` release as a promotion of the private Pro, Growth, Enterprise, or Internal lanes.
Keep private control-plane, autonomy, and router internals out of this repo even when naming the paid tiers.

## Private Workspace Boundary

Private archive, handoff, and internal coordination work belongs in the internal MartinLoop repo workspace that embeds this mirror under `oss-core/`.

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

Current private planning lane:

- `MASTERPLAN.md`
- `docs/internal/autonomy/MARTINLOOP-AUTONOMY-MASTER-PLAN.md`

## Cleanup Rules

- Quarantine first, delete later only with explicit confirmation.
- Keep generated build, audit, and local experiment artifacts out of normal `git status`.
- Before syncing across folders, classify contamination rather than bulk-removing by keyword.
