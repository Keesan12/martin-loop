# Martin MCP Release Lane Map

Use this map when preparing scheduled public deliveries from the current repo checkout. The goal is to keep the public release train honest against live npm truth while keeping docs, tests, and packaging scoped to the intended release.

## Public Version Train

- live npm baseline: `0.2.7`
- staged public deliveries:
  - `0.1.4` operator foundation
  - `0.2.0` cockpit expansion
  - `0.2.5` public MCP package line
  - `0.2.7` usability and review release
- current repo package manifest: `0.2.7`

See [VERSION-LEDGER.md](./VERSION-LEDGER.md) for the canonical version truth.

## Public Boundary

- the standalone `@martinloop/mcp` train is the public MCP surface in this repo
- public release notes, packets, and README files should describe only shipped public capabilities
- keep experimental, unpublished, or unrelated material out of the OSS MCP train

## Delivery `0.1.4`

Scope: operator foundation for the Free / OSS operator lane.

Include:

- `martin_doctor`
- `martin_preflight`
- install/config generation improvements
- version-truth and release-evidence docs
- public verification hardening needed to support the operator foundation story

Primary surfaces:

- `packages/mcp/src/tools/doctor.ts`
- `packages/mcp/src/tools/preflight.ts`
- `packages/mcp/src/server.ts`
- `packages/cli/src/index.ts`
- `packages/cli/src/mcp-config.ts`
- `packages/mcp/README.md`
- `docs/oss/MCP-FOR-AI-AGENTS.md`
- `docs/oss/QUICKSTART.md`
- `docs/release/MCP-0.1.4-RELEASE-NOTES.md`

Do not include:

- resources
- resource templates
- prompts
- dossier/triage-heavy discovery story

## Delivery `0.2.0`

Scope: cockpit expansion for the Free / OSS public cockpit lane.

Include:

- additive read-only inspection expansion
- resources
- resource templates
- prompts
- dossier/discovery surfaces

Primary surfaces:

- `packages/mcp/src/resources.ts`
- `packages/mcp/src/prompts.ts`
- `packages/mcp/src/discovery-metadata.ts`
- `packages/mcp/src/discovery-support.ts`
- `packages/mcp/src/tools/list-runs.ts`
- `packages/mcp/src/tools/get-run.ts`
- `packages/mcp/src/tools/get-attempt.ts`
- `packages/mcp/src/tools/get-verification-results.ts`
- `packages/mcp/src/tools/run-dossier.ts`
- `packages/mcp/tests/mcp-discovery.test.ts`
- `packages/mcp/tests/server-live.test.ts`
- `docs/release/MCP-0.2.0-RELEASE-NOTES.md`

Keep public execution semantics unchanged:

- `martin_run` remains the only write-capable entrypoint

Do not include:

- unpublished remote experiments
- capabilities without public code and reproducible proof
- unrelated workflow or packaging changes

## Delivery `0.2.5`

Scope: the public MCP package line, including the polish and hardening needed to keep that line honest.

Include:

- triage
- degraded run-store handling
- release documentation bundle
- compatibility and publishing docs
- stronger release guards
- final proof artifacts for the public cockpit line

Primary surfaces:

- `packages/mcp/src/tools/triage-runs.ts`
- `packages/mcp/src/tools/run-store.ts`
- `packages/mcp/src/tools/tool-errors.ts`
- `packages/mcp/src/tools/tool-response.ts`
- `packages/mcp/src/tools/tool-support.ts`
- `packages/mcp/tests/mcp-tools.test.ts`
- `scripts/tests/mcp-release-docs.test.mjs`
- `docs/release/MCP-0.2.5-RELEASE-NOTES.md`
- `docs/release/MCP-0.2.5-RELEASE-PACKET.md`
- `docs/release/MCP-COMPATIBILITY.md`
- `docs/release/MCP-PUBLISHING.md`
- `docs/release/MCP-RELEASE-CHECKLIST.md`

## Explicit Exclusions From The Public Train

These stay out of the public MCP npm release train for this wave:

- unpublished or experimental capabilities
- unrelated application packages
- unrelated tracing or routing packages
- remote metadata that is not part of the shipped public package
- credentials, rate limits, or operational material that is not part of the public package contract

## Release Cut Rule

Before cutting any staged public branch:

1. Confirm [VERSION-LEDGER.md](./VERSION-LEDGER.md) still matches live npm and public GitHub `main`.
2. Confirm the target delivery includes only the intended public slice from above.
3. Confirm the exact release branch or commit is what goes to CI for Windows, Linux, and macOS proof.
4. Keep unrelated changes out of the release branch; only ship the files required for the release slice.
