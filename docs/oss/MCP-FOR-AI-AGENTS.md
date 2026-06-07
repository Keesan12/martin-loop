# MCP For AI Agents

`@martinloop/mcp@0.2.7` is the current public governed execution cockpit package for coding-agent hosts. It is built for agents that need one bounded execution tool, a contract-first workflow, strong read-only inspection, and progressive discovery through MCP resources and prompts.

It is intentionally local-first and stdio-first in the OSS package.

## Public Release Train

- 0.1.4 operator foundation.
- 0.2.0 cockpit expansion. 0.2.0 adds resources, resource templates, prompts, and read-only cockpit inspection.
- 0.2.5 public MCP package line. 0.2.5 adds triage and degraded run-store hardening, plus the command-center workflow surfaces.
- 0.2.7 usability and review release. 0.2.7 clarifies the guided path and tightens public package presentation.

## What This MCP Is Good At

- governing code-change runs with budgets, retries, and verification gates
- making persisted Martin run records inspectable after execution
- giving hosts a small front door for execution and a rich read-only back door for analysis
- helping both humans and agents debug failed runs without inventing new state

It is not meant to be a generic browser, search engine, or shell replacement.

## Published Interface

### Tools

- `martin_doctor`
- `martin_plan`
- `martin_preflight`
- `martin_run`
- `martin_inspect`
- `martin_status`
- `martin_logs`
- `martin_pause`
- `martin_cancel`
- `martin_continue`
- `martin_list_runs`
- `martin_triage_runs`
- `martin_get_run`
- `martin_get_attempt`
- `martin_get_verification_results`
- `martin_run_dossier`
- `martin_dossier`
- `martin_eval`
- `martin_pr_summary`
- `martin_create_pr`
- `martin_review_pr`

### Resources

- `martin://server/health`
- `martin://runs/recent`
- `martin://runs/triage`
- `martin://runs/latest`
- `martin://runs/latest/summary`
- `martin://runs/latest/proof-card`
- `martin://runs/latest/budget-status`
- `martin://runs/latest/verifier-evidence`
- `martin://runs/latest/rollback-evidence`
- `martin://policies/current`
- `martin://repo/risk-map`
- `martin://verifiers/results`
- `martin://agent/next-step`
- `martin://guides/mcp-usage`
- `martin://guides/agent-start`
- `martin://guides/publish-readiness`

### Resource templates

- `martin://runs/{loopId}`
- `martin://runs/{loopId}/dossier`
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
- `safe_bug_fix`
- `write_tests_first`
- `small_refactor`
- `security_review`
- `pr_review`
- `release_check`

## Host Flow

1. Call `martin_doctor` first.
2. Call `martin_plan` to propose scope, verifiers, budget, and risk without spending a run.
3. Call `martin_preflight` to lock the run contract before non-trivial execution.
4. Use `martin_run` as the only execution entrypoint.
5. Use `martin_status` or `martin_logs` while the run is live.
6. Use `martin_dossier` or the `martin_get_*` tools when compact evidence says deeper inspection is needed.
7. Use `martin_eval` and PR helpers when the host needs review posture, not just raw receipts.

### Recommended minimal allow-list

If your host supports tool allow-lists, start here:

- `martin_doctor`
- `martin_plan`
- `martin_preflight`
- `martin_list_runs`
- `martin_triage_runs`
- `martin_dossier`

Use `diagnostic` when the host needs deeper read-only run archaeology, `full-local` only when the host should execute `martin_run`, and `github-review` only when PR mutation is explicitly desired. This keeps tool bloat down without reducing operator power.

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

If you generate config from the CLI, `npx martin-loop mcp install` stays conservative: it only writes when the target file is absent or when it already detects a Martin Loop block. For broader hand-maintained host configs, use `npx martin-loop mcp print-config` and merge the Martin section intentionally.

If `CODEX_HOME` is set, Codex user-scope installs target `CODEX_HOME\\config.toml` instead of the default user path.

### Gemini and generated profiles

Martin Loop’s CLI can emit host-ready stdio config for:

- `codex`
- `claude`
- `gemini`
- `generic`

Examples:

```sh
npx martin-loop mcp print-config --host codex --transport stdio --profile minimal
npx martin-loop mcp print-config --host claude --transport stdio --profile diagnostic
npx martin-loop mcp print-config --host gemini --transport stdio --profile full-local
npx martin-loop mcp print-config --host generic --transport stdio --profile github-review
```

`npx martin-loop mcp install` accepts the same public local host, profile, scope, and platform options.

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
- `martin_doctor` now scores repo hygiene, verifier readiness, safeguard posture, and recommended policy strength for the current workspace.
- `martin_plan` is read-only and proposes file scope, verifier coverage, risk factors, and approval posture before preflight.
- `martin_preflight` now emits a structured run contract with policy-pack, blocked paths, budgets, and risk scoring.
- `martin_status`, `martin_logs`, `martin_pause`, `martin_cancel`, and `martin_continue` are the live control layer around `martin_run`.
- `martin_dossier` is the preferred evidence entrypoint; `martin_run_dossier` remains for compatibility.
- `martin_eval` converts raw receipts into mergeability and reviewability guidance.
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

> `@martinloop/mcp` is a stdio MCP server for governed AI coding work. It gives hosts a bounded execution entrypoint, contract-first planning and preflight, compact proof receipts, live run observability, rich read-only run inspection, MCP resources for discovery, and prompts for kickoff, debugging, review, and release checks.
