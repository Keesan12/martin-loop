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

## Proof Receipts

After a governed run, create a share bundle:

```sh
npx martin-loop runs verify --latest
npx martin-loop share --latest
```

The bundle includes `run-receipt.json`, `run-receipt.md`, and `proof-card.svg`. The proof card should look like a terminal receipt: dark canvas, rows, divider lines, monospaced evidence, green pass states, and red boundary states. Keep uncertainty visible. If rollback, integrity, cost, or verifier evidence is missing, render it as missing instead of turning the run into a success claim.

## MCP Profile Defaults

- `minimal` is the default: `martin_doctor`, `martin_preflight`, `martin_list_runs`, `martin_triage_runs`, and `martin_run_dossier`.
- `diagnostic` adds deeper read-only run inspection without `martin_run`.
- `full-local` exposes the full local cockpit, including `martin_run`.
- `starter` and `full` remain compatibility aliases.

## Host Setup

Codex:

```sh
codex mcp add martin-loop -- npx -y @martinloop/mcp
npx -y martin-loop mcp print-config --host codex --profile minimal
```

Claude Code:

```sh
claude mcp add --transport stdio --scope user martin-loop -- npx -y @martinloop/mcp
npx -y martin-loop mcp print-config --host claude --profile minimal
```

Cursor, VS Code, and generic MCP wrappers:

```sh
npx -y martin-loop mcp print-config --host generic --profile minimal
npx -y martin-loop mcp print-config --host generic --profile diagnostic
npx -y martin-loop mcp print-config --host generic --profile full-local
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

## Troubleshooting

- If no runs exist, call `martin_doctor` and run the demo path.
- If the verifier failed, use `martin_triage` or `martin_debug_failed_run` before spending another attempt.
- If context is tight, read `martin://agent/next-step` first.
- If a host shows too many tools, switch to `--profile minimal` or `--profile diagnostic`.
