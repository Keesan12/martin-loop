# @martinloop/mcp

Governed execution cockpit for AI coding agents over MCP stdio.

`@martinloop/mcp@0.2.5` is the integrated local governed execution cockpit tip aligned to the public MCP release train. It gives hosts one bounded execution entrypoint, a contract-first workflow, live run observability, evaluator-backed receipts, and discoverable resources on top of Martin Loop’s persisted run records.

This package stays local-first and stdio-first in public packaging today.

For host-facing guidance, see [MCP for AI Agents](https://github.com/Keesan12/martin-loop/blob/main/docs/oss/MCP-FOR-AI-AGENTS.md).

## Public Release Train

- 0.1.4 operator foundation.
- 0.2.0 cockpit expansion. 0.2.0 adds resources, resource templates, prompts, and read-only cockpit inspection.
- 0.2.5 public MCP package line. 0.2.5 adds triage and degraded run-store hardening, plus the command-center workflow surfaces.

## What Ships

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

## Recommended Flow

1. `martin_doctor`
2. `martin_plan`
3. `martin_preflight`
4. `martin_run`
5. `martin_status` or `martin_logs`
6. `martin_dossier` or `martin_get_*` when compact evidence says the full record is needed
7. `martin_eval` for mergeability scoring and reviewer posture
8. `martin_pr_summary` or `martin_review_pr` when the host is preparing GitHub review output

## Install

Run the packaged server directly:

```sh
npx -y @martinloop/mcp
```

Add it to Codex:

```sh
codex mcp add martin-loop -- npx -y @martinloop/mcp
```

Add it to Claude Code:

```sh
# macOS/Linux
claude mcp add --transport stdio --scope user martin-loop -- npx -y @martinloop/mcp

# Windows PowerShell or cmd.exe
claude mcp add --transport stdio --scope user martin-loop -- cmd /c npx -y @martinloop/mcp
```

Generate host config from the CLI when you want minimal, diagnostic, full-local, or GitHub-review profiles:

```sh
martin mcp print-config --host codex --transport stdio --profile minimal
martin mcp print-config --host claude --transport stdio --profile diagnostic
martin mcp print-config --host gemini --transport stdio --profile full-local
martin mcp print-config --host generic --transport stdio --profile github-review
```

`martin mcp install` supports the same local host set and only writes when the target file is absent or already contains a Martin Loop block.

Codex also supports `~/.codex/config.toml` and project-scoped `.codex/config.toml`:

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

If you use `martin mcp install`, it will only write a starter host config when the target file is absent, or when it detects an existing Martin Loop block and can remain idempotent. Otherwise it refuses to overwrite mixed host config so you can merge safely.

When `CODEX_HOME` is set, Codex user-scope installs target `CODEX_HOME\\config.toml` instead of the default user path.

Registry/server identifier: `io.github.Keesan12/martin-loop`

## Host coverage

- `codex`: local stdio profiles
- `claude`: local, user, and project scopes
- `gemini`: local `settings.json` snippets with `includeTools`
- `generic`: JSON config for MCP-aware wrappers

Operating-system launcher behavior is explicit:

- Windows: `cmd /c npx -y @martinloop/mcp`
- macOS/Linux: `npx -y @martinloop/mcp`

Claude `--scope local` remains CLI-managed. `martin mcp install --host claude --scope local` shells out to Claude Code directly instead of fabricating a repo config file for that scope.

## Discovery metadata

- JSON resources now carry `metadata.serverVersion`, `metadata.discoveryRevision`, and freshness context such as the resolved `runsRoot`.
- Compact resources expose low-token latest-run summaries, proof cards, budget status, verifier evidence, rollback evidence, and a single recommended next step.
- Prompts stamp the current server version and discovery revision into their descriptions so hosts can confirm which surface they discovered.
- The server does **not** advertise `listChanged` yet. That is deliberate: the current discovery surface is stable and versioned, but it does not yet emit authoritative change notifications.

## Runtime Model

- `martin_run` is the only execution entrypoint.
- `martin_plan`, `martin_doctor`, `martin_preflight`, `martin_status`, `martin_logs`, `martin_dossier`, `martin_eval`, and the `martin_get_*` family are read-only workflow surfaces.
- `martin_create_pr` is opt-in and intended for GitHub-enabled profiles, not the minimal default profile.
- Live runs require `claude` or `codex` on `PATH`.
- Stub or smoke flows use `MARTIN_LIVE=false`.
- Paths stay bounded to the configured workspace root and runs root.
- Direct raw-model compatibility is not the target. Martin Loop supports hosts and wrappers that speak MCP; open-source model families such as Gemma or Nemotron should use the `generic` host path through an MCP-capable shell or runtime.

## Operator Notes

- `martin_doctor` now reports repo hygiene, verifier readiness, safeguard posture, and a readiness score instead of only install health.
- `martin_plan` is the default read-only planning step before preflight. It proposes scope, verifiers, budget, and approval posture without spending a run.
- `martin_preflight` now emits a structured run contract with policy-pack, allowed paths, blocked paths, budgets, and risk scoring.
- `martin_status`, `martin_logs`, `martin_pause`, `martin_cancel`, and `martin_continue` give hosts a safer live-control layer without inventing extra execution tools.
- `martin_dossier` is the alias-first evidence surface; `martin_run_dossier` remains supported for compatibility.
- `martin_eval` grades task completion, verifier posture, regression risk, security risk, and reviewability for the completed run.
- Resources and prompts reuse the same run-store selectors as the tools; they are discovery surfaces, not a second data model.
- The recommended host default is the `minimal` profile: `martin_doctor`, `martin_plan`, `martin_preflight`, `martin_list_runs`, `martin_triage_runs`, and `martin_dossier`. Use `diagnostic` for read-only archaeology, `full-local` when the host should execute runs, and `github-review` only when PR mutation is explicitly desired.

## Debugging

Use the live handshake inspector before you blame the host:

```sh
pnpm --filter @martinloop/mcp inspect:live
```

If you want the official MCP Inspector UI, point it at the same stdio launch command:

```sh
npx @modelcontextprotocol/inspector --command npx --args "-y,@martinloop/mcp"
```

The stdio server keeps protocol output on stdout and diagnostic logging on stderr. When a host integration goes sideways, confirm the live discovery surface first, then move on to the host config.

For WSL or Linux validation, do a native install on that platform before you smoke the package. Reusing Windows-installed `node_modules` across WSL will fail on native dependencies such as `esbuild`, which looks like a transport failure but is really a cross-platform install mismatch.

## Verification

From the repository root:

```sh
pnpm --filter @martinloop/mcp lint
pnpm --filter @martinloop/mcp test
pnpm --filter @martinloop/mcp build
pnpm --filter @martinloop/mcp smoke:pack
pnpm --filter @martinloop/mcp smoke:published:pack
pnpm --filter @martinloop/mcp verify:release
pnpm --filter @martin/cli verify:hosts:live
pnpm --filter @martinloop/mcp smoke:published
pnpm --filter @martinloop/mcp inspect:live
```

- `smoke:pack` verifies the packed tarball and stdio launch path.
- `smoke:published:pack` verifies install-and-run behavior from a freshly packed local tarball through the installed `mcp` bin before npm publish.
- `verify:release` checks metadata parity, release-note presence, install docs, and discovery-surface claims.
- `@martin/cli verify:hosts:live` proves the generated host config against the real Codex, Claude, and Gemini CLIs on this machine.
- `smoke:published` remains a post-publish npm gate.

## Compatibility

`0.2.5` is the current integrated governed execution cockpit line:

- `martin_run`, `martin_inspect`, `martin_status`, `martin_doctor`, and `martin_preflight` remain backward-compatible.
- The command-center additions are additive: planning, logs, live controls, evaluation, dossier aliasing, GitHub review helpers, more resources, and prompt packs.
- `martin_create_pr` is the only new outward-mutating helper and stays out of the default minimal profile.

See `docs/release/MCP-COMPATIBILITY.md`, `docs/release/MCP-0.2.0-RELEASE-NOTES.md`, and `docs/release/MCP-0.2.5-RELEASE-NOTES.md` for the public release contract and delivery sequence.
