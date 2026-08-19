# @martinloop/mcp 0.5.3

MartinLoop MCP 0.5.3 aligns the MCP surface with the 0.5.3 execution-control release and keeps the same evidence model available inside compatible coding-agent hosts.

## Highlights

- Governed Run Plan, preflight, run status, Verified Handoff, dossier, receipt integrity, and recovery information remain available through one MCP surface.
- Human-readable Markdown stays first while structured content remains available for agents and automation.
- The MCP surface preserves the same `VERIFIED`, `STOPPED`, and `NEEDS REVIEW` completion truth as the CLI.
- Cost output keeps provider-settled, calculated, estimated, and unavailable provenance distinct.
- Verification-only execution remains explicitly separate from a governed coding-agent run and cannot claim governed completion.
- Plugin and MCP package metadata are aligned at `0.5.3` for easier host discovery and deterministic installation.

## One lifecycle instead of a patchwork

MartinLoop is designed to manage the run around the coding agent from preflight through post-run evidence. Through MCP, compatible hosts can inspect and operate the same connected lifecycle without replacing the host's own model selection.

```text
DEFINE
  -> PREFLIGHT
  -> CONTROL
  -> VERIFY
  -> RECOVER
  -> PROVE
  -> ANALYZE
```

## Install

```sh
npx -y @martinloop/mcp@0.5.3
```

MartinLoop reports what its configured checks and persisted evidence establish. It does not invent execution, model identity, spend, or verification authority.
