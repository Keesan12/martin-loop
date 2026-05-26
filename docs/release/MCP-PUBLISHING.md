# MCP Publishing

Use npm trusted publishing from GitHub Actions for `@martinloop/mcp`.

For the current `0.2.5` line, the publish claim covers the public stable cockpit surface: tools, resources, resource templates, and prompts, plus the run-triage surface layered into that cockpit. The docs and release checks must describe that full surface honestly while the public release lineage stays `0.1.4 -> 0.2.0 -> 0.2.5`.

The scheduled public labels are:

- `0.1.4` operator foundation
- `0.2.0` cockpit expansion
- `0.2.5` stable cockpit line

## Canonical Release Path

1. Bump `packages/mcp/package.json` and `packages/mcp/server.json`.
2. Confirm `docs/release/VERSION-LEDGER.md` still matches live npm, public GitHub `main`, and the local integrated tree.
3. Refresh:
   - `packages/mcp/README.md`
   - `docs/oss/MCP-FOR-AI-AGENTS.md`
   - `docs/oss/QUICKSTART.md`
   - `docs/release/MCP-X.Y.Z-RELEASE-NOTES.md`
   - `docs/release/MCP-X.Y.Z-RELEASE-PACKET.md`
   - `docs/release/MCP-COMPATIBILITY.md`
   - `docs/release/MCP-RELEASE-CHECKLIST.md`
4. Run the pre-publish gates:
   - `pnpm --filter @martinloop/mcp lint`
   - `pnpm --filter @martinloop/mcp test`
   - `pnpm --filter @martinloop/mcp build`
   - `pnpm --filter @martinloop/mcp smoke:pack`
   - `pnpm --filter @martinloop/mcp smoke:published:pack`
   - `pnpm --filter @martinloop/mcp verify:release`
5. Trigger `.github/workflows/publish-mcp.yml` with `workflow_dispatch` or `mcp-vX.Y.Z`.
6. Let the workflow publish npm through trusted publishing and re-run `pnpm --filter @martinloop/mcp smoke:published`.
7. Confirm the GitHub release body matches `docs/release/MCP-X.Y.Z-RELEASE-NOTES.md`.

## Docs and Parity Checklist

Before calling the release ready, confirm:

- the matching `docs/release/MCP-X.Y.Z-RELEASE-PACKET.md` exists and includes the commands run, versions tested, host matrix receipts, known non-goals, and pending publish gates
- docs list the current tools:
  - `martin_doctor`
  - `martin_preflight`
  - `martin_run`
  - `martin_inspect`
  - `martin_status`
  - `martin_list_runs`
  - `martin_triage_runs`
  - `martin_get_run`
  - `martin_get_attempt`
  - `martin_get_verification_results`
  - `martin_run_dossier`
- docs list the current resources and prompts
- docs keep current Codex and Claude Code install snippets
- release notes describe the actual discovery surface as shipped, not as future work
- docs stay scoped to the public package surface and documented host installs
- docs do not present hosted-only or undocumented transport claims as part of the npm package claim
- `scripts/tests/mcp-release-docs.test.mjs` verifies the tool list, resource list, prompt list, and cockpit flow

## Gate Semantics

- `smoke:pack` is the pre-publish local-pack gate
- `smoke:published:pack` is the install-from-pack gate
- `smoke:published` is the post-publish npm gate

They are separate gates and should stay separate.

## Trusted Publishing Notes

- package: `@martinloop/mcp`
- registry/server identifier: `io.github.Keesan12/martin-loop`
- GitHub owner: `Keesan12`
- repository: `martin-loop`
- workflow: `publish-mcp.yml`

## Failure Policy

Do not fall back to local `npm publish`. If trusted publishing fails, debug the GitHub Actions workflow, tag/ref wiring, package metadata, and npm visibility until the automated path succeeds.
