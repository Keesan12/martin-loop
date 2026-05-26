# Martin MCP `0.2.5` Release Packet

This packet is the public proof bundle for `@martinloop/mcp@0.2.5`. It records the validation and release-contract evidence for the stable cockpit line.

## Version Truth

- standalone package: `@martinloop/mcp`
- live npm latest before `mcp-v0.2.5`: `0.2.0`
- public GitHub `main` target for `mcp-v0.2.5`: `0.2.5`
- public release lineage:
  - `0.1.4` operator foundation
  - `0.2.0` cockpit expansion
  - `0.2.5` stable cockpit line

See [VERSION-LEDGER.md](./VERSION-LEDGER.md) for the canonical version map.

## Public Boundary

This packet only covers the public `@martinloop/mcp` package surface described in the README, quickstart, and release notes.

## Commands Run

Local OSS gates that passed after numbering normalization:

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

## Versions Tested

- root package release candidate tree: `martin-loop@0.2.5`
- standalone MCP local integrated tree: `@martinloop/mcp@0.2.5`

## Host Matrix Receipts

Local and documented proof currently includes:

- Windows local proof
- Ubuntu/Linux local proof
- macOS proof from the release matrix on the pushed public commit
- Codex config generation and live verification
- Claude Code config generation and live verification
- Gemini config generation and live verification
- Inspector local proof

## Mirror Parity Receipts

- `packages/mcp/package.json` matches the standalone MCP server metadata
- `packages/mcp/server.json` matches the standalone MCP package metadata
- `packages/mcp/src/package-version.ts` matches the standalone MCP package metadata
- MCP-facing `docs/oss` and `docs/release` match the public MCP package surface

## Known Non-Goals

- no new MCP tools beyond the documented cockpit surface
- no public `server.json.remotes` entry
- no undocumented remote transport claims
- no direct raw-model MCP compatibility claims for Gemma, Nemotron, or similar model families

## Publish Gates Still Pending Explicit Approval

These steps must stay green for the tagged release commit:

- push the exact release commit
- run CI on the exact pushed commit
- tag `mcp-v0.2.5`
- publish npm through GitHub Actions trusted publishing
- update the GitHub release notes from `docs/release/MCP-0.2.5-RELEASE-NOTES.md`

## Ready-To-Push Rule

Do not call the train ready to push until all of these are true:

- version truth is still consistent with [VERSION-LEDGER.md](./VERSION-LEDGER.md)
- release docs, manifest, and `server.json` all align
- mirror parity still holds
- local OSS gates remain green
- the exact candidate branch CI is green on Windows, Linux, and macOS
