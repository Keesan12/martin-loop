# Examples

These examples are grounded in the current public CLI and MCP surfaces in this repo.

## 1. Stub-backed hello world

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

## 2. Repo-backed task with explicit scope

```bash
pnpm run:cli -- run \
  --cwd . \
  --objective "Tighten README wording for the OSS quickstart" \
  --verify "pnpm --filter @martin/core test" \
  --allow-path README.md \
  --allow-path docs/oss/** \
  --deny-path demo/seeded-workspace/** \
  --accept "Only update documentation files" \
  --accept "Do not modify runtime code"
```

## 3. Safety-block example

```bash
pnpm run:cli -- run \
  --objective "Try to run an unsafe verifier" \
  --verify "rm -rf ."
```

Expected behavior: Martin Loop blocks the verifier before adapter execution and records the failed admission path instead of attempting the command.

## 4. Budget-constrained live run

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

## 5. MCP invocation shape

The MCP server exposes `martin_run`, `martin_inspect`, and `martin_status`.

Example `martin_run` payload:

```json
{
  "objective": "Tighten the OSS quickstart wording",
  "workingDirectory": ".",
  "engine": "claude",
  "verificationPlan": ["pnpm --filter @martin/core test"],
  "maxUsd": 5,
  "maxIterations": 2,
  "maxTokens": 20000,
  "workspaceId": "ws_mcp",
  "projectId": "proj_mcp"
}
```

## 6. GitHub Actions budget gate example

See [`../../examples/github-actions-budget-gate/`](../../examples/github-actions-budget-gate/) for a CI-safe example that runs Martin Loop with a budget cap, an explicit verifier, and an uploaded JSONL run record artifact.

## 7. OpenCode-style adapter example

See [`../../examples/opencode-adapter/`](../../examples/opencode-adapter/) for a no-credentials-required adapter sketch that keeps Martin Loop’s budget, verifier, and JSONL record shape stable around an OpenCode-style workflow.
