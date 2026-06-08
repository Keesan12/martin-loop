# Verifier Safety

Verifier commands decide whether a run is complete, so they must be safe and reviewable.

Good verifier commands:

- run tests or static checks
- stay scoped to the repository
- avoid network-dependent side effects when possible
- do not delete files or mutate unrelated state

Examples:

```sh
pnpm test
pnpm --filter @martin/cli test
npm test
```

Commands that can delete broad paths, exfiltrate data, or hide failed checks should be blocked or rewritten before use.
