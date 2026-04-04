# Examples

These examples are grounded in the current CLI and MCP surfaces in this repo. Where an example depends on a real provider path, it is labeled that way explicitly.

These are still primarily repo-local RC examples. The root `martin-loop` package facade is now real and smoke-validated, but registry publication remains a later release step.

## 1. Stub-backed hello world

Use this when you want a safe first pass through the loop without real model spend.

### PowerShell

```powershell
$env:MARTIN_LIVE='false'
pnpm run:cli -- run `
  --workspace ws_demo `
  --project proj_demo `
  --objective "Describe the current Martin run lifecycle in one paragraph" `
  --verify "pnpm --filter @martin/core test"
Remove-Item Env:MARTIN_LIVE
```

Why this is useful:

- exercises `runMartin`
- writes a real loop record and artifacts
- avoids external provider dependencies

## 2. Repo-backed task with explicit scope

Use allow and deny paths so the task contract is narrow and reviewable.

```bash
pnpm run:cli -- run \
  --cwd . \
  --objective "Tighten README wording for the OSS quickstart" \
  --verify "pnpm --filter @martin/core test" \
  --allow-path README.md \
  --allow-path docs/oss/** \
  --deny-path apps/control-plane/** \
  --accept "Only update documentation files" \
  --accept "Do not modify runtime code"
```

What this demonstrates:

- repo root selection with `--cwd`
- scoped file-edit boundaries
- acceptance criteria injection into the task contract

## 3. Safety-block example

This example is expected to block before execution because the verifier command is unsafe.

```bash
pnpm run:cli -- run \
  --objective "Try to run an unsafe verifier" \
  --verify "rm -rf ."
```

Expected behavior:

- the leash blocks the verifier command before adapter execution
- the run exits through a safety-oriented path rather than pretending the command was acceptable
- the attempt artifact set includes a persisted leash artifact when applicable

The point of this example is not that `rm` exists on every machine. The point is that the raw verifier text is evaluated before the process would be allowed to run.

## 4. Budget-constrained live run

This is a live-provider example. Only use it when you have the relevant CLI and credentials configured.

```bash
pnpm run:cli -- run \
  --engine codex \
  --model o3 \
  --objective "Refactor the CLI argument parser for clarity" \
  --verify "pnpm --filter @martin/cli test" \
  --budget-usd 2 \
  --soft-limit-usd 1 \
  --max-iterations 2
```

What to review afterward:

- admission and settlement events in `ledger.jsonl`
- cost provenance labels in the run artifacts
- whether the loop stopped for completion, budget pressure, or lack of progress

## 5. MCP invocation shape

The MCP server exposes `martin_run`, `martin_inspect`, and `martin_status`.

Example `martin_run` payload:

```json
{
  "objective": "Tighten the local dashboard copy",
  "workingDirectory": ".",
  "engine": "claude",
  "verificationPlan": ["pnpm --filter @martin/control-plane test"],
  "maxUsd": 5,
  "maxIterations": 2,
  "maxTokens": 20000,
  "workspaceId": "ws_mcp",
  "projectId": "proj_mcp"
}
```

## 6. What to inspect in artifacts

For a repo-backed attempt, look at:

- `contract.json`
- `state.json`
- `ledger.jsonl`
- `artifacts/attempt-XXX/compiled-context.json`
- `artifacts/attempt-XXX/diff.patch`
- `artifacts/attempt-XXX/grounding-scan.json`
- `artifacts/attempt-XXX/leash.json`
- `artifacts/attempt-XXX/patch-score.json`
- `artifacts/attempt-XXX/patch-decision.json`
- `artifacts/attempt-XXX/rollback-boundary.json`
- `artifacts/attempt-XXX/rollback-outcome.json`

Those files are the evidence trail that backs the runtime’s claims.
