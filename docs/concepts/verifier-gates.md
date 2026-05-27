# Verifier Gates

A patch is not enough. MartinLoop only treats a run as complete when the agent result and verifier state both pass.

Good verifier commands are:

- scoped to the task
- deterministic enough to trust
- safe to run locally or in CI
- specific enough to catch the failure being fixed

Examples:

```sh
npx martin-loop run "fix the auth regression" --verify "pnpm test"
npx martin-loop run "update CLI help text" --verify "pnpm --filter @martin/cli test"
```

Unsafe verifier commands are blocked before agent execution. If a verifier can delete files, exfiltrate data, or mutate unrelated state, use a safer check.
