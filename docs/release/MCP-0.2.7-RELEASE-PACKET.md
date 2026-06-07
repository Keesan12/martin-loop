# Martin MCP `0.2.7` Release Packet

This packet is the proof bundle for `@martinloop/mcp@0.2.7`, the usability and review release for the standalone MartinLoop MCP server.

## Version Truth

- standalone package: `@martinloop/mcp@0.2.7`
- public release train:
  - `0.1.4` operator foundation
  - `0.2.0` cockpit expansion
  - `0.2.5` public MCP package line
  - `0.2.7` usability and review release

See [VERSION-LEDGER.md](./VERSION-LEDGER.md) for the canonical version map.

## Public Boundary

This packet covers only the public MCP package surface documented in this repo: tools, resources, resource templates, prompts, packaging metadata, and public release evidence.

## Commands Run

```powershell
pnpm --filter @martinloop/mcp lint
pnpm --filter @martinloop/mcp test
pnpm --filter @martinloop/mcp build
pnpm --filter @martinloop/mcp smoke:pack
pnpm --filter @martinloop/mcp smoke:published:pack
pnpm --filter @martinloop/mcp verify:release
pnpm lint
pnpm test
pnpm build
pnpm oss:validate
pnpm public:smoke
```

## Versions Tested

- root package current repo manifest: `martin-loop@0.2.11`
- standalone MCP current repo manifest: `@martinloop/mcp@0.2.7`

## Host Matrix Receipts

Local proof for this package line covers:

- Codex config generation and smoke validation
- Claude Code config generation and smoke validation
- Gemini config generation and smoke validation
- generic stdio config generation and smoke validation

The release rule remains unchanged: the exact release CI must be green on Windows, Linux, and macOS before calling the line ready to push.

## Source Parity Receipts

- `packages/mcp/package.json` matches the standalone MCP server metadata
- `packages/mcp/server.json` matches the standalone MCP package metadata
- `packages/mcp/src/package-version.ts` matches the standalone MCP package metadata
- public docs and release docs describe the same current cockpit surface

## What `0.2.7` Adds

- stronger guided-flow material for hosts through command-map, IDE-onboarding, and operating-rules resources
- a clearer review loop around dossier, triage, eval, and publish-readiness helpers
- tighter parity between package metadata, server metadata, and public docs

## Known Non-Goals

- no second write-capable MCP execution entrypoint
- no registry publication in this packet
- no hosted remote-server claim in this packet
- no undocumented host profile or unpublished surface in public docs

## Publish Gates Still Pending Explicit Approval

These steps remain intentionally blocked until explicit approval:

- create the exact release branch for the next public delivery
- push that release branch
- tag the release
- publish npm
- update public GitHub releases

## Ready-To-Push Rule

Do not call this line ready to push until all of these are true:

- version truth is still consistent with [VERSION-LEDGER.md](./VERSION-LEDGER.md)
- release docs, manifest, and `server.json` all align
- source parity still holds
- local release gates remain green
- the exact release CI is green on Windows, Linux, and macOS
