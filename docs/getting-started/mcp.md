# MCP Setup

The `@martinloop/mcp` package exposes MartinLoop through stdio for MCP-capable hosts.

`0.5.3` is the current in-repo MCP release target. It aligns the MCP surface with MartinLoop's end-to-end execution-control model and the capability-driven Codex host work in the root package.

MartinLoop does not replace the host's coding agent or model selection. It connects the run around that agent from Definition of Done through preflight, control, verification, recovery evidence, receipts, and post-run analysis.

For agent-readable context see [`../../llms.txt`](../../llms.txt), [`../../llms-full.txt`](../../llms-full.txt), and [`../for-agents.md`](../for-agents.md).

## Install

Run the packaged server directly:

```sh
npx -y @martinloop/mcp@0.5.3
```

Add it to Codex:

```sh
codex mcp add martin-loop -- npx -y @martinloop/mcp@0.5.3
```

Add it to Claude Code:

macOS/Linux:

```sh
claude mcp add --transport stdio --scope user martin-loop -- npx -y @martinloop/mcp@0.5.3
```

Windows:

```sh
claude mcp add --transport stdio --scope user martin-loop -- cmd /c npx -y @martinloop/mcp@0.5.3
```

## Generate Host Config

```sh
npx martin-loop mcp print-config --host codex --transport stdio --profile minimal
npx martin-loop mcp print-config --host claude --transport stdio --profile diagnostic
npx martin-loop mcp print-config --host gemini --transport stdio --profile full-local
npx martin-loop mcp print-config --host cursor --transport stdio --profile minimal
npx martin-loop mcp print-config --host vscode --transport stdio --profile minimal
npx martin-loop mcp print-config --host generic --transport stdio --profile github-review
```

`npx martin-loop mcp install` writes only when the target file is absent or when it detects an existing MartinLoop block it can update safely. For hand-maintained host configs, print the config and merge it yourself.

File-based installs are recorded locally so MartinLoop can verify and safely reverse only the changes it made:

```sh
npx martin-loop mcp verify-install --host cursor --scope project
npx martin-loop mcp rollback --host cursor --scope project
npx martin-loop mcp uninstall --host cursor --scope project
```

Rollback and uninstall refuse to overwrite a host config that changed after installation. VS Code user installs use the native `MCP: Add Server` command; project installs use `.vscode/mcp.json` and support the same verification lifecycle.

## Recommended Host Flow

1. Call `martin_doctor`.
2. Call `martin_plan` to outline the task before spending a run.
3. Call `martin_preflight` to validate verifier, scope, and budget.
4. Use `martin_run` for the governed execution step.
5. Use `martin_status` or `martin_logs` for live posture when the host needs it.
6. Use `martin_dossier`, `martin_eval`, or the `martin_get_*` tools for evidence review.

The broader lifecycle is:

```text
DEFINE -> PREFLIGHT -> CONTROL -> VERIFY -> RECOVER -> PROVE -> ANALYZE
```

If the host tries to skip straight to `martin_run`, MartinLoop blocks the call when required workflow evidence is missing and points back to the next required step. That keeps the governed path explicit before agent spend.

## Start Safe

If your host supports allow-lists, start with the `minimal` profile or an equivalent manual allow-list:

- `martin_doctor`
- `martin_plan`
- `martin_preflight`
- `martin_list_runs`
- `martin_triage_runs`
- `martin_dossier`

Expanded profiles add `martin_run`, run-control helpers, and GitHub review helpers only when the host actually needs them.

## Truth boundary

MCP presentation does not create stronger evidence than the underlying run.

- `VERIFIED` requires configured evidence supporting the Definition of Done.
- `STOPPED` requires a configured hard boundary.
- `NEEDS REVIEW` is used when completion cannot be established.
- `MARTIN_LIVE=false` can provide inspection or verifier evidence, but it is not a governed coding-agent editing run.

More detail: [MCP tool reference](../reference/mcp-tools.md) and [MCP compatibility](../reference/mcp-compatibility.md).
