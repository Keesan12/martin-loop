# Agent Start Here

Martin Loop is a local governor for autonomous coding agents. Use it before spending tokens on a run, before retrying a failed run, and before claiming a run succeeded.

## Three-Minute Path

```sh
npx martin-loop doctor
npx martin-loop demo
cd martin-loop-demo
```

Windows PowerShell no-spend proof run:

```powershell
$env:MARTIN_LIVE='false'
npx martin-loop run "Summarize the demo workspace and prove tests still pass" --verify "npm test"
npx martin-loop dossier --latest
Remove-Item Env:MARTIN_LIVE
```

macOS/Linux no-spend proof run:

```sh
MARTIN_LIVE=false npx martin-loop run "Summarize the demo workspace and prove tests still pass" --verify "npm test"
npx martin-loop dossier --latest
```

Expected value: the dossier tells you what happened, what Martin prevented, verifier status, rollback/artifact evidence, clearly labeled token/cost estimates, and the next safe action.

## MCP Profile Defaults

- `starter` is the default generated profile: `martin_doctor`, `martin_preflight`, `martin_run`, `martin_triage_runs`, and `martin_run_dossier`.
- `full` adds deeper inspection without changing the package or transport surface.
- Both generated profiles include `martin_run` in `0.2.5`.

If you need a strict read-only allow-list, start from the manual config examples in the MCP docs and omit `martin_run` before saving the block.

## Host Setup

Codex:

```sh
codex mcp add martin-loop -- npx -y @martinloop/mcp
npx martin-loop mcp print-config --host codex --profile starter
```

Claude Code:

```sh
claude mcp add --transport stdio --scope user martin-loop -- npx -y @martinloop/mcp
npx martin-loop mcp print-config --host claude --profile starter
```

Cursor, VS Code, and generic MCP wrappers:

```sh
npx martin-loop mcp print-config --host generic --profile starter
npx martin-loop mcp print-config --host generic --profile full
```

## Agent Rule To Paste

Before running or retrying autonomous coding work, call Martin first. Prefer compact resources before full JSON. Never claim success unless the verifier evidence supports it.

Recommended compact resources:

- `martin://agent/next-step`
- `martin://runs/latest/summary`
- `martin://runs/latest/proof-card`
- `martin://runs/latest/budget-status`
- `martin://runs/latest/verifier-evidence`
- `martin://runs/latest/rollback-evidence`

Recommended prompts:

- `martin_start`
- `martin_preflight`
- `martin_triage`
- `martin_resume`
- `martin_prove`
- `martin_release_check`
- `martin_review_run` (compatibility alias)
- `martin_triage_failures` (compatibility alias)

## Troubleshooting

- If no runs exist, call `martin_doctor` and run the demo path.
- If the verifier failed, use `martin_triage` or `martin_debug_failed_run` before spending another attempt.
- If context is tight, read `martin://agent/next-step` first.
- If a host shows too many tools, start from the manual read-only allow-list instead of the generated `starter` or `full` profiles.
