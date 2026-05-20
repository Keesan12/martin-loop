# MCP For AI Agents

`@martinloop/mcp@0.2.5` is the integrated local governed execution cockpit tip for coding-agent hosts. It is built for agents that need one bounded execution tool, strong read-only inspection, run triage, and progressive discovery through MCP resources and prompts.

It is intentionally local-first and stdio-first in the OSS package.

## Public Release Train

- 0.1.4 operator foundation.
- 0.2.0 cockpit expansion. 0.2.0 adds resources, resource templates, prompts, and read-only cockpit inspection.
- 0.2.5 stable cockpit line. 0.2.5 adds triage and degraded run-store hardening.

## What This MCP Is Good At

- governing code-change runs with budgets, retries, and verification gates
- making persisted Martin run records inspectable after execution
- giving hosts a small front door for execution and a rich read-only back door for analysis
- helping both humans and agents debug failed runs without inventing new state

It is not meant to be a generic browser, search engine, or shell replacement.

## Public Surface

### Tools

- `martin_doctor`
- `martin_preflight`
- `martin_run`
- `martin_inspect`
- `martin_status`
- `martin_list_runs`
- `martin_triage_runs`
- `martin_get_run`
- `martin_get_attempt`
- `martin_get_verification_results`
- `martin_run_dossier`

### Resources

- `martin://server/health`
- `martin://runs/recent`
- `martin://runs/triage`
- `martin://guides/mcp-usage`
- `martin://guides/publish-readiness`

### Resource templates

- `martin://runs/{loopId}`
- `martin://runs/{loopId}/attempts/{attemptIndex}`
- `martin://runs/{loopId}/verification`

### Prompts

- `martin_governed_coding_kickoff`
- `martin_debug_failed_run`
- `martin_publish_readiness_review`
- `martin_triage_run_store`

## Host Flow

1. Call `martin_doctor` first.
2. Call `martin_preflight` before non-trivial execution.
3. Use `martin_run` as the only execution entrypoint.
4. Use `martin_triage_runs` to rank which persisted run needs attention.
5. Use `martin_run_dossier` or the `martin_get_*` tools to inspect outcomes.
6. Use resources/prompts when the host wants discovery-first workflows.

### Recommended starter allow-list

If your host supports tool allow-lists, start here:

- `martin_doctor`
- `martin_preflight`
- `martin_run`
- `martin_triage_runs`
- `martin_run_dossier`

Keep the broader `martin_get_*` tools enabled when the host actually needs deeper run archaeology. This keeps context bloat down without reducing operator power.

## Install

### Codex

```sh
codex mcp add martin-loop -- npx -y @martinloop/mcp
```

### Claude Code

```sh
# macOS/Linux
claude mcp add --transport stdio --scope user martin-loop -- npx -y @martinloop/mcp

# Windows PowerShell or cmd.exe
claude mcp add --transport stdio --scope user martin-loop -- cmd /c npx -y @martinloop/mcp
```

### Generic stdio config

```json
{
  "type": "stdio",
  "command": "npx",
  "args": ["-y", "@martinloop/mcp"]
}
```

Codex-oriented hosts can also use `~/.codex/config.toml` or project-scoped `.codex/config.toml`:

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

If you generate config from the CLI, `martin mcp install` stays conservative: it only writes when the target file is absent or when it already detects a Martin Loop block. For broader hand-maintained host configs, use `martin mcp print-config` and merge the Martin section intentionally.

If `CODEX_HOME` is set, Codex user-scope installs target `CODEX_HOME\\config.toml` instead of the default user path.

### Gemini and generated profiles

Martin Loop’s CLI can emit host-ready stdio config for:

- `codex`
- `claude`
- `gemini`
- `generic`

Examples:

```sh
martin mcp print-config --host codex --transport stdio --profile starter
martin mcp print-config --host claude --transport stdio --profile starter
martin mcp print-config --host gemini --transport stdio --profile full
martin mcp print-config --host generic --transport stdio --profile starter
```

`martin mcp install` accepts the same host, transport, profile, scope, and platform options.

Host notes:

- Claude `local` scope is CLI-managed, not a repo file. Martin Loop calls Claude Code directly for that scope.
- Gemini config uses `includeTools` and `trust` in `settings.json`.
- The current live host matrix is proven with `pnpm --filter @martin/cli verify:hosts:live`.

## Local Package Mode

Use local `stdio` when you want the fastest local iteration loop and fully local execution. The OSS package docs describe the package-first MCP surface and do not claim hosted transport availability.

## Safety and Data Model

- `workingDirectory` remains bounded to the configured workspace root.
- `file` and `runsDir` remain bounded to the configured Martin runs root.
- `allowedPaths` and `deniedPaths` must stay repo-relative.
- Verification summaries come only from persisted `verification.completed` evidence. Missing evidence is reported as `unavailable`, not guessed.
- Resources and prompts reuse the same persisted run data as the tools.
- Resource JSON includes `metadata.serverVersion` and `metadata.discoveryRevision` so hosts can confirm which discovery surface they actually loaded.
- Prompt descriptions include the same version/revision stamp for the same reason.
- `listChanged` is not advertised yet. Martin Loop prefers an honest, versioned discovery surface over fake change notifications.
- Martin Loop targets MCP-capable hosts and wrappers, not raw model weights directly. Open-source model families such as Gemma and Nemotron should use the `generic` host path through an MCP-aware shell or runtime.

## Debugging

Use the packaged live-inspection path before debugging a host config:

```sh
pnpm --filter @martinloop/mcp inspect:live
```

For UI-driven investigation with the official MCP Inspector:

```sh
npx @modelcontextprotocol/inspector --command npx --args "-y,@martinloop/mcp"
```

If those two paths look sane, move on to the host-specific config and timeout settings.

## Recommendation Blurb

> `@martinloop/mcp` is a stdio MCP server for governed AI coding work. It gives hosts a bounded execution entrypoint, rich read-only run inspection, MCP resources for discovery, and prompts for kickoff, debugging, and release review.
