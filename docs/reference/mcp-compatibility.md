# MCP Compatibility

`@martinloop/mcp` is a local-first stdio MCP server for governed AI coding work.

## Package and Version Lines

- The root `martin-loop` package provides the public CLI, SDK, demo workspace, and top-level release notes.
- The standalone `@martinloop/mcp` package stays on its own version line.
- The server identifier remains `io.github.Keesan12/martin-loop`.
- The current public standalone MCP package line is `0.2.7`.

## Stability Commitments

- `npx -y @martinloop/mcp` remains the package launch command.
- `martin_run` remains the primary coding execution entrypoint.
- `minimal` remains the safest default host profile.
- Richer profiles add planning, run-control, and review helpers without changing the stdio transport model.
- Resources, resource templates, and prompts remain versioned discovery surfaces so hosts can see what they loaded.

## Host Coverage

- Codex: local stdio profiles
- Claude Code: local, user, and project scopes
- Gemini: local `settings.json` snippets with `includeTools`
- Generic: JSON config for MCP-aware wrappers

## Launcher Behavior

- Windows: `cmd /c npx -y @martinloop/mcp`
- macOS/Linux: `npx -y @martinloop/mcp`

## Profile Model

- `minimal`: read-heavy starter profile
- `diagnostic`: adds deeper inspection and evaluation helpers
- `full-local`: includes governed execution and run-control helpers
- `github-review`: adds PR summary and review helpers
- `starter` and `full`: compatibility aliases for hosts that still use those profile names

## Discovery Metadata

Resources and prompts include version metadata so hosts can confirm which discovery surface they loaded. The server does not advertise authoritative change notifications yet.

## Safety Model

- `martin_plan`, `martin_doctor`, `martin_preflight`, `martin_status`, `martin_logs`, `martin_dossier`, `martin_eval`, and the `martin_get_*` family are intended for planning and inspection.
- `martin_run` now expects matching `martin_doctor`, `martin_plan`, and `martin_preflight` receipts for the same task before it will execute.
- `martin_pause`, `martin_cancel`, `martin_continue`, and `martin_create_pr` are explicit follow-on helpers and stay out of the default `minimal` profile.
- Live governed runs require a supported local agent CLI on `PATH`.
- CLI proof flows use `martin-loop run ... --proof`.
- Host-managed smoke flows can still set `MARTIN_LIVE=false` when the launcher owns the environment.
