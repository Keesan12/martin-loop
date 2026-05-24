# MartinLoop OSS `0.2.1` Release Notes

`martin-loop@0.2.1` adds local MCP install profiles so hosts can start read-only by default and opt into local execution only when they need it.

## Included

- `minimal` profile for cheap read-only local MCP installs
- `diagnostic` profile for deeper run inspection without enabling execution
- `full-local` profile for local execution hosts that should expose `martin_run`
- generated local stdio config for Codex, Claude Code, Gemini, and generic MCP hosts
- explicit profile reporting in `martin doctor` and `martin mcp print-config`
- compatibility aliases `starter` and `full`

## Not Included

- standalone `@martinloop/mcp` version bump
- run triage scoring changes
- Context Diet compact resources
- prompt pack rollout
