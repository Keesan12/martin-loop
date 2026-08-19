# GitHub Actions Budget Gate

This example shows how to run MartinLoop inside GitHub Actions with an explicit budget cap and verifier gate.

It is safe by default:

- the workflow uses `MARTIN_LIVE=false`
- no provider secrets are required
- the verification lane still produces a persisted JSONL record that can be inspected and uploaded as an artifact

Because `MARTIN_LIVE=false`, this checked-in example is **not** evidence that a coding agent edited the repository. It demonstrates verification, policy, budget configuration, persistence, and CI integration without pretending that no-spend verification is a governed coding-agent run.

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
4. runs the configured MartinLoop verification lane with a verifier command
5. inspects the resulting JSONL record
6. uploads the run record as a GitHub Actions artifact

## Why this is useful

This pattern makes CI automation more reviewable:

- the spend ceiling is explicit
- the verifier gate is explicit
- the execution mode is explicit
- the run leaves a machine-readable record behind
- the default example is safe enough to fork and test without live credentials

A real live coding-agent workflow can use the same larger lifecycle, `DEFINE -> PREFLIGHT -> CONTROL -> VERIFY -> RECOVER -> PROVE -> ANALYZE`, once the chosen agent is installed and authenticated.

## Where live credentials would be needed

The checked-in workflow does **not** use live Claude Code or Codex credentials.

If you want a live agent run in CI later, you would need to:

- install the chosen agent CLI in the workflow
- authenticate that CLI with repository or environment secrets
- remove `MARTIN_LIVE=false`
- choose the appropriate MartinLoop engine flags for that adapter path

Keep the same budget and verifier discipline even when the execution layer becomes live.

For Codex, do not hard-code a compatibility flag from documentation. MartinLoop 0.5.3 negotiates capabilities from the resolved Codex binary.

## Expected output

The verification lane should leave a JSONL record at:

```text
~/.martin/runs/gh_budget_gate.jsonl
```

The inspect step should print a summary with fields such as:

- `totalActualUsd`
- `activeLoops`
- `failuresCaught`
- `averageExitSeconds`

For canonical product and agent-facing definitions see [`../../README.md`](../../README.md), [`../../llms.txt`](../../llms.txt), and [`../../docs/for-agents.md`](../../docs/for-agents.md).
