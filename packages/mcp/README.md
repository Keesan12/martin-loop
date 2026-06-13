# @martinloop/mcp

Governed MCP server for AI coding agents over local stdio.

`@martinloop/mcp@0.3.2` is the live public baseline today. `0.3.3` is the next planned public cut.

This package stays local-first and stdio-first in the public OSS lane.

## Public release train

- `0.2.7` made the guided MCP workflow easier to adopt and harder to misuse.
- `0.3.0` is the live adoption baseline that made host setup and onboarding clearer.
- `0.3.1` is the live review and handoff release.
- `0.3.2` is the live engine-validation hotfix that fixes spend-limit requests for Gemini-backed runs.
- `0.3.3` is the planned follow-on for opt-in execution controls.

## What ships today

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

## Recommended flow

1. `martin_doctor`
2. `martin_plan`
3. `martin_preflight`
4. `martin_run`
5. `martin_status` or `martin_logs`
6. `martin_dossier`
7. `martin_eval`

## Install

```sh
npx -y @martinloop/mcp
```

Codex:

```sh
codex mcp add martin-loop -- npx -y @martinloop/mcp
```

Claude Code:

```sh
# macOS/Linux
claude mcp add --transport stdio --scope user martin-loop -- npx -y @martinloop/mcp

# Windows PowerShell or cmd.exe
claude mcp add --transport stdio --scope user martin-loop -- cmd /c npx -y @martinloop/mcp
```

If you want generated host config, use the MartinLoop CLI:

```sh
martin mcp print-config --host codex --transport stdio --profile minimal
martin mcp print-config --host claude --transport stdio --profile diagnostic
martin mcp print-config --host gemini --transport stdio --profile full-local
martin mcp print-config --host generic --transport stdio --profile github-review
```

## Compatibility posture

- `martin_run` remains the single execution entrypoint.
- Read-only inspection stays available without execution-capable profiles.
- The OSS package stays focused on local stdio workflows. Hosted and team features live on a separate product track.
- Later `0.3.x` releases should widen adoption and guidance without blurring those boundaries.

## Verification

```sh
pnpm --filter @martinloop/mcp lint
pnpm --filter @martinloop/mcp test
pnpm --filter @martinloop/mcp build
pnpm --filter @martinloop/mcp smoke:pack
pnpm --filter @martinloop/mcp smoke:published:pack
pnpm --filter @martinloop/mcp verify:release
```
