# @martinloop/mcp v0.2.0

`0.2.0` is the public cockpit expansion after the `0.1.4` operator foundation. It keeps `martin_run` as the only write-capable tool and adds read-only discovery for hosts that want to inspect governed runs before, during, and after review.

## Added

- Existing operator tools remain in the release surface: `martin_doctor`, `martin_preflight`, `martin_run`, `martin_inspect`, and `martin_status`.
- `martin_list_runs` lists recent governed run summaries from the local run store.
- `martin_get_run` returns a read-only run dossier by `loopId` or `latest`.
- `martin_get_attempt` returns one attempt record by `loopId` and `attemptIndex`.
- `martin_get_verification_results` extracts verifier completion events.
- `martin_run_dossier` assembles summary, task, budget, attempts, and verification evidence for review.
- Resources: `martin://runs/summary` and `martin://runs/latest`.
- Resource templates: `martin://runs/{loopId}`, `martin://runs/{loopId}/attempts/{attemptIndex}`, and `martin://runs/{loopId}/verification`.
- Prompts: `martin_review_run` and `martin_triage_failures`.

## Hardened

- Release workflow contract now explicitly permits GitHub release creation with `contents: write`.
- Package and `server.json` metadata remain version-aligned for npm and MCP registry publication.
- New cockpit tests cover resources, resource templates, prompts, run listing, attempt reads, verifier extraction, and dossiers.

## What `0.2.0` does not claim

- It does not include the removed `0.2.5` branch or skipped stable-cockpit work.
- It does not publish private Pro, Growth, Enterprise, Internal, hosted control-plane, autonomy, or router features.
- It does not add remote MCP auth, bearer-token control planes, or hosted team dashboards.
- It does not make `martin_run` broader than the existing governed local execution contract.

## Release Gates

Before tagging `mcp-v0.2.0`, run:

```powershell
pnpm --filter @martinloop/mcp lint
pnpm --filter @martinloop/mcp test
pnpm --filter @martinloop/mcp build
pnpm --filter @martinloop/mcp smoke:pack
pnpm --filter @martinloop/mcp smoke:published:pack
pnpm --filter @martinloop/mcp verify:release
pnpm release:matrix:local
```

Publish through `.github/workflows/publish-mcp.yml` with tag `mcp-v0.2.0`; do not publish locally unless GitHub Actions is unavailable and the fallback is explicitly approved.
