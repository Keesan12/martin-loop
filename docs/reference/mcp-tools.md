# MCP Tool Reference

The `@martinloop/mcp` package exposes one execution tool and read-only tools for inspection.

## Tools

| Tool | Purpose |
|---|---|
| `martin_doctor` | Check local MartinLoop and agent readiness. |
| `martin_preflight` | Validate a proposed run contract before execution. |
| `martin_run` | Execute a governed coding run. |
| `martin_inspect` | Inspect a persisted loop record. |
| `martin_status` | Summarize loop status. |
| `martin_list_runs` | List saved run records. |
| `martin_triage_runs` | Rank saved runs by urgency and missing evidence. |
| `martin_get_run` | Read one run by ID. |
| `martin_get_attempt` | Read one attempt from a run. |
| `martin_get_verification_results` | Read persisted verifier evidence. |
| `martin_run_dossier` | Produce a compact run dossier. |

## Resources

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
- `martin://guides/publish-readiness`

## Resource Templates

- `martin://runs/{loopId}`
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

## Safety Model

- `martin_run` is the only execution entrypoint.
- All other tools are read-only.
- `workingDirectory` stays bounded to the configured workspace root.
- `file` and `runsDir` stay bounded to the configured Martin runs root.
- Verification summaries come from persisted verifier evidence. Missing evidence is reported as unavailable instead of guessed.
