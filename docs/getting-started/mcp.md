# MCP Setup

The `@martinloop/mcp` package exposes MartinLoop through stdio by default and can also run as a local HTTP MCP endpoint when a bridge or proxy needs one.

`0.3.6` is the current public MCP package line. It adds an HTTP transport option for local bridges and a `mode-status` resource so hosts can read the current MartinLoop working mode before they start a run.

## Install

Run the packaged server directly:

```sh
npx -y @martinloop/mcp
```

Add it to Codex:

```sh
codex mcp add martin-loop -- npx -y @martinloop/mcp
```

Add it to Claude Code:

macOS/Linux:

```sh
claude mcp add --transport stdio --scope user martin-loop -- npx -y @martinloop/mcp
```

Windows:

```sh
claude mcp add --transport stdio --scope user martin-loop -- cmd /c npx -y @martinloop/mcp
```

Optional local HTTP endpoint:

```sh
npx -y @martinloop/mcp --http --port 3033
```

## Generate Host Config

```sh
npx martin-loop mcp print-config --host codex --transport stdio --profile minimal
npx martin-loop mcp print-config --host claude --transport stdio --profile diagnostic
npx martin-loop mcp print-config --host gemini --transport stdio --profile full-local
npx martin-loop mcp print-config --host generic --transport stdio --profile github-review
```

`npx martin-loop mcp install` writes only when the target file is absent or when it detects an existing MartinLoop block it can update safely. For hand-maintained host configs, print the config and merge it yourself.

## Recommended Host Flow

1. Call `martin_doctor`.
2. Call `martin_plan` to outline the task before spending a run.
3. Call `martin_preflight` to validate verifier, scope, and budget.
4. Use `martin_run` for the governed execution step.
5. Use `martin_status` or `martin_logs` for live posture when the host needs it.
6. Use `martin_dossier`, `martin_eval`, or the `martin_get_*` tools for evidence review.

If the host tries to skip straight to `martin_run`, MartinLoop now blocks the call and points back to the missing step. That is deliberate. It keeps the "safe by default" path visible instead of relying on convention.

## Start Safe

If your host supports allow-lists, start with the `minimal` profile or an equivalent manual allow-list:

- `martin_doctor`
- `martin_plan`
- `martin_preflight`
- `martin_list_runs`
- `martin_triage_runs`
- `martin_dossier`

Expanded profiles add `martin_run`, run-control helpers, and GitHub review helpers only when the host actually needs them.

More detail: [MCP tool reference](../reference/mcp-tools.md) and [MCP compatibility](../reference/mcp-compatibility.md).
