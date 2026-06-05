# Examples

These examples use the public CLI and MCP package.

## Proof-Mode Run

PowerShell:

```powershell
$env:MARTIN_LIVE='false'
pnpm run:cli -- run `
  --workspace ws_demo `
  --project proj_demo `
  --objective "Describe the current MartinLoop run lifecycle in one paragraph" `
  --verify "pnpm --filter @martin/core test"
Remove-Item Env:MARTIN_LIVE
```

## Repo-Backed Documentation Task

```sh
pnpm run:cli -- run \
  --cwd . \
  --objective "Tighten README wording for the quickstart" \
  --verify "pnpm --filter @martin/core test" \
  --allow-path README.md \
  --allow-path docs/** \
  --deny-path demo/seeded-workspace/** \
  --accept "Only documentation files may change" \
  --accept "Do not modify runtime code"
```

## Safety Block

```sh
pnpm run:cli -- run \
  --objective "Try to run an unsafe verifier" \
  --verify "rm -rf ."
```

Expected behavior: MartinLoop blocks the verifier before adapter execution and records the failed admission path.

## Budget-Constrained Live Run

```sh
pnpm run:cli -- run \
  --engine codex \
  --objective "Refactor the CLI argument parser for clarity" \
  --verify "pnpm --filter @martin/cli test" \
  --budget-usd 2 \
  --soft-limit-usd 1 \
  --max-iterations 2
```

## MCP Invocation Shape

Example `martin_run` payload:

```json
{
  "objective": "Tighten the quickstart wording",
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

## More Examples

- [GitHub Actions budget gate](../../examples/github-actions-budget-gate/)
- [OpenCode-style adapter](../../examples/opencode-adapter/)
