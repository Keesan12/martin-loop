# OpenCode Adapter Example

This folder shows how MartinLoop can govern an OpenCode-style coding workflow without pretending the current CLI already ships a native `--engine opencode` flag.

The idea is simple:

- OpenCode is the coding runtime you want to drive.
- MartinLoop is the governance layer around it.
- the MartinLoop contract still owns budget, verifier rules, stop reasons, and the JSONL evidence trail.

## What is in this example

- `martin.config.yaml`: budget and verifier defaults for an OpenCode-style task
- `expected-run-record.jsonl`: the JSONL shape a governed run should append

## Why this example does not require credentials

The runnable path in this folder uses `MARTIN_LIVE=false` so you can validate the governance flow, config loading, verifier gate, and run-record shape without needing a live provider or OpenCode account.

That means this example proves the MartinLoop side of the integration contract first. A future native adapter can replace the stub execution layer without changing the budget, verifier, or record-keeping expectations.

## Example config

Use the included config file:

```yaml
policyProfile: ci_safe
budget:
  maxUsd: 3
  softLimitUsd: 1.5
  maxIterations: 2
  maxTokens: 16000
governance:
  destructiveActionPolicy: approval
  telemetryDestination: local-only
  verifierRules:
    - pnpm --filter @martin/core test
```

## Runnable command

From the repo root:

### PowerShell

```powershell
$env:MARTIN_LIVE='false'
$repoRoot = (Get-Location).Path
pnpm run:cli -- run `
  --cwd $repoRoot `
  --config examples/opencode-adapter/martin.config.yaml `
  --workspace ws_opencode_example `
  --project proj_examples `
  --objective "Summarize how an OpenCode adapter would be governed in this repo" `
  --verify "pnpm --filter @martin/core test" `
  --metadata agentRuntime=opencode `
  --metadata example=opencode-adapter
Remove-Item Env:MARTIN_LIVE
```

What this demonstrates:

- MartinLoop loads the budget defaults from the example config
- the verifier gate is explicit and reviewable
- the run record keeps the OpenCode context in metadata
- the workflow stays credentials-free while you validate the governance layer

## How this maps to a future live adapter

When a real OpenCode adapter exists, the contract should stay mostly the same:

- keep the same budget limits
- keep the same verifier discipline
- keep the same workspace and project identifiers
- keep `agentRuntime=opencode` metadata so the JSONL records are queryable later

The thing that changes is the execution layer, not the governance expectations.

## Expected JSONL output shape

After a run, MartinLoop appends a JSONL record under `~/.martin/runs/<workspaceId>.jsonl`.

This example expects a record with fields shaped like:

- `loopId`
- `workspaceId`
- `projectId`
- `status`
- `lifecycleState`
- `task`
- `budget`
- `cost`
- `attempts`
- `events`
- `metadata`
- `createdAt`
- `updatedAt`

See [`expected-run-record.jsonl`](./expected-run-record.jsonl) for a concrete one-line example.
