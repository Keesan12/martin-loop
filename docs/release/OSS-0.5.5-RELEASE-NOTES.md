# MartinLoop 0.5.5

MartinLoop 0.5.5 makes autonomous coding runs more capable while keeping MartinLoop in charge of the safety boundary. Define the governed contract once, let the coding agent work without repeated permission prompts, and receive a verified outcome backed by receipt evidence.

## Highlights

- A provider-neutral governed-autonomous contract maps consistently across Codex, Claude Code, Gemini, and future coding-agent integrations.
- Codex capability negotiation probes the exact selected executable and chooses only a workspace-bound, non-interactive strategy that the installed CLI actually supports.
- Provider execution timeouts are finite, configurable, and independent from verifier timeouts, so legitimate long-running work can finish without removing hard governance stops.
- Outside-workspace writes and interactive permission downgrades remain blocked.
- Grounding accepts declarations introduced by legitimate new patch files while preserving missing-file and scope checks.
- Terminal and MCP users receive the same authoritative `VERIFIED`, `STOPPED`, or `NEEDS REVIEW` outcome with clearer human-first proof output.
- Published root and MCP packages exclude internal-only compatibility adapters while retaining the source-level compatibility needed by tests.

## Install

```bash
npx -y martin-loop@0.5.5 --version
npx -y martin-loop@0.5.5 start
```

For MCP hosts, use `@martinloop/mcp@0.5.5`.
