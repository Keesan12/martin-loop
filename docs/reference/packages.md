# Package Map

| Package | Role |
|---|---|
| `martin-loop` | Public npm package for the CLI and SDK facade. |
| `@martin/contracts` | Shared types for loops, policy, governance, budget, telemetry, and rollback. |
| `@martin/core` | Runtime controller, policy engine, safety checks, grounding, persistence, and rollback logic. |
| `@martin/adapters` | Claude CLI, Codex CLI, direct-provider, and verifier-only proof-mode adapter surfaces. |
| `@martin/cli` | CLI implementation for `run`, `demo`, `doctor`, `triage`, `dossier`, `inspect`, `resume`, and MCP config helpers. |
| `@martinloop/mcp` | Standalone MCP server with governed execution plus read-only run review tools, resources, and prompts. |

## Install Targets

```sh
npm install martin-loop
npx martin-loop doctor
npx -y @martinloop/mcp
```

Use `martin-loop` for CLI and SDK work. Use `@martinloop/mcp` when an MCP host needs the stdio server directly.
