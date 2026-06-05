# @martin/cli

CLI implementation for MartinLoop.

The published binary is `martin-loop`. Inside this workspace package you may also see the local development alias `martin`, but the public install target remains `martin-loop`.

## Product Flow

The CLI groups onboarding, readiness checks, governed execution, evidence review, and MCP host setup into one command family:

- `martin-loop start`
- `martin-loop tour`
- `martin-loop guide`
- `martin-loop doctor`
- `martin-loop demo`
- `martin-loop session-start`
- `martin-loop phase status|contract|preflight|run`
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

## Install

```sh
npm install -g martin-loop
# or run commands with npx martin-loop <command>
```

## Recommended Flow

```sh
npx martin-loop start
npx martin-loop tour
npx martin-loop doctor
npx martin-loop session-start
npx martin-loop preflight "repair the flaky MCP release lane" --verify "pnpm --filter @martinloop/mcp test"
npx martin-loop run "repair the flaky MCP release lane" --verify "pnpm --filter @martinloop/mcp test"
npx martin-loop triage
npx martin-loop dossier --latest
npx martin-loop mcp print-config --host codex --profile minimal
```

Built-in onboarding:

- `start` tells the operator or host the safest next MartinLoop command.
- `tour` walks through the product flow with exact commands and expected output.
- `guide` explains what each command does and when to use it.

Governed runs are hard-blocked by default until `doctor`, a local session step, and `preflight` receipts exist for the same repo and task. Use `--unsafe-allow-unguarded-run` only when you intentionally need to bypass that local gate.

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
  "martin_plan",
  "martin_preflight",
  "martin_list_runs",
  "martin_triage_runs",
  "martin_dossier",
]
env = { MARTIN_RUNS_DIR = "C:\\path\\to\\runs" }
```

The default `minimal` profile is read-heavy. Use `diagnostic` for deeper inspection, `full-local` when the host should run tasks, and `github-review` only when review helpers are needed.

## Host Coverage

- `codex`: local stdio profiles
- `claude`: local, user, and project scopes
- `gemini`: local `settings.json` snippets with `includeTools`
- `generic`: JSON config for wrapper hosts and MCP-aware agent shells

Generated stdio launchers are platform-aware:

- Windows uses `cmd /c npx -y @martinloop/mcp`
- macOS and Linux use `npx -y @martinloop/mcp`

## Docs

- [Quickstart](../../docs/getting-started/quickstart.md)
- [CLI reference](../../docs/reference/cli.md)
- [Config reference](../../docs/reference/config.md)
- [MCP setup](../../docs/getting-started/mcp.md)
