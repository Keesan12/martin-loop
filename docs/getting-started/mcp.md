# MCP Setup

The `@martinloop/mcp` package exposes MartinLoop through stdio for MCP-capable hosts.

## Install

Run the server directly:

```sh
npx -y @martinloop/mcp
```

Add it to Codex:

```sh
codex mcp add martin-loop -- npx -y @martinloop/mcp
```

Add it to Claude Code:

```sh
claude mcp add --transport stdio --scope user martin-loop -- npx -y @martinloop/mcp
```

Windows PowerShell or cmd.exe:

```sh
claude mcp add --transport stdio --scope user martin-loop -- cmd /c npx -y @martinloop/mcp
```

## Generate Host Config

```sh
npx martin-loop mcp print-config --host codex --transport stdio --profile starter
npx martin-loop mcp print-config --host claude --transport stdio --profile full
npx martin-loop mcp print-config --host gemini --transport stdio --profile starter
```

`npx martin-loop mcp install` writes only when the target file is absent or when it detects an existing MartinLoop block it can update safely. For hand-maintained host configs, print the config and merge it yourself.

## Recommended Flow

1. Call `martin_doctor`.
2. Call `martin_preflight` before non-trivial execution.
3. Use `martin_run` as the execution entrypoint.
4. Use `martin_triage_runs` to rank persisted runs.
5. Read `martin://agent/next-step`, `martin://runs/latest/summary`, or `martin://runs/latest/proof-card`.
6. Use `martin_run_dossier` or the `martin_get_*` tools when compact evidence says deeper inspection is needed.

## Read-Only Starting Point

If your host supports tool allow-lists, start with:

- `martin_doctor`
- `martin_preflight`
- `martin_list_runs`
- `martin_triage_runs`
- `martin_run_dossier`

The generated starter and full profiles include `martin_run`, so use a manual allow-list when you want inspection without execution.

More detail: [MCP tool reference](../reference/mcp-tools.md).
