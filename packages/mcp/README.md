# @martinloop/mcp

Governed MCP server for AI coding agents with budgets, receipts, and review-ready evidence.

`@martinloop/mcp` is the standalone MartinLoop server for MCP hosts. It stays local-first and stdio-first, and it gives hosts one clear execution path: check readiness, plan the work, preflight the contract, run it, and inspect the result with enough evidence to decide what happens next.

The root `martin-loop` package and the standalone `@martinloop/mcp` package move on separate version lines. For the current root release, see [MartinLoop 0.2.10 release notes](../../docs/release/OSS-0.2.10-RELEASE-NOTES.md).

## What is new in 0.2.7

- better onboarding inside MCP, including guide resources for command mapping, IDE setup, and operating rules
- a stricter governed run sequence, so `martin_run` refuses to start until matching `martin_doctor`, `martin_plan`, and `martin_preflight` receipts exist for the same task
- cleaner review and handoff surfaces, especially around dossier, eval, and publish-readiness guidance

If you are installing MartinLoop for the first time, start with the root CLI first:

```sh
npx martin-loop start
npx martin-loop tour
npx martin-loop doctor
```

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
claude mcp add --transport stdio --scope user martin-loop -- npx -y @martinloop/mcp
claude mcp add --transport stdio --scope user martin-loop -- cmd /c npx -y @martinloop/mcp
```

Generate host config from the root CLI:

```sh
npx martin-loop mcp print-config --host codex --transport stdio --profile minimal
npx martin-loop mcp print-config --host claude --transport stdio --profile diagnostic
npx martin-loop mcp print-config --host gemini --transport stdio --profile full-local
npx martin-loop mcp print-config --host generic --transport stdio --profile github-review
```

Registry/server identifier: `io.github.Keesan12/martin-loop`

## Recommended Flow

1. `martin_doctor`
2. `martin_plan`
3. `martin_preflight`
4. `martin_run`
5. `martin_status` or `martin_logs`
6. `martin_dossier` or the `martin_get_*` tools
7. `martin_eval`
8. `martin_pr_summary` or `martin_review_pr` when a host is preparing GitHub review output

`martin_run` is the primary coding execution entrypoint. In `0.2.7`, it hard-blocks until the matching readiness, planning, and preflight receipts exist for the same task. That keeps the default flow honest for both humans and agents.

## Profiles

- `minimal`: read-heavy default for safe host setup
- `diagnostic`: deeper inspection and evaluator support
- `full-local`: includes execution and run-control helpers for local workflows
- `github-review`: adds PR review helpers for GitHub-oriented hosts
- `starter` and `full`: compatibility aliases that map onto the same discovery surface

## Tools

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

## Resources

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
- `martin://guides/command-map`
- `martin://guides/ide-onboarding`
- `martin://guides/operating-rules`
- `martin://guides/publish-readiness`

## Resource Templates

- `martin://runs/{loopId}`
- `martin://runs/{loopId}/dossier`
- `martin://runs/{loopId}/attempts/{attemptIndex}`
- `martin://runs/{loopId}/verification`

## Prompts

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

## Runtime Model

- `martin_run` is the primary coding execution entrypoint.
- `martin_run` now blocks until the same task has matching `martin_doctor`, `martin_plan`, and `martin_preflight` receipts.
- `martin_plan`, `martin_doctor`, `martin_preflight`, `martin_status`, `martin_logs`, `martin_dossier`, `martin_eval`, and the `martin_get_*` family are planning or inspection surfaces.
- `martin_pause`, `martin_cancel`, `martin_continue`, and `martin_create_pr` are explicit follow-on control helpers and stay out of the default `minimal` profile.
- Live runs require `claude` or `codex` on `PATH`.
- CLI proof flows use `martin-loop run ... --proof`.
- Host-managed smoke flows can still set `MARTIN_LIVE=false`.
- Paths stay bounded to the configured workspace root and runs root.

## Debugging

Use the live handshake inspector before you blame a host config:

```sh
pnpm --filter @martinloop/mcp inspect:live
```

If you want the official MCP Inspector UI, point it at the same stdio launch command:

```sh
npx @modelcontextprotocol/inspector --command npx --args "-y,@martinloop/mcp"
```

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
```

See [MCP setup](../../docs/getting-started/mcp.md), [MCP tool reference](../../docs/reference/mcp-tools.md), and [MCP compatibility](../../docs/reference/mcp-compatibility.md).
