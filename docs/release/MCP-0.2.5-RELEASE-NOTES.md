# @martinloop/mcp v0.2.5

`@martinloop/mcp@0.2.5` is the integrated local governed execution cockpit tip aligned to the public MCP release train. It packages the full read-only cockpit surface, run triage, and degraded-store hardening into the stable cockpit line we plan to publish after the `0.1.4` operator foundation and `0.2.0` cockpit expansion releases.

## Tier Boundary

`0.2.5` is the public Free / OSS stable cockpit line only.
It does not promote the private Pro, Growth, Enterprise, or Internal tiers, and it does not pull private control-plane, autonomy, or router internals into the MCP package claim.
Private Pro capabilities such as the authenticated remote MCP private beta and principal-aware remote config remain outside this release note.

## What Shipped

### Execution visibility

- added `martin_list_runs`
- added `martin_get_run`
- added `martin_get_attempt`
- added `martin_get_verification_results`
- added `martin_run_dossier`
- upgraded `martin_run` to return richer inspection, verification, and artifact rollups

### Context and discovery

- added static resources for server health, recent runs, MCP usage, and publish readiness
- added resource templates for runs, attempts, and verification
- added prompts for governed kickoff, failed-run debugging, and publish-readiness review

### Hardening and polish

- cached repeated doctor and run-store inspection work per process
- tightened error taxonomy and selector validation
- added `martin_triage_runs`
- added `martin://runs/triage`
- added `martin_triage_run_store`
- run-store scans now skip unreadable loop records and continue with warnings instead of taking down the whole inspection lane
- kept `martin_run`, `martin_inspect`, `martin_status`, `martin_doctor`, and `martin_preflight` backward-compatible
- aligned docs, manifests, and release checks to the full shipped surface

## Release Verification Gates

- `pnpm --filter @martinloop/mcp lint`
- `pnpm --filter @martinloop/mcp test`
- `pnpm --filter @martinloop/mcp build`
- `pnpm --filter @martinloop/mcp smoke:pack`
- `pnpm --filter @martinloop/mcp smoke:published:pack`
- `pnpm --filter @martinloop/mcp verify:release`
- `pnpm --filter @martinloop/mcp smoke:published`

## Compatibility Statement

- existing five-tool callers remain supported
- all newly added MCP surfaces are read-only except `martin_run`
- verification evidence is derived only from persisted Martin run data
- no new write-capable MCP tools are introduced in `0.2.5`
- `0.1.4`, `0.2.0`, and `0.2.5` are the only public MCP deliveries in the current release train
