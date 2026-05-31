# Quickstart

This quickstart covers the public OSS runtime and the standalone `@martinloop/mcp@0.2.5` cockpit line.

## Public Release Train

- 0.1.4 operator foundation.
- 0.2.0 cockpit expansion. 0.2.0 adds resources, resource templates, prompts, and read-only cockpit inspection.
- 0.2.5 public MCP package line. 0.2.5 adds triage and degraded run-store hardening, plus the command-center workflow surfaces.

## Prerequisites

- Node.js 20+
- `pnpm` 10.x for repo-local work
- optional for live runs: `claude` or `codex` on `PATH`

## Install and Build

From the repo root:

```bash
pnpm install --frozen-lockfile
pnpm build
```

## Launch the MCP Package

```bash
npx -y @martinloop/mcp
```

Codex:

```bash
codex mcp add martin-loop -- npx -y @martinloop/mcp
```

Claude Code:

```bash
# macOS/Linux
claude mcp add --transport stdio --scope user martin-loop -- npx -y @martinloop/mcp

# Windows PowerShell or cmd.exe
claude mcp add --transport stdio --scope user martin-loop -- cmd /c npx -y @martinloop/mcp
```

## First Session

### Local CLI command center

Before an agent spends work, you can ask the CLI for local readiness and phase state:

```bash
martin doctor
martin session-start
martin phase contract --json
martin phase preflight
```

`martin session-start` reads local run receipts and local phase state when available. `martin phase contract` converts that phase state into an explicit run contract with objective, allowed paths, blocked paths, verifiers, budget, risk, and approval posture. Existing `.gsd` workspaces are imported as a compatibility format when present. `martin phase preflight` and `martin phase run` are dry-run by default; add `--execute` only after the contract is safe.

### 1. Doctor

```json
{
  "tool": "martin_doctor",
  "arguments": {
    "engine": "codex"
  }
}
```

### 2. Plan

```json
{
  "tool": "martin_plan",
  "arguments": {
    "objective": "Fix the auth regression and prove it with tests",
    "context": "Keep the diff narrow and avoid secrets or deployment paths."
  }
}
```

### 3. Preflight

```json
{
  "tool": "martin_preflight",
  "arguments": {
    "objective": "Fix the auth regression and prove it with tests",
    "engine": "codex",
    "maxUsd": 3,
    "maxIterations": 3,
    "verificationPlan": ["pnpm test --filter auth"],
    "allowedPaths": ["src/**", "tests/**"],
    "deniedPaths": [".env*", "secrets/**"]
  }
}
```

### 4. Run

```json
{
  "tool": "martin_run",
  "arguments": {
    "objective": "Fix the auth regression and prove it with tests",
    "engine": "codex",
    "maxUsd": 3,
    "maxIterations": 3,
    "verificationPlan": ["pnpm test --filter auth"],
    "allowedPaths": ["src/**", "tests/**"],
    "deniedPaths": [".env*", "secrets/**"]
  }
}
```

### 5. Live Status

Check the active run state:

```json
{
  "tool": "martin_status",
  "arguments": {
    "loopId": "loop-123"
  }
}
```

Read recent run-control receipts:

```json
{
  "tool": "martin_logs",
  "arguments": {
    "loopId": "loop-123",
    "limit": 20
  }
}
```

### 6. Triage

Rank the runs that need attention first:

```json
{
  "tool": "martin_triage_runs",
  "arguments": {}
}
```

### 7. Inspect

For low-context agents, start with compact resources:

```json
{
  "uri": "martin://agent/next-step"
}
```

```json
{
  "uri": "martin://runs/latest/proof-card"
}
```

Use the richest surface:

```json
{
  "tool": "martin_dossier",
  "arguments": {
    "loopId": "loop-123"
  }
}
```

Grade the result for reviewability:

```json
{
  "tool": "martin_eval",
  "arguments": {
    "loopId": "loop-123"
  }
}
```

Or use targeted reads:

```json
{
  "tool": "martin_get_verification_results",
  "arguments": {
    "loopId": "loop-123"
  }
}
```

```json
{
  "tool": "martin_get_attempt",
  "arguments": {
    "loopId": "loop-123",
    "attemptIndex": 1
  }
}
```

### 8. Discovery

Read recent runs:

```json
{
  "uri": "martin://runs/recent"
}
```

```json
{
  "uri": "martin://policies/current"
}
```

```json
{
  "uri": "martin://repo/risk-map"
}
```

Or ask for a kickoff/debug prompt:

```json
{
  "name": "martin_start",
  "arguments": {
    "objective": "Fix the auth regression and prove it with tests"
  }
}
```

```json
{
  "name": "safe_bug_fix",
  "arguments": {
    "objective": "Fix the auth regression and prove it with tests"
  }
}
```

## Tool Inventory

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

## Resource Inventory

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

## Prompt Inventory

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

## Repo-local MCP Verification

```bash
pnpm --filter @martinloop/mcp lint
pnpm --filter @martinloop/mcp test
pnpm --filter @martinloop/mcp build
pnpm --filter @martinloop/mcp smoke:pack
pnpm --filter @martinloop/mcp smoke:published:pack
pnpm --filter @martinloop/mcp verify:release
```

Use `pnpm --filter @martinloop/mcp smoke:published` only after npm publish.
