# MCP Setup

The `@martinloop/mcp` package lets an MCP-capable coding environment plug into MartinLoop directly.

MartinLoop is one system around coding agents so people can go from intent to a production-quality software handoff without stitching together separate tools around the agent. The coding agent still writes the code; MartinLoop connects the surrounding workflow so the host can define what should ship, run the work, check the result, recover when needed, and understand the handoff.

The public MCP package uses local stdio transport. MartinLoop does not replace the host's coding agent or silently take over model selection.

For agent-readable context see [`../../llms.txt`](../../llms.txt), [`../../llms-full.txt`](../../llms-full.txt), and [`../for-agents.md`](../for-agents.md).

## Install

Run the packaged server directly:

```sh
npx -y @martinloop/mcp@latest
```

Add it to Codex:

```sh
codex mcp add martin-loop -- npx -y @martinloop/mcp@latest
```

Add it to Claude Code on macOS/Linux:

```sh
claude mcp add --transport stdio --scope user martin-loop -- npx -y @martinloop/mcp@latest
```

Windows:

```sh
claude mcp add --transport stdio --scope user martin-loop -- cmd /c npx -y @martinloop/mcp@latest
```

## Generate host config

```sh
npx martin-loop@latest mcp print-config --host codex --transport stdio --profile minimal
npx martin-loop@latest mcp print-config --host claude --transport stdio --profile diagnostic
npx martin-loop@latest mcp print-config --host gemini --transport stdio --profile full-local
npx martin-loop@latest mcp print-config --host cursor --transport stdio --profile minimal
npx martin-loop@latest mcp print-config --host vscode --transport stdio --profile minimal
npx martin-loop@latest mcp print-config --host generic --transport stdio --profile github-review
```

`npx martin-loop@latest mcp install` writes only when the target file is absent or when it detects an existing MartinLoop block it can update safely. For hand-maintained host configs, print the config and merge it yourself.

File-based installs are recorded locally so MartinLoop can verify and safely reverse only the changes it made:

```sh
npx martin-loop@latest mcp verify-install --host cursor --scope project
npx martin-loop@latest mcp rollback --host cursor --scope project
npx martin-loop@latest mcp uninstall --host cursor --scope project
```

Rollback and uninstall refuse to overwrite a host config that changed after installation. VS Code user installs use the native `MCP: Add Server` command; project installs use `.vscode/mcp.json` and support the same verification lifecycle.

## What the host gets

Once connected, the host can use one MartinLoop workflow around the coding task instead of treating the agent as a black box that simply returns a diff.

A typical flow is:

1. Use `martin_doctor` to check the environment.
2. Use `martin_plan` to turn the task into an explicit finish line.
3. Use `martin_preflight` to check readiness before committing to the run.
4. Use `martin_run` when the coding agent should do the work.
5. Use `martin_status` or `martin_logs` when the host needs live context.
6. Use `martin_dossier`, `martin_eval`, or the `martin_get_*` tools to understand the result and prepare the handoff.

The internal lifecycle is:

```text
DEFINE -> PREFLIGHT -> CONTROL -> VERIFY -> RECOVER -> PROVE -> ANALYZE
```

The simpler product-level version is:

```text
Definition of Done -> Agent Work -> Verified Handoff
```

If the host tries to jump directly into a governed run while required workflow evidence is missing, MartinLoop can point it back to the next required step.

## Start safe

If the host supports allow-lists, start with the `minimal` profile or an equivalent manual allow-list:

- `martin_doctor`
- `martin_plan`
- `martin_preflight`
- `martin_list_runs`
- `martin_triage_runs`
- `martin_dossier`

Expanded profiles add live execution, run-control helpers, and GitHub review helpers when the host actually needs them.

## Truth boundary

MCP presentation does not create stronger evidence than the underlying run.

- `VERIFIED` means the configured evidence supports the Definition of Done.
- `STOPPED` means a configured execution boundary ended the run.
- `NEEDS REVIEW` means completion could not be established from the available evidence.
- `MARTIN_LIVE=false` can provide inspection or verification evidence, but it is not proof that a coding agent edited the repository.

A configured verifier proves only what it checks. `VERIFIED` is not a claim that software is universally bug-free or automatically safe to merge.

More detail: [MCP tool reference](../reference/mcp-tools.md) and [MCP compatibility](../reference/mcp-compatibility.md).
