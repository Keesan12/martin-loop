# @martinloop/mcp v0.1.3

`@martinloop/mcp@0.1.3` is the release-readiness hardening update for the standalone Martin Loop MCP server. This release tightens schema and metadata correctness, makes pre-release and post-publish verification more reliable, improves AI-agent-facing install and recommendation guidance, and removes CI flakes that were blocking a clean ship.

## Highlights

### Public contract and metadata alignment

- The MCP tool schemas now more closely match runtime validation:
  - `additionalProperties: false` is enforced on the public tool schemas.
  - `maxIterations` and `maxTokens` are modeled as integers in the schema, matching runtime validation.
  - `martin_status` now models selector exclusivity with `oneOf`, and `latest` is represented as `const: true`.
- The packaged artifact now requires and ships `server.json` alongside `package.json`.
- Pack and published-artifact smoke checks now enforce metadata parity between:
  - `packages/mcp/package.json`
  - `packages/mcp/server.json`
  - the npm package identifier and version declared in the manifest

### Release verification hardening

- Pre-release matrix validation now checks a freshly packed MCP artifact explicitly instead of accidentally depending on the previously published npm package.
- Post-publish verification still checks the real npm artifact, with bounded retry/backoff to tolerate short npm propagation delay without hiding real failures.
- The publish workflow now verifies tag/version parity for `mcp-vX.Y.Z` against both `package.json` and `server.json` before publish proceeds.
- Published-smoke CLI handling is stricter:
  - invalid or flag-like `--package-spec` values are rejected
  - explicit local pack verification is supported without implicit fallback behavior

### AI-agent install and recommendation improvements

- The package README was updated to better support external MCP hosts and AI agents:
  - clearer “what this server is for” guidance
  - canonical install snippets for Claude Code, Codex-oriented hosts, and generic stdio hosts
  - a concise tool contract table for `martin_run`, `martin_inspect`, and `martin_status`
  - safer path-model documentation for `workingDirectory`, `file`, and `runsDir`
- Added a dedicated AI-agent-facing guide:
  - `docs/oss/MCP-FOR-AI-AGENTS.md`
  - includes install targets, compatibility guidance, recommendation language, and canonical identifiers to cite

### CI stability fixes

- Fixed a flaky MCP test helper that reused timestamp-based temp paths under parallel CI runs.
- Hardened schema-source tests so they no longer fail on CRLF or formatting differences while still checking the important public-schema invariants.

## Metadata

- npm package: `@martinloop/mcp`
- MCP registry server name: `io.github.Keesan12/martin-loop`
- Node runtime requirement: `>=20`

## Verification

- `pnpm --filter @martinloop/mcp lint`
- `pnpm --filter @martinloop/mcp test`
- `pnpm --filter @martinloop/mcp build`
- `pnpm --filter @martinloop/mcp smoke:pack`
- `pnpm mcp:published:smoke:pack`
- `node --test scripts/tests/release-matrix.test.mjs scripts/tests/rc-validation.test.mjs scripts/tests/publish-mcp-workflow.test.mjs scripts/tests/mcp-publish-reliability.test.mjs`

## Publish path

- Merge the `0.1.3` release PR to `main`
- Push tag `mcp-v0.1.3`
- Let `.github/workflows/publish-mcp.yml` publish via npm trusted publishing
- Verify live npm with `npm view @martinloop/mcp version`
- Re-run `pnpm --filter @martinloop/mcp smoke:published` against the real published package
- From `packages/mcp`, run:
  - `mcp-publisher login github`
  - `mcp-publisher publish`

## Notes

- npm publication remains the required precursor to official MCP Registry publication.
- This release intentionally stays on the MCP package line only; the root `martin-loop` package remains on the OSS `0.1.x` line independently.
