# Martin Loop

Martin Loop is a governed AI coding-loop runtime and control surface. The runtime core is real, artifact-backed, and verified through the Phase 12 certification gate; the repo is now in Phase 13 release-candidate engineering, where the work is about reproducibility, OSS-core extraction, release-surface honesty, and pilot readiness.

## Current status

- Phase 10 rollback truth: closed
- Phase 11 read-model truth: closed
- Phase 12 certification: `GO`
- Phase 13 RC engineering: active

The biggest remaining risks are release sloppiness and environment drift, not missing runtime fundamentals.

## What is real in this repo today

- policy-phase runtime with explicit `GATHER` to `HANDOFF` state transitions
- grounding scans and persisted grounding artifacts
- blocking leash behavior for unsafe commands, file-scope violations, network or approval boundaries, and secret handling
- provenance-aware cost accounting using `actual`, `estimated`, and `unavailable`
- patch-truth scoring plus rollback boundary and restore outcome artifacts
- CLI, MCP, benchmark, control-plane, and local dashboard surfaces inside one workspace

## What is not being claimed yet

- a completed public managed-product launch
- final licensing and registry-publishing decisions for every workspace package

Those are Phase 13 to Phase 15 concerns and should stay explicit until the release path is closed.

## Repo map

| Path | Role |
|---|---|
| `packages/contracts` | shared loop, grounding, leash, budget, and rollback types |
| `packages/core` | runtime controller, persistence, grounding, policy, leash, rollback |
| `packages/adapters` | Claude CLI, Codex CLI, direct-provider, and stub adapter surfaces |
| `packages/cli` | local operator CLI for `run`, `inspect`, and `resume`; benchmark orchestration stays in the workspace-only `benchmarks/` package during RC |
| `packages/mcp` | MCP server exposing `martin_run`, `martin_inspect`, and `martin_status` |
| `apps/control-plane` | hosted governance/control-plane app |
| `apps/local-dashboard` | local dashboard surface |
| `benchmarks` | Phase 7 and Phase 12 evaluation/certification harnesses |

## Quick start

```bash
pnpm install
pnpm build
pnpm rc:validate
```

`pnpm rc:validate` runs the current RC matrix in an isolated temp home or profile so fresh-environment behavior is checked instead of relying on warmed `~/.martin` state. Use `pnpm rc:validate:install` if you also want the validation run to perform a clean `pnpm install --frozen-lockfile` first.

## RC gate commands

The Phase 13 RC gate is intentionally explicit:

- `pnpm oss:validate`
- `pnpm public:smoke`
- `pnpm repo:smoke`
- `pnpm rc:validate`
- `pnpm pilot:prep:validate`
- `pnpm release:matrix:local`

Use `pnpm release:matrix:local` for the current machine’s full local lane. Cross-platform fanout for Windows, macOS, and Linux lives in `.github/workflows/phase13-release-matrix.yml`.

## Public launch target vs current RC path

The CTO memo freezes the intended public package name and install surface for launch planning, and the root package facade now implements that surface inside this repo:

- `npm install martin-loop`
- `npx martin-loop ...`
- `import { MartinLoop } from "martin-loop"`

What is still separate from that is registry publication. The current release-candidate workflow remains the repo-local source path shown here: `pnpm install`, `pnpm build`, `pnpm rc:validate`, and `pnpm run:cli -- ...`.

## Safe first run

### PowerShell

```powershell
$env:MARTIN_LIVE='false'
pnpm run:cli -- run --objective "Summarize the current Martin runtime" --verify "pnpm --filter @martin/core test"
Remove-Item Env:MARTIN_LIVE
```

### Bash

```bash
MARTIN_LIVE=false pnpm run:cli -- run --objective "Summarize the current Martin runtime" --verify "pnpm --filter @martin/core test"
```

## More docs

- [`docs/oss/README.md`](./docs/oss/README.md)
- [`docs/oss/QUICKSTART.md`](./docs/oss/QUICKSTART.md)
- [`docs/oss/EXAMPLES.md`](./docs/oss/EXAMPLES.md)
- [`docs/oss/RELEASE-SURFACE-REPORT.md`](./docs/oss/RELEASE-SURFACE-REPORT.md)
- [`docs/pilot/README.md`](./docs/pilot/README.md)
- [`docs/pilot/PILOT-PREP-REPORT.md`](./docs/pilot/PILOT-PREP-REPORT.md)

## Notes for RC reviewers

- Treat runtime artifacts, not prose, as the source of truth.
- Keep exact-versus-estimated accounting labels intact.
- Do not widen public claims faster than Phase 13 to Phase 15 evidence supports.
