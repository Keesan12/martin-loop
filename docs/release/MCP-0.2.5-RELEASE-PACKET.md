# Martin MCP `0.2.5` Release Packet

This packet is the archived proof bundle for the `@martinloop/mcp@0.2.5` public package line. It remains in the repo as historical release evidence; use [MCP-0.2.7-RELEASE-PACKET.md](./MCP-0.2.7-RELEASE-PACKET.md) for the current standalone MCP package line.

## Version Truth

- standalone package line covered by this packet: `@martinloop/mcp@0.2.5`
- live npm latest now: `0.2.7`
- public GitHub `main` now tracks: `0.2.7`
- current repo package manifest now: `0.2.7`
- public scheduled release train:
  - `0.1.4` operator foundation
  - `0.2.0` cockpit expansion
  - `0.2.5` public MCP package line

See [VERSION-LEDGER.md](./VERSION-LEDGER.md) for the canonical version map.

## Public Boundary

This packet covers only the public MCP package surface documented in this repo.

- non-public planning material stays out of this packet
- experimental or non-public capabilities stay out of this packet
- reviewing this packet does not expand the public package claim beyond the shipped OSS surface

## Commands Run

Historical release gates recorded for this package line:

```powershell
pnpm --filter @martin/contracts lint
pnpm --filter @martin/contracts build
pnpm --filter @martin/cli lint
pnpm --filter @martin/cli test
pnpm --filter @martin/cli build
pnpm --filter @martin/cli verify:hosts:live
pnpm --filter @martinloop/mcp lint
pnpm --filter @martinloop/mcp test
pnpm --filter @martinloop/mcp build
pnpm --filter @martinloop/mcp smoke:pack
pnpm --filter @martinloop/mcp smoke:published:pack
pnpm --filter @martinloop/mcp verify:release
pnpm --filter @martinloop/mcp inspect:live
pnpm lint
pnpm test
pnpm build
pnpm oss:validate
pnpm public:smoke
```

Additional experiments or unpublished work do not expand or alter the public `@martinloop/mcp` package contract.

## Versions Tested

- root package current repo manifest: `martin-loop@0.2.11`
- standalone MCP release line covered by this packet: `@martinloop/mcp@0.2.5`
- current standalone MCP repo manifest: `@martinloop/mcp@0.2.7`

## Host Matrix Receipts

Local and documented proof currently includes:

- Windows local proof
- Ubuntu/Linux local proof
- hosted macOS CI proof on the pushed public `main` commit
- Codex config generation and live verification
- Claude Code config generation and live verification
- Gemini config generation and live verification
- Inspector local and remote proof

The remaining honesty boundary is unchanged: the current checkout has not itself been executed on a live macOS runner. That proof requires the exact pushed release commit to pass on a real macOS execution surface.

## Source Parity Receipts

- `packages/mcp/package.json` matches the standalone MCP server metadata
- `packages/mcp/server.json` matches the standalone MCP package metadata
- `packages/mcp/src/package-version.ts` matches the standalone MCP package metadata
- MCP-facing `docs/oss` and `docs/release` match the public MCP package surface

## Known Non-Goals

- no new public MCP tools beyond the current cockpit surface
- no public `server.json.remotes` entry
- no npm publish in this step
- no public registry update in this step
- no public remote-beta promotion in this step
- no direct raw-model MCP compatibility claims for Gemma, Nemotron, or similar model families

## Publish Gates Still Pending Explicit Approval

These steps remain intentionally blocked until explicit approval:

- create the exact release branch for the next public delivery
- push that release branch
- run candidate-branch CI on the exact pushed commit
- tag the release
- publish npm
- update public GitHub releases

## Ready-To-Push Rule

Do not call the train ready to push until all of these are true:

- version truth is still consistent with [VERSION-LEDGER.md](./VERSION-LEDGER.md)
- release docs, manifest, and `server.json` all align
- source parity still holds
- local release gates remain green
- the exact release CI is green on Windows, Linux, and macOS
