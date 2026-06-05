# MCP Tool Reference

The `@martinloop/mcp` package exposes one primary coding execution entrypoint plus planning, inspection, run-control, and review helpers.

## Planning and Execution

| Tool | Purpose |
| --- | --- |
| `martin_doctor` | Check local MartinLoop and agent readiness. |
| `martin_plan` | Outline scope, verification, and budget posture before spending a run. |
| `martin_preflight` | Validate a proposed run contract before execution. |
| `martin_run` | Execute a governed coding run. |

## Status and Run Control

| Tool | Purpose |
| --- | --- |
| `martin_status` | Summarize live or recent run status. |
| `martin_logs` | Read recent run-control receipts and workflow events. |
| `martin_pause` | Request that a running loop pause at a safe boundary. |
| `martin_cancel` | Cancel a running loop and capture the control receipt. |
| `martin_continue` | Continue a paused loop with the recorded run context. |

## Inspection and Evidence

| Tool | Purpose |
| --- | --- |
| `martin_inspect` | Inspect a persisted loop record. |
| `martin_list_runs` | List saved run records. |
| `martin_triage_runs` | Rank saved runs by urgency and missing evidence. |
| `martin_get_run` | Read one run by ID. |
| `martin_get_attempt` | Read one attempt from a run. |
| `martin_get_verification_results` | Read persisted verifier evidence. |
| `martin_run_dossier` | Produce a compact run dossier. |
| `martin_dossier` | Alias-first dossier surface for host-friendly receipts. |
| `martin_eval` | Grade the run for verifier posture, regression risk, and reviewability. |

## Review Helpers

| Tool | Purpose |
| --- | --- |
| `martin_pr_summary` | Produce a review-ready summary from the run receipts. |
| `martin_create_pr` | Create a PR when the host explicitly wants GitHub mutation. |
| `martin_review_pr` | Review an existing PR with MartinLoop evidence context. |

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

## Profile Notes

- `minimal` is the safest default profile.
- `diagnostic` adds deeper run-store and evaluation helpers.
- `full-local` adds `martin_run` plus run-control helpers for local operators.
- `github-review` adds PR-oriented helpers when the host explicitly needs them.

For installation and host setup, see [MCP setup](../getting-started/mcp.md). For platform commitments, see [MCP compatibility](./mcp-compatibility.md).
