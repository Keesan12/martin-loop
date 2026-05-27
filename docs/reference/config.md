# Config Reference

Place `martin.config.yaml` in your repo root to set default governance policy.

```yaml
budget:
  maxUsd: 5.00
  softLimitUsd: 3.75
  maxIterations: 5
  maxTokens: 40000

governance:
  destructiveActionPolicy: approval
  telemetryDestination: local-only
  verifierRules:
    - pnpm test
```

CLI flags override config values when provided.

## Budget

- `maxUsd`: hard USD cap for the run
- `softLimitUsd`: warning threshold
- `maxIterations`: maximum attempts
- `maxTokens`: maximum token budget

## Governance

- `destructiveActionPolicy`: how MartinLoop handles potentially destructive actions
- `telemetryDestination`: where run telemetry should be sent
- `verifierRules`: verifier commands that are expected for the repository
