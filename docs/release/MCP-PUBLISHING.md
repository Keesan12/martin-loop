# MCP Publishing

The standalone MCP line is published as its own package. Treat it like a product surface, not a side effect of the root package.

## Current public truth

- live public standalone release: `@martinloop/mcp@0.3.8`
- current in-repo standalone release line: `0.3.8`
- official registry name: `io.github.Keesan12/martin-loop`
- package publication authority: GitHub Actions trusted publishing / OIDC
- official MCP Registry publication authority: GitHub Actions OIDC through `mcp-publisher`

Do not invent a `1.0.0` version or change the registry namespace without a coordinated release decision.

## Before publish

- confirm `packages/mcp/package.json`, `packages/mcp/server.json`, the release tag, and release notes all use the same version
- confirm `package.json#mcpName` exactly matches `server.json#name`
- confirm the npm package identifier is `@martinloop/mcp`
- confirm docs and README copy match the exact shipped MCP surface
- confirm release notes sound customer-facing, not internal
- confirm the packed tarball contains only the intended package payload

## Required gates

- `pnpm --filter @martinloop/mcp lint`
- `pnpm --filter @martinloop/mcp test`
- `pnpm --filter @martinloop/mcp build`
- `pnpm --filter @martinloop/mcp smoke:pack`
- `pnpm --filter @martinloop/mcp smoke:published:pack`
- `pnpm --filter @martinloop/mcp verify:release`

## Official MCP Registry

`publish-mcp.yml` publishes every successful `mcp-vX.Y.Z` release to npm and then to the official MCP Registry. It:

1. verifies package, server, and tag version parity
2. confirms the npm artifact exists and passes the published-package smoke test
3. checks whether the exact server version is already registered
4. authenticates with `mcp-publisher login github-oidc`
5. publishes `packages/mcp/server.json`
6. verifies the exact registry version endpoint

`register-current-mcp.yml` is the bootstrap path for registering the current public release. It is idempotent and skips publication when the exact version already exists.

## External directories

External directories are distribution work, not release authority. Use the canonical source repository `https://github.com/Keesan12/martin-loop`; do not use the nonexistent `github.com/martinloop/martinloop` URL.

### mcp.so

Submission is a GitHub issue in `chatmcp/mcpso`.

- name: MartinLoop MCP
- repository: `https://github.com/Keesan12/martin-loop`
- npm package: `@martinloop/mcp`
- launch command: `npx -y @martinloop/mcp`
- transport: local `stdio`
- category: Developer Tools / AI & Agents / Safety & Governance
- license: Apache-2.0

### Glama

Glama requires GitHub OAuth and verifies that the submitter has write or admin access to the repository. Submit the canonical GitHub repository through the Glama "Add Server" flow.

### Smithery

Smithery no longer accepts an npm launch command as the publication target. It requires either:

- a public Streamable HTTP MCP endpoint, or
- an MCPB bundle for a local stdio server

Do not run `smithery mcp publish "npx -y @martinloop/mcp"`; that command is obsolete for the current Smithery publishing model.

### PulseMCP

PulseMCP has a maintainer submission form. npm keywords improve general discovery but do not replace the PulseMCP submission flow.

### Awesome MCP Servers

The `punkpeye/awesome-mcp-servers` listing requires a fork and pull request that follows its current contribution format. Proposed entry:

```markdown
- Keesan12/martin-loop 📇 🏠 🍎 🪟 🐧 - Governed AI coding-agent runs with hard budgets, verifier gates, failure triage, and inspectable receipts. Install: `npx -y @martinloop/mcp`.
```

## Release-note rule

Each standalone release needs release notes that answer four things plainly:

- what changed
- why it matters
- how to start using it
- what was verified before release
