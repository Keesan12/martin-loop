# Martin MCP `0.2.5` Release Packet

This packet is the local proof bundle for the current integrated `@martinloop/mcp` tip. It is the release artifact to review before any later branch cut, push, tag, or npm publish.

## Version Truth

- standalone package: `@martinloop/mcp`
- live npm latest: `0.1.3`
- public GitHub `main`: `0.1.3`
- local integrated tip: `0.2.5`
- public scheduled release train:
  - `0.1.4` operator foundation
  - `0.2.0` cockpit expansion
  - `0.2.5` stable cockpit line

See [VERSION-LEDGER.md](./VERSION-LEDGER.md) for the canonical version map.

## Tier Boundary

This packet is a public Free / OSS MCP artifact only.

- Pro, Growth, Enterprise, and Internal remain private tier lanes.
- private Pro remote MCP private beta and principal-aware remote config remain outside this packet
- Reviewing this packet does not approve promotion of private control-plane, autonomy, or router internals into the OSS package or docs.

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

Focused post-cleanup checks that passed:

```powershell
pnpm test
pnpm lint
pnpm build
pnpm smoke:remote
pnpm smoke:remote:live
```

The focused private checks were run in `enterprise/apps/control-plane` to confirm the remote beta and policy surfaces still match the normalized MCP line.

## Versions Tested

- root package local integrated tree: `martin-loop@0.1.6`
- standalone MCP local integrated tree: `@martinloop/mcp@0.2.5`
- private control plane local integrated tree: `@martin/control-plane@0.2.5-local`

## Host Matrix Receipts

Local and documented proof currently includes:

- Windows local proof
- Ubuntu/Linux local proof
- hosted macOS CI proof on the pushed public `main` commit
- Codex config generation and live verification
- Claude Code config generation and live verification
- Gemini config generation and live verification
- Inspector local and remote proof

The remaining honesty boundary is unchanged: the current unpushed local tree has not itself been executed on a live macOS runner. That proof requires a pushed candidate branch or another real macOS execution surface.

## Mirror Parity Receipts

- `packages/mcp/package.json` matches the private `oss-core` mirror
- `packages/mcp/server.json` matches the private `oss-core` mirror
- `packages/mcp/src/package-version.ts` matches the private `oss-core` mirror
- MCP-facing `docs/oss` and `docs/release` are synced into the private `oss-core` mirror
- stale mirror `packages/mcp/dist` artifacts were resynced from the OSS build output so the mirror no longer advertises `0.3.0`

## Known Non-Goals

- no new public MCP tools beyond the current cockpit surface
- no public `server.json.remotes` entry
- no npm publish in this step
- no public registry update in this step
- no public remote-beta promotion in this step
- no direct raw-model MCP compatibility claims for Gemma, Nemotron, or similar model families

## Publish Gates Still Pending Explicit Approval

These steps remain intentionally blocked until explicit approval:

- create the exact release candidate branch for the next public delivery
- push that candidate branch
- run candidate-branch CI on the exact pushed commit
- tag the release
- publish npm
- update public GitHub releases

## Ready-To-Push Rule

Do not call the train ready to push until all of these are true:

- version truth is still consistent with [VERSION-LEDGER.md](./VERSION-LEDGER.md)
- release docs, manifest, and `server.json` all align
- mirror parity still holds
- local OSS gates remain green
- the exact candidate branch CI is green on Windows, Linux, and macOS
