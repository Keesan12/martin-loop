# Quickstart

This quickstart covers the public OSS runtime and the standalone `@martinloop/mcp@0.2.5` cockpit line.

## Public Release Train

- 0.1.4 operator foundation.
- 0.2.0 cockpit expansion. 0.2.0 adds resources, resource templates, prompts, and read-only cockpit inspection.
- 0.2.5 stable cockpit line. 0.2.5 adds triage and degraded run-store hardening.

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

### 1. Doctor

```json
{
  "tool": "martin_doctor",
  "arguments": {
    "engine": "codex"
  }
}
```

### 2. Preflight

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

### 3. Run

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

### 4. Triage

Rank the runs that need attention first:

```json
{
  "tool": "martin_triage_runs",
  "arguments": {}
}
```

### 5. Inspect

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
  "tool": "martin_run_dossier",
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

### 6. Discovery

Read recent runs:

```json
{
  "uri": "martin://runs/recent"
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

## Tool Inventory

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

## Resource Inventory

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
