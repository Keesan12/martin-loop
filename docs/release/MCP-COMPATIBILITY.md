# Martin MCP Compatibility

This document is the compatibility statement for the governed execution cockpit line currently at `@martinloop/mcp@0.2.7`.

## Stable Contract

- MartinLoop compatibility guarantee: martin_run remains the only execution entrypoint.
- `martin_run` remains the only execution entrypoint.
- `martin_inspect`, `martin_status`, `martin_doctor`, and `martin_preflight` remain available and backward-compatible.
- `martin_list_runs`, `martin_triage_runs`, `martin_get_run`, `martin_get_attempt`, `martin_get_verification_results`, and `martin_run_dossier` are additive read-only surfaces.
- resources, resource templates, and prompts are additive discovery surfaces over the same persisted Martin run data.

## Data Expectations

- run inspection is sourced from persisted loop records, artifacts, and verification events
- missing verification evidence is reported as unavailable instead of synthesized
- safe-root behavior for `workingDirectory`, `file`, and `runsDir` remains enforced

## Follow-On Direction

Any follow-on release after `0.2.7` should:

- preserve the `0.2.5` public MCP package line compatibility expectations unless migration notes explicitly say otherwise
- avoid adding new write-capable MCP tools without a documented approval model
- keep install snippets, manifests, and discovery docs in parity with the actual server surface
