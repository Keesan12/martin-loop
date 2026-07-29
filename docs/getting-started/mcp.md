# MCP Setup

The `@martinloop/mcp` package exposes MartinLoop through stdio for MCP-capable hosts.

Machine-readable release truth for the current public OSS line lives in [`distribution/release-truth.json`](../../distribution/release-truth.json). The human-facing release map lives in [`docs/release/VERSION-LEDGER.md`](../release/VERSION-LEDGER.md).

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

## Generate Host Config

```sh
npx martin-loop mcp print-config --host codex --transport stdio --profile minimal
npx martin-loop mcp print-config --host claude --transport stdio --profile diagnostic
npx martin-loop mcp print-config --host gemini --transport stdio --profile full-local
npx martin-loop mcp print-config --host cursor --transport stdio --profile starter
npx martin-loop mcp print-config --host copilot --transport stdio --profile starter
npx martin-loop mcp print-config --host continue --transport stdio --profile starter
npx martin-loop mcp print-config --host generic --transport stdio --profile github-review
```

`npx martin-loop mcp install` writes only when the target file is absent or when it detects an existing MartinLoop block it can update safely. For hand-maintained host configs, print the config and merge it yourself.

Supported MCP config targets from the root CLI are `codex`, `claude`, `gemini`, `cursor`, `copilot`, `continue`, and `generic`.

## Native Installer

Preview the exact config, target path, enabled tools, and governance guidance before writing anything:

```sh
npx martin-loop mcp install --host codex --scope project --profile minimal --dry-run
```

Remove `--dry-run` only after the preview matches the host and scope you intend to configure. The installer creates an absent config or updates an existing MartinLoop entry it can merge safely. It refuses to overwrite an existing config it cannot merge.

All hosts support `user` and `project` scopes. Claude Code also supports `local`, which runs `claude mcp add --scope local` instead of writing a config file.

| Host | `--host` | User target | Project target | Governance guidance |
| --- | --- | --- | --- | --- |
| Codex | `codex` | `$CODEX_HOME/config.toml (defaults to ~/.codex/config.toml)` | `.codex/config.toml` | `AGENTS.md or ~/.codex/instructions.md` |
| Claude Code | `claude` | `~/.claude.json` | `.mcp.json`; local scope uses `claude mcp add --scope local` | `~/.claude/settings.json` |
| Gemini CLI | `gemini` | `~/.gemini/settings.json` | `.gemini/settings.json` | `GEMINI.md or ~/.gemini/GEMINI.md` |
| Cursor | `cursor` | `~/.cursor/mcp.json` | `.cursor/mcp.json` | `.cursor/rules/martin-governance.mdc` |
| VS Code / GitHub Copilot | `copilot` | `~/.vscode/settings.json` | `.vscode/settings.json` | `.github/copilot-instructions.md` |
| Continue | `continue` | `~/.continue/config.json` | `.continue/config.json` | `.continue/rules/martin-governance.md` |
| Generic MCP host | `generic` | `~/.martin-loop/mcp.generic.json` | `.martin-loop/mcp.generic.json` | `Manual host instructions` |

`print-config`, `install --dry-run`, and `install` all return host-specific governance guidance. The Claude installer also merges its MartinLoop hooks into `~/.claude/settings.json`; other hosts receive instructions and content for their native governance file.

## Profiles

- `minimal`: readiness, planning, preflight, run lookup, triage, and dossier tools.
- `diagnostic`: expanded read-only diagnosis and evidence inspection.
- `github-review`: review-focused tools for GitHub work.
- `full-local`: the complete local tool set, including governed execution.
- `paid-remote`: the complete remote tool set; remote policy and host opt-ins still apply.
- `starter`: a broader onboarding set for interactive hosts.
- `full`: the complete available tool set.

Local `stdio` transport is the default. Remote transport for Cursor, VS Code / GitHub Copilot, and Continue requires `--experimental-remote-hosts`.

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
