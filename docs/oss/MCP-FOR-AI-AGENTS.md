# MCP For AI Agents

`@martinloop/mcp@0.2.5` is the integrated local governed execution cockpit tip for coding-agent hosts. It is built for agents that need one bounded execution tool, strong read-only inspection, run triage, and progressive discovery through MCP resources and prompts.

It is intentionally local-first and stdio-first in the OSS package.

## Public Release Train

- 0.1.4 operator foundation.
- 0.2.0 cockpit expansion. 0.2.0 adds resources, resource templates, prompts, and read-only cockpit inspection.
- 0.2.5 public MCP package line. 0.2.5 adds triage and degraded run-store hardening.

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
- `martin://runs/latest/summary`
- `martin://runs/latest/proof-card`
- `martin://runs/latest/budget-status`
- `martin://runs/latest/verifier-evidence`
- `martin://runs/latest/rollback-evidence`
- `martin://agent/next-step`
- `martin://guides/mcp-usage`
- `martin://guides/agent-start`
- `martin://guides/publish-readiness`

### Resource templates

- `martin://runs/{loopId}`
- `martin://runs/{loopId}/attempts/{attemptIndex}`
- `martin://runs/{loopId}/verification`

### Prompts

- `martin_start`
- `martin_preflight`
- `martin_triage`
- `martin_resume`
- `martin_prove`
- `martin_release_check`
- `martin_governed_coding_kickoff`
- `martin_debug_failed_run`
- `martin_publish_readiness_review`
- `martin_triage_run_store`

## Host Flow

1. Call `martin_doctor` first.
2. Call `martin_preflight` before non-trivial execution.
3. Use `martin_run` as the only execution entrypoint.
4. Use `martin_triage_runs` to rank which persisted run needs attention.
5. Read `martin://agent/next-step`, `martin://runs/latest/summary`, or `martin://runs/latest/proof-card` when context budget matters.
6. Use `martin_run_dossier` or the `martin_get_*` tools when compact evidence says deeper inspection is needed.
7. Use prompts when the host wants discovery-first workflows.

### Recommended minimal allow-list

If your host supports tool allow-lists, start here:

- `martin_doctor`
- `martin_preflight`
- `martin_list_runs`
- `martin_triage_runs`
- `martin_run_dossier`

Use `diagnostic` when the host needs deeper read-only run archaeology, and use `full-local` only when the host should execute `martin_run`. This keeps tool bloat down without reducing operator power.

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
  "martin_list_runs",
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
martin mcp print-config --host codex --transport stdio --profile minimal
martin mcp print-config --host claude --transport stdio --profile diagnostic
martin mcp print-config --host gemini --transport stdio --profile full-local
martin mcp print-config --host generic --transport remote --profile paid-remote
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
- Compact resources are cheap by default: latest summary, proof card, budget status, verifier evidence, rollback evidence, and one next-step recommendation.
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

> `@martinloop/mcp` is a stdio MCP server for governed AI coding work. It gives hosts a bounded execution entrypoint, compact proof receipts, rich read-only run inspection, MCP resources for discovery, and prompts for kickoff, triage, resume, proof, debugging, and release review.
