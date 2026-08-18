# @martinloop/mcp 0.5.1

MartinLoop MCP 0.5.1 brings governed coding-agent evidence into Codex, Claude Code, Cursor, VS Code, and other compatible MCP hosts without replacing the host's model selection.

## Highlights

- Markdown-first tool responses for human and agent discovery, with full `structuredContent` and compatibility JSON preserved.
- Governed Run Plan, Verified Handoff, dossier, verification, receipt-integrity, and recovery information grounded in persisted run evidence.
- Explicit verification-only provenance: configured checks run for real, but the result cannot masquerade as a governed editing run.
- Cost provenance carried through run and status outputs as provider-settled, calculated from observed usage, estimated, or unavailable.
- Install, verify, rollback, and uninstall flows for supported hosts.
- MCPB `0.5.1` build, validation, runtime smoke, archive inspection, and SHA-256 release attachment.

## Install

```sh
npx -y @martinloop/mcp@0.5.1
```

MartinLoop reports what its configured checks and persisted evidence establish. It does not invent execution, model identity, spend, or verification authority.
