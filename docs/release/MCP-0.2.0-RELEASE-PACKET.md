# Martin MCP `0.2.0` Release Packet

This packet is the public proof artifact for the `@martinloop/mcp@0.2.0` cockpit expansion contract. It exists to keep the `0.2.0` release boundary distinct from the later 0.2.5 stable cockpit line.

## Version Truth

- standalone package: `@martinloop/mcp`
- target release: `0.2.0`
- public release train:
  - `0.1.4` operator foundation
  - `0.2.0` cockpit expansion
  - `0.2.5` stable cockpit line

See [VERSION-LEDGER.md](./VERSION-LEDGER.md) for the canonical version map.

## Tier Boundary

This packet is a public Free / OSS MCP artifact only.

- separate non-OSS product lines remain outside this public packet
- reviewing this packet does not approve any hosted or non-OSS surface

## Commands Run

The required package-proof gates for this cockpit expansion contract are:

```powershell
pnpm --filter @martinloop/mcp lint
pnpm --filter @martinloop/mcp test
pnpm --filter @martinloop/mcp build
pnpm --filter @martinloop/mcp smoke:pack
pnpm --filter @martinloop/mcp smoke:published:pack
pnpm --filter @martinloop/mcp verify:release
```

## Versions Tested

- root package release lane aligned in this repo: `martin-loop@0.2.4`
- standalone cockpit contract in this packet: `@martinloop/mcp@0.2.0`
- later documented stable cockpit line: `@martinloop/mcp@0.2.5`

## Host Matrix Receipts

- Codex install snippet and profile generation are documented
- Claude Code install snippets for Unix and Windows are documented
- Gemini and generic profile generation are documented
- the public docs align the same tool, resource, and prompt surface across package README, quickstart, and OSS guides

## Mirror Parity Receipts

- `packages/mcp/package.json` and `packages/mcp/server.json` stay aligned to the public docs
- `packages/mcp/src/server.ts`, `resources.ts`, and `prompts.ts` are the source-of-truth contract for tools, resources, and prompts
- `docs/oss` and `docs/release` describe the same cockpit expansion boundary

## 0.2.0 Cockpit Expansion Contract

`0.2.0` adds resources, resource templates, prompts, and read-only cockpit inspection while preserving the existing execution model.

## Cockpit Expansion Contract

### Tools

- `martin_list_runs`
- `martin_get_run`
- `martin_get_attempt`
- `martin_get_verification_results`
- `martin_run_dossier`

### Resources

- `martin://server/health`
- `martin://runs/recent`
- `martin://guides/mcp-usage`
- `martin://guides/publish-readiness`

### Resource templates

- `martin://runs/{loopId}`
- `martin://runs/{loopId}/attempts/{attemptIndex}`
- `martin://runs/{loopId}/verification`

### Prompts

- `martin_governed_coding_kickoff`
- `martin_debug_failed_run`
- `martin_publish_readiness_review`

### Execution semantics

- `martin_run` remains the only write-capable MCP tool.
- `martin_inspect`, `martin_status`, `martin_doctor`, and `martin_preflight` remain backward-compatible.
- The new cockpit expansion surfaces are read-only.

## Later-Line Boundary

The 0.2.5 stable cockpit line is separate from this `0.2.0` packet. 0.2.5 stable cockpit line adds triage and degraded run-store hardening, including `martin_triage_runs`, `martin://runs/triage`, `martin_triage_run_store`, and degraded run-store hardening.

## Contract Boundary

`0.2.0` does not add a second execution entrypoint, remote transport metadata, hosted operations, or any write-capable tool beyond `martin_run`.

## Evidence

The release-doc guard requires this packet and the matching `0.2.0` release notes to prove:

- the `0.2.0` contract includes read-only cockpit inspection
- the `0.2.0` contract includes resources, resource templates, and prompts
- the `0.2.0` contract does not inherit `0.2.5` stable-line triage or hardening claims
- public host docs distinguish the `0.2.0` cockpit expansion from the 0.2.5 stable cockpit line

Required verification gates for a candidate release remain:

```powershell
pnpm --filter @martinloop/mcp lint
pnpm --filter @martinloop/mcp test
pnpm --filter @martinloop/mcp build
pnpm --filter @martinloop/mcp smoke:pack
pnpm --filter @martinloop/mcp smoke:published:pack
pnpm --filter @martinloop/mcp verify:release
```

## Known Non-Goals

- no public npm publish in this packet
- no GitHub release or tag in this packet
- no hosted remote-server claim in this packet
- no new write-capable MCP tool beyond `martin_run`
- no `0.2.5` stable-line triage claim inside the `0.2.0` contract

## Publish Gates Still Pending Explicit Approval

These steps stay blocked until explicitly approved for a later ship step:

- cut or push a publish candidate branch
- create a release tag
- publish the standalone package
- update public GitHub release state for the standalone package

## Ready-To-Push Rule

Do not call this line ready to push until all of these are true:

- version truth still matches [VERSION-LEDGER.md](./VERSION-LEDGER.md)
- public docs still match the actual tools, resources, resource templates, and prompts
- package gates remain green
- the exact candidate branch CI is green on Windows, Linux, and macOS
