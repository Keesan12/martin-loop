# @martin/cli

Operator-first CLI for Martin Loop.

Examples below assume either the installed `martin` alias, `npx martin-loop`, or `pnpm exec martin-loop`.

The CLI now treats execution, diagnosis, persisted-run inspection, and MCP host setup as one product family:

- `martin doctor`
- `martin session-start`
- `martin phase status|contract|preflight|run`
- `martin preflight`
- `martin run`
- `martin bench`
- `martin triage`
- `martin dossier`
- `martin challenge`
- `martin share`
- `martin runs list|get|attempt|verify`
- `martin mcp print-config`
- `martin mcp install`
- `martin mcp verify-install`
- `martin mcp rollback`
- `martin mcp uninstall`

`martin mcp install` is intentionally conservative: it only writes a generated config when the target file is absent, or when it already detects a Martin Loop block and can stay idempotent. For mixed host configs, use `martin mcp print-config` and merge the Martin block yourself.

File-backed installs use atomic replacement, preserve the previous config in the local install-backup directory, and record a checksum for `verify-install`, `rollback`, and `uninstall`. Governance guidance is always printed; host governance files are written only with `--install-governance`.

## Install

Use the public root package when you want the CLI locally or in CI:

```sh
npm install martin-loop
npx martin-loop --version
npx martin-loop doctor
```

## Output modes

- default: human-readable summaries
- `--json`: stable machine-readable payloads
- `--quiet`: script-friendly primary identifier or path only

## MCP profiles

- local `stdio` is the default and best path for fast local iteration
- public OSS guidance covers:
  - `--host codex|claude|gemini|cursor|vscode|copilot|continue|generic`
  - `--scope user|project` for every host, plus Claude-only `local`
  - `--transport stdio`
  - `--profile minimal|diagnostic|github-review|full-local|paid-remote|starter|full`
  - `--platform windows|macos|linux`
  - `--dry-run` for a no-write install preview
  - `--install-governance` for explicit Claude governance-hook consent

The canonical host, scope, config-target, profile, and governance matrix is in the [MCP setup guide](../../docs/getting-started/mcp.md).

## Recommended flow

```sh
martin doctor
martin session-start
martin phase contract --json
martin phase preflight
martin preflight "repair the flaky MCP release lane" --verify "pnpm --filter @martinloop/mcp test"
martin run "repair the flaky MCP release lane" --verify "pnpm --filter @martinloop/mcp test"
martin triage
martin dossier --latest
martin share --latest
martin mcp print-config --host codex --profile minimal
```

`martin session-start` and `martin phase` are local-first command-center helpers. They read local phase state and local MartinLoop run receipts, then produce an explicit run contract before any work is executed. Existing `.gsd` workspaces are imported as a compatibility format when present. `martin phase preflight` and `martin phase run` are dry-run by default; add `--execute` only after the generated contract has the right verifier, budget, allowed paths, and blocked paths.

`martin share --latest` is the handoff step. It writes a redacted JSON receipt and a Markdown summary for the selected run. Proof-card images are opt-in with `--with-proof-card` or `--proof-card-format`.

## Benchmarks

Use the installed CLI for the shipped public summaries:

```sh
npx martin-loop bench --suite under-3-challenge
npx martin-loop bench --suite ralphy-engineering-50
```

Use the repo workspace when you want deterministic repro from source:

```sh
pnpm install --frozen-lockfile
pnpm --filter @martin/benchmarks build
pnpm --filter @martin/benchmarks test
pnpm --filter @martin/benchmarks eval
pnpm --filter @martin/benchmarks report:ralphy
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

The minimal allow-list stays aligned with the MCP discovery metadata: `martin_doctor`, `martin_preflight`, `martin_list_runs`, `martin_triage_runs`, and `martin_run_dossier`. Use `diagnostic` for deeper read-only archaeology and `full-local` when the host should execute `martin_run`.

## Host coverage

- `codex`, `claude`, `gemini`, `cursor`, `vscode`, `copilot`, `continue`, and `generic` are supported config targets. `copilot` remains a compatibility alias for VS Code.
- Every host supports user and project scope. Claude Code also supports its CLI-managed local scope.
- `print-config` and `install --dry-run` show the target, generated config, enabled tools, and governance guidance without changing host files.
- The installer refuses to replace an existing config unless it can safely update the MartinLoop entry.

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

Use the host matrix verifier when you want optional local proof that the generated config works with installed and authenticated host CLIs:

```sh
pnpm --filter @martin/cli verify:hosts:live
```

The current live matrix proves:

- generated cross-platform snippets
- Codex remote config load
- Claude project remote config load
- Claude local remote install
- Gemini remote config load
