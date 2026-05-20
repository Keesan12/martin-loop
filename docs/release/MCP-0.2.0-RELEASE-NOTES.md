# @martinloop/mcp v0.2.0

`0.2.0` is the public cockpit expansion after the `0.1.4` operator foundation. `0.1.4` gave MCP hosts the safe operator lane: doctor, preflight, governed run, inspect, and status. `0.2.0` keeps that execution contract intact and adds a read-only cockpit so hosts can review local run evidence without widening write access.

The headline: `martin_run` is still the only write-capable MCP tool. Everything new in `0.2.0` is inspection, review, or triage support over persisted Martin Loop run records.

## What Changed From `0.1.4`

| Area | `0.1.4` | `0.2.0` |
| --- | --- | --- |
| Operator readiness | `martin_doctor`, `martin_preflight` | unchanged |
| Governed execution | `martin_run` | unchanged write boundary |
| Basic inspection | `martin_inspect`, `martin_status` | unchanged |
| Run cockpit | not included | `martin_list_runs`, `martin_get_run`, `martin_get_attempt`, `martin_get_verification_results`, `martin_run_dossier` |
| MCP discovery | tools only | tools plus resources, resource templates, and prompts |
| Release hardening | package smoke and published smoke | smoke gates now assert all 10 tools and discovery surfaces |

## Why This Matters

MCP hosts can now show a practical Martin Loop cockpit: recent runs, one-run dossiers, individual attempts, verifier results, and review prompts. That makes Martin Loop easier to trust in real workflows because users can see what happened, what it cost, what passed, and what still needs review.

## Added

Existing `0.1.4` operator tools remain in the release surface:

- `martin_doctor`
- `martin_preflight`
- `martin_run`
- `martin_inspect`
- `martin_status`

New read-only cockpit tools:

- `martin_list_runs` lists recent governed run summaries from the local run store.
- `martin_get_run` returns a read-only run dossier by `loopId` or `latest`.
- `martin_get_attempt` returns one attempt record by `loopId` and `attemptIndex`.
- `martin_get_verification_results` extracts verifier completion events.
- `martin_run_dossier` assembles summary, task, budget, attempts, and verification evidence for review.

New resources:

- `martin://runs/summary`
- `martin://runs/latest`

New resource templates:

- `martin://runs/{loopId}`
- `martin://runs/{loopId}/attempts/{attemptIndex}`
- `martin://runs/{loopId}/verification`

New prompts:

- `martin_review_run`
- `martin_triage_failures`

## Hardened

- Release workflow contract now explicitly permits GitHub release creation with `contents: write`.
- Package and `server.json` metadata remain version-aligned for npm and MCP registry publication.
- New cockpit tests cover resources, resource templates, prompts, run listing, attempt reads, verifier extraction, and dossiers.
- Local pack smoke and install-from-pack smoke now fail if any expected `0.2.0` tool, resource, template, or prompt is missing.

## Upgrade Notes

- Existing `0.1.4` tool callers do not need to change their `martin_doctor`, `martin_preflight`, `martin_run`, `martin_inspect`, or `martin_status` calls.
- Hosts can opt into the new cockpit surface by listing tools, resources, resource templates, and prompts through the normal MCP discovery methods.
- The npm package name remains `@martinloop/mcp`.
- The MCP registry server name remains `io.github.Keesan12/martin-loop`.

## What `0.2.0` does not claim

- It does not include the removed `0.2.5` branch or skipped stable-cockpit work.
- It does not publish private Pro, Growth, Enterprise, Internal, hosted control-plane, autonomy, or router features.
- It does not add remote MCP auth, bearer-token control planes, or hosted team dashboards.
- It does not make `martin_run` broader than the existing governed local execution contract.

## Verification

The `0.2.0` release candidate was checked with:

```powershell
pnpm --filter @martinloop/mcp lint
pnpm --filter @martinloop/mcp test
pnpm --filter @martinloop/mcp build
pnpm --filter @martinloop/mcp smoke:pack
pnpm --filter @martinloop/mcp smoke:published:pack
pnpm --filter @martinloop/mcp verify:release
pnpm release:matrix:local
```

The public PR release matrix also passed on Windows, macOS, and Ubuntu before release tagging.

## Release Path

Publish through `.github/workflows/publish-mcp.yml` with tag `mcp-v0.2.0`; do not publish locally unless GitHub Actions is unavailable and the fallback is explicitly approved. After publish, verify:

```powershell
npm view @martinloop/mcp version versions --json
gh release view mcp-v0.2.0 --repo Keesan12/martin-loop
pnpm --filter @martinloop/mcp smoke:published
```
