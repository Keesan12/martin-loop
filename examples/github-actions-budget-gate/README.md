# GitHub Actions Budget Gate

This example shows how to run MartinLoop inside GitHub Actions with an explicit budget cap and verifier gate.

It is safe by default:

- the workflow uses `MARTIN_LIVE=false`
- no provider secrets are required
- the run still produces a persisted JSONL record that can be inspected and uploaded as an artifact

## What is included

- `.github/workflows/martinloop-budget-gate.yml`
- `martin.config.yaml`

## Example budget config

The included config keeps the run intentionally small for CI:

```yaml
policyProfile: ci_safe
budget:
  maxUsd: 1.25
  softLimitUsd: 0.75
  maxIterations: 2
  maxTokens: 12000
governance:
  destructiveActionPolicy: approval
  telemetryDestination: local-only
  verifierRules:
    - pnpm --filter @martin/core test
```

## What the workflow does

1. checks out the repo
2. installs pnpm and Node.js
3. installs dependencies and builds the workspace
4. runs MartinLoop with the example config and a verifier command
5. inspects the resulting JSONL record
6. uploads the run record as a GitHub Actions artifact

## Why this is useful

This pattern makes CI automation more reviewable:

- the spend ceiling is explicit
- the verifier gate is explicit
- the run leaves a machine-readable record behind
- the default example is safe enough to fork and test without live credentials

## Where live credentials would be needed

The checked-in workflow does **not** use live Claude Code or Codex credentials.

If you want a live agent run in CI later, you would need to:

- install the chosen agent CLI in the workflow
- authenticate that CLI with repository or environment secrets
- remove `MARTIN_LIVE=false`
- choose the appropriate MartinLoop engine flags for that adapter path

Keep the same budget and verifier discipline even when the execution layer becomes live.

## Expected output

The run should leave a JSONL record at:

```text
~/.martin/runs/gh_budget_gate.jsonl
```

The inspect step should print a summary with fields such as:

- `totalActualUsd`
- `activeLoops`
- `failuresCaught`
- `averageExitSeconds`
