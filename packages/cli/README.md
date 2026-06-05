# @martin/cli

CLI implementation for MartinLoop.

The CLI groups execution, readiness checks, persisted-run inspection, and MCP host setup into one command set:

- `martin-loop doctor`
- `martin-loop demo`
- `martin-loop preflight`
- `martin-loop run`
- `martin-loop triage`
- `martin-loop dossier`
- `martin-loop runs list|get|attempt|verify`
- `martin-loop mcp print-config`
- `martin-loop mcp install`

## Output Modes

- default: human-readable summaries
- `--json`: machine-readable payloads
- `--quiet`: script-friendly primary identifier or path only

## Recommended Flow

```sh
martin-loop doctor
martin-loop preflight "inspect the latest MCP run and confirm the verifier stays green" --verify "pnpm --filter @martinloop/mcp test"
martin-loop run "inspect the latest MCP run and confirm the verifier stays green" --verify "pnpm --filter @martinloop/mcp test"
martin-loop triage
martin-loop dossier --latest
```

## MCP Config

`martin-loop mcp print-config --host codex` emits a quoted TOML server key:

```toml
[mcp_servers."martin-loop"]
command = "npx"
args = ["-y", "@martinloop/mcp"]
cwd = "C:\\path\\to\\repo"
startup_timeout_sec = 20
tool_timeout_sec = 180
enabled_tools = [
  "martin_doctor",
  "martin_preflight",
  "martin_run",
  "martin_triage_runs",
  "martin_run_dossier",
]
env = { MARTIN_RUNS_DIR = "C:\\path\\to\\runs" }
```

`martin-loop mcp install` is conservative: it writes only when the target file is absent or when it detects an existing MartinLoop block it can update safely. For mixed host configs, use `martin-loop mcp print-config` and merge the MartinLoop block yourself.

## Host Coverage

- `codex`: local stdio profiles
- `claude`: local, user, and project scopes
- `gemini`: local `settings.json` snippets with `includeTools`
- `generic`: JSON config for wrapper hosts and MCP-aware agent shells

Generated stdio launchers are platform-aware:

- Windows uses `cmd /c npx -y @martinloop/mcp`
- macOS and Linux use `npx -y @martinloop/mcp`

## Compatibility Aliases

- `martin-loop inspect --file <path>` remains supported
- `martin-loop resume <loopId>` remains supported

Prefer `martin-loop dossier` and `martin-loop runs get --loop-id` for richer evidence review.

Inside the `@martin/cli` workspace package you may also see the local development alias `martin`, but the published npm binary is `martin-loop`.

## Live Verification

Use the host matrix verifier when you want proof that generated config works with local host CLIs:

```sh
pnpm --filter @martin/cli verify:hosts:live
```
