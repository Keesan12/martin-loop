# Claude Code Instructions

Read `AGENTS.md` before making any change. `AGENTS.md` is the sole repository operating guide for agents.

Do not infer current release status from old branches, old PRs, old incident notes, audit documents, terminal history, or prior session handoffs.

For current version and release state, use only:

- `package.json`
- `packages/mcp/package.json`
- `docs/release/VERSION-LEDGER.md`
- current Git branch / commit state
- current open PRs and required checks

Repository authority:

- development authority: `martin-Loop/ML_Core_OSS_Internal`
- public distribution: `Keesan12/martin-loop`

Required release order:

private branch → private PR → private merge → private-main health proof → public staging → promotion guard → public PR → public merge → publish → fresh-install / E2E proof.

Never develop directly in the public repository. Never bypass public-write or portability guards. Never use stale handoff files as release authority.

Release evidence and handoff artifacts must live in a persistent repo-owned location such as `.release/<version>/`; do not place MartinLoop release work in `C:\\tmp`, OS temp directories, or disposable scratch folders.

When a required gate fails, investigate only that exact failure. Do not start broad audits, revive superseded release processes, or create new acceptance phases unless a new deterministic P0/P1 requires it.
