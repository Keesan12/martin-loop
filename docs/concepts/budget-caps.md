# Budget Caps

MartinLoop budgets are part of the run contract. They make the stop conditions visible before the agent starts.

Common budget controls:

- `maxUsd`: hard USD cap
- `softLimitUsd`: warning threshold
- `maxIterations`: maximum number of attempts
- `maxTokens`: maximum token budget

When the next attempt is projected to exceed policy, MartinLoop stops before launching it. That keeps a retry loop from turning a small task into uncontrolled spend.

Example:

```sh
npx martin-loop run "fix the auth regression" \
  --budget 3.00 \
  --soft-limit-usd 2.25 \
  --max-iterations 3 \
  --verify "pnpm test"
```
