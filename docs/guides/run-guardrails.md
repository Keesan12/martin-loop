# Run Guardrails (Operator Quick Guide)

Set governance guardrails before starting any `martin run`.

## 1) Start from the example config

Copy `martin.config.example.yaml` into your workspace as `martin.config.yaml` and set your approved defaults:

- `policyProfile`
- budget caps in `budget`:
  - `maxUsd` for the hard cost cap
  - `softLimitUsd` for the early-warning cost cap
  - `maxIterations` for the iteration cap
  - `maxTokens` for the token cap
- governance routing in `governance`:
  - `destructiveActionPolicy`
  - `telemetryDestination`
  - `verifierRules`

When `martin.config.yaml` exists in the current working directory, the CLI loads it automatically.

You can also point to a specific file with `--config <path>`.

## 2) Apply run-time overrides only when needed

CLI overrides win over config defaults for that run:

```bash
pnpm --filter @martin/cli dev -- run \
  --objective "Repair flaky CI gate" \
  --config ./martin.config.yaml \
  --policy balanced \
  --budget-usd 8 \
  --soft-limit-usd 5 \
  --max-iterations 3 \
  --max-tokens 20000 \
  --telemetry control-plane
```

## 3) Confirm effective policy in run output

`run` output now includes an `effectivePolicy` block with the final values used for:

- `configPath`
- `policyProfile`
- budget limits
- `destructiveActionPolicy`
- `verifierRules`
- `telemetryDestination`

If you do not pass `--verify`, the CLI uses the verifier rules from `martin.config.yaml` as the run's verification plan. Use `effectivePolicy` as the operator receipt of what was enforced.
