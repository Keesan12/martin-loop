# MartinLoop 0.3.2 Validation Evidence

This evidence summary records the release-candidate validation pass for `martin-loop@0.3.2` and `@martinloop/mcp@0.3.1`.

## Release gates

Validated on the release branch with passing results:

- `pnpm public:copy-scan`
- `pnpm public:git-surface`
- `node --test scripts/tests/mcp-release-docs.test.mjs`
- `pnpm release:validate-local`
- `node ./scripts/root-release-guard.mjs --tag v0.3.2 --pack`

## Governed run parity checks

### Reproduced on published `martin-loop@0.3.1`

- Running `doctor -> session-start -> preflight -> run --proof` in a clean temp workspace reproduced a false run-gate block (`missingSteps: ["preflight"]`) after a successful preflight.
- This confirms a real governed receipt gate mismatch on the published line.

### Verified on `0.3.2` candidate code

- Applied the gate parity fix in CLI and MCP workflow-state recording.
- Added regression tests:
  - `packages/cli/tests/workflow-state.test.ts`
  - `packages/mcp/tests/server-validation.test.ts`
- Re-ran package tests:
  - `pnpm --filter @martin/cli test`
  - `pnpm --filter @martinloop/mcp test`
- Live governed runs with the candidate CLI passed after valid `doctor -> session-start -> preflight` chains for Codex and Claude.

## Side-by-side live checks (budget-capped)

Objective used for direct vs governed comparison:
- `List top-level files in this workspace and report node version.`

Observed outcomes:

- Direct Codex: succeeded.
- Governed Codex (`0.3.2` candidate): succeeded with receipt artifacts and budget controls.
- Direct Claude: succeeded.
- Governed Claude (`0.3.2` candidate): succeeded with receipt artifacts and authoritative settlement fields.
- Gemini direct/governed: blocked in this environment due missing Gemini auth configuration.

Known spend from captured outputs during this validation pass:
- Governed Codex: about `$0.02` (estimated provenance in this run lane)
- Direct Claude: about `$0.38`
- Governed Claude: about `$0.38` (actual provenance with provider settlement fields)
- Total observed spend stayed well below the `$10` cap.

## MCP end-to-end + red-team checks

Installed from registry and validated over live stdio RPC:

- `npx -y @martinloop/mcp` handshake succeeded.
- `tools/list` returned expected discovery surface (`21` tools).
- Adversarial probes were rejected with structured errors:
  - path traversal in `allowedPaths`
  - unknown hidden run fields
  - inspect traversal file selectors
  - ambiguous selector combinations
  - invalid `attemptIndex` values

## Public receipt artifact proof

Generated with:

- `share --latest` from a governed run

Bundle outputs:

- `run-receipt.json`
- `run-receipt.md`
- `proof-card.svg`

## Security and trust notes

- Path traversal and hidden-argument probes were rejected on MCP live surface.
- Windows destructive command patterns were expanded in core safety leash coverage.
- Receipt integrity remains explicit: non-canonical run roots are reported as unsigned and not trustworthy for hard trust claims.
