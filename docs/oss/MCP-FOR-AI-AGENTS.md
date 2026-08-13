# MCP For AI Agents

`@martinloop/mcp@0.5.0` is the live public standalone MCP baseline for MartinLoop.

It is built for hosts that need a governed local-first workflow, not a vague bag of tools.

## What it is good at

- guiding a host through the MartinLoop flow in the right order
- running one bounded execution lane through `martin_run`
- making saved run records easy to inspect after the work is done
- giving both humans and agents a clean next step instead of raw receipts only

## Start here

1. `martin_doctor`
2. `martin_plan`
3. `martin_preflight`
4. `martin_run`
5. `martin_status` or `martin_logs`
6. `martin_dossier`
7. `martin_eval`

If your host supports tool allow-lists, start with:

- `martin_doctor`
- `martin_plan`
- `martin_preflight`
- `martin_list_runs`
- `martin_triage_runs`
- `martin_dossier`

That keeps the host useful without making execution implicit.

## Install

### Codex

```sh
codex mcp add martin-loop -- npx -y @martinloop/mcp
```

### Claude Code

```sh
# macOS/Linux
claude mcp add --transport stdio --scope user martin-loop -- npx -y @martinloop/mcp

# Windows PowerShell or cmd.exe
claude mcp add --transport stdio --scope user martin-loop -- cmd /c npx -y @martinloop/mcp
```

### Generic stdio config

```json
{
  "type": "stdio",
  "command": "npx",
  "args": ["-y", "@martinloop/mcp"]
}
```

## What comes next in the train

- `0.5.0` is the live public standalone MCP baseline.
- `0.5.0` is the live public standalone MCP baseline.
- `0.3.3` is planned for opt-in execution controls.
- later `0.3.x` follow-ons stay local-first and stdio-first.

None of those slices should imply hosted transport, tenant features, or billing surfaces.
