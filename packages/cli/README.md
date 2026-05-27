# @martin/cli

CLI implementation for MartinLoop.

The CLI groups execution, readiness checks, persisted-run inspection, and MCP host setup into one product surface:

- `martin doctor`
- `martin demo`
- `martin preflight`
- `martin run`
- `martin triage`
- `martin dossier`
- `martin runs list|get|attempt|verify`
- `martin mcp print-config`
- `martin mcp install`

## Output Modes

- default: human-readable summaries
- `--json`: machine-readable payloads
- `--quiet`: script-friendly primary identifier or path only

## Recommended Flow

```sh
martin doctor
martin preflight "repair the flaky MCP release lane" --verify "pnpm --filter @martinloop/mcp test"
martin run "repair the flaky MCP release lane" --verify "pnpm --filter @martinloop/mcp test"
martin triage
martin dossier --latest
```

## MCP Config

`martin mcp print-config --host codex` emits a quoted TOML server key:

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

`martin mcp install` is conservative: it writes only when the target file is absent or when it detects an existing MartinLoop block it can update safely. For mixed host configs, use `martin mcp print-config` and merge the MartinLoop block yourself.

## Host Coverage

- `codex`: local stdio profiles
- `claude`: local, user, and project scopes
- `gemini`: local `settings.json` snippets with `includeTools`
- `generic`: JSON config for wrapper hosts and MCP-aware agent shells

Generated stdio launchers are platform-aware:

- Windows uses `cmd /c npx -y @martinloop/mcp`
- macOS and Linux use `npx -y @martinloop/mcp`

## Compatibility Aliases

- `martin inspect --file <path>` remains supported
- `martin resume <loopId>` remains supported

Prefer `martin dossier` and `martin runs get --loop-id` for richer evidence review.

## Live Verification

Use the host matrix verifier when you want proof that generated config works with local host CLIs:

```sh
pnpm --filter @martin/cli verify:hosts:live
```
