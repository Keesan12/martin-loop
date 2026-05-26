# Martin MCP Delivery Slice Map

Use this map when cutting public MCP deliveries from the `0.2.5` source line. The goal is to keep the public release lineage honest against live npm truth and to limit each release note to the documented package surface.

## Public Version Train

- live npm baseline before the `0.2.5` release: `0.2.0`
- staged public deliveries:
  - `0.1.4` operator foundation
  - `0.2.0` cockpit expansion
  - `0.2.5` stable cockpit line
- integrated local tip: `0.2.5`

See [VERSION-LEDGER.md](./VERSION-LEDGER.md) for the canonical version truth.

## Public Boundary

- The standalone `@martinloop/mcp` package is the only MCP package described by this map.
- Release notes, packets, and README updates must stay limited to documented tools, resources, resource templates, prompts, and supported host installs.
- Do not broaden the package claim with unrelated applications, hosted operations, or undocumented transports.

## Delivery `0.1.4`

Scope: operator foundation for the Free / OSS operator lane.

Include:

- `martin_doctor`
- `martin_preflight`
- install/config generation improvements
- version-truth and release-proof docs
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
- undocumented remote transports

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

- undocumented remote transports
- hosted operations
- unrelated routing or application claims

## Delivery `0.2.5`

Scope: stable cockpit line for the Free / OSS public cockpit lane, including the polish and hardening needed to keep that line honest.

Include:

- triage
- degraded run-store handling
- release packet
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

- non-package application work
- non-package trace and routing work
- hosted Streamable HTTP remote metadata
- bearer tokens, audit, rate limits, and other hosted operations
- unrelated autonomy or routing claims

## Release Cut Rule

Before cutting any staged public branch:

1. Confirm [VERSION-LEDGER.md](./VERSION-LEDGER.md) still matches live npm and public GitHub `main`.
2. Confirm the target delivery includes only the intended public slice from above.
3. Confirm the exact candidate branch is what goes to CI for Windows, Linux, and macOS proof.
4. Keep unrelated mirrors, scratch artifacts, and non-package documentation out of the public branch except where the OSS source-of-truth files already require synchronized docs or tests.
