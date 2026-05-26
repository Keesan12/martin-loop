# Martin MCP Release Checklist

Use this checklist before calling a Martin MCP release ready.

## Source of Truth

- confirm `packages/mcp` is the public release source of truth
- confirm any downstream workspace copy is treated as a one-way sync target only

## Metadata

- `packages/mcp/package.json` version matches `packages/mcp/server.json`
- the matching `docs/release/MCP-X.Y.Z-RELEASE-NOTES.md` exists
- the matching `docs/release/MCP-X.Y.Z-RELEASE-PACKET.md` exists
- `docs/release/VERSION-LEDGER.md` matches live npm, public GitHub `main`, and the local integrated tree

## Docs

- `packages/mcp/README.md` matches the shipped MCP surface
- `docs/oss/MCP-FOR-AI-AGENTS.md` matches the shipped MCP surface
- `docs/oss/QUICKSTART.md` matches the shipped MCP surface
- `docs/release/MCP-PUBLISHING.md` keeps pre-publish and post-publish smoke gates separate

## Verification

- `pnpm --filter @martinloop/mcp lint`
- `pnpm --filter @martinloop/mcp test`
- `pnpm --filter @martinloop/mcp build`
- `pnpm --filter @martinloop/mcp smoke:pack`
- `pnpm --filter @martinloop/mcp smoke:published:pack`
- `pnpm --filter @martinloop/mcp verify:release`

## Source Sync

- sync `packages/mcp` only from the public release source into downstream workspace copies
- resync built artifacts only after a clean local build so stale packaged version labels do not survive
- sync MCP-facing docs from the public release source after release-doc tests pass
- update non-public planning notes outside the public release docs with repo truth, verification, blockers, and next step

## Candidate Branch Proof

- the exact candidate branch has CI proof on Windows, Linux, and macOS
- doc and version parity checks pass in CI on that exact pushed candidate commit
