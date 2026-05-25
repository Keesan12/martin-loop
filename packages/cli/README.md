# @martin/cli

Operator-first CLI for Martin Loop.

The CLI now treats execution, diagnosis, persisted-run inspection, and MCP host setup as one product family:

- `martin doctor`
- `martin preflight`
- `martin run`
- `martin triage`
- `martin dossier`
- `martin runs list|get|attempt|verify`
- `martin mcp print-config`
- `martin mcp install`

`martin mcp install` is intentionally conservative: it only writes a generated config when the target file is absent, or when it already detects a Martin Loop block and can stay idempotent. For mixed host configs, use `martin mcp print-config` and merge the Martin block yourself.

## Output modes

- default: human-readable summaries
- `--json`: stable machine-readable payloads
- `--quiet`: script-friendly primary identifier or path only

## Local vs remote MCP

- local `stdio` is the default and best path for fast local iteration
- remote config output is for environments that expose a compatible remote MCP endpoint
- both `martin mcp print-config` and `martin mcp install` support:
  - `--host codex|claude|gemini|generic`
  - `--transport stdio|remote`
  - `--profile minimal|diagnostic|full-local|starter|full`
  - `--platform windows|macos|linux`

## Recommended flow

```sh
martin doctor
martin preflight "repair the flaky MCP release lane" --verify "pnpm --filter @martinloop/mcp test"
martin run "repair the flaky MCP release lane" --verify "pnpm --filter @martinloop/mcp test"
martin triage
martin dossier --latest
martin mcp print-config --host codex --profile minimal
```

## Compatibility aliases

- `martin inspect --file <path>` remains supported
- `martin resume <loopId>` remains supported

Prefer `martin dossier` and `martin runs get --loop-id` for the richer operator surface.

## MCP minimal profile

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
  "martin_list_runs",
  "martin_triage_runs",
  "martin_run_dossier",
]
env = { MARTIN_RUNS_DIR = "C:\\path\\to\\runs" }
```

The minimal allow-list stays aligned with the MCP discovery metadata: `martin_doctor`, `martin_preflight`, `martin_list_runs`, `martin_triage_runs`, and `martin_run_dossier`. Use `diagnostic` for deeper read-only archaeology and `full-local` when the host should expose `martin_run`.

## Host coverage

- `codex`: local stdio and remote URL profiles
- `claude`: local, user, and project scopes plus remote HTTP profiles
- `gemini`: local and remote `settings.json` snippets plus `includeTools`
- `generic`: JSON config for wrapper hosts and MCP-aware agent shells

Generated stdio launchers are platform-aware:

- Windows uses `cmd /c npx -y @martinloop/mcp`
- macOS and Linux use `npx -y @martinloop/mcp`

### Host-specific notes

- Codex user-scope installs respect `CODEX_HOME` when it is set. Otherwise they target the default `~/.codex/config.toml`.
- Claude `--scope local` is CLI-managed. Martin Loop shells out to `claude mcp add ... --scope local ...` instead of writing a repo file for that scope.
- Claude `user` and `project` scopes remain file-backed so `martin mcp print-config` can show you the exact block before you install it.
- Gemini config uses `includeTools` and `trust` in `settings.json`, not the older `enabledTools` field.
- Cross-platform proof should install dependencies on the native platform before you validate there. Reusing Windows `node_modules` from WSL or Linux will break native packages such as `esbuild`.

## Live verification

Use the host matrix verifier when you want proof that the generated config works with the real host CLIs on this machine:

```sh
pnpm --filter @martin/cli verify:hosts:live
```

The current live matrix proves:

- generated cross-platform snippets
- Codex remote config load
- Claude project remote config load
- Claude local remote install
- Gemini remote config load
