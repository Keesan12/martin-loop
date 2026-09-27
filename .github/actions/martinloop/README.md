# MartinLoop GitHub Action

Run MartinLoop proof or governed execution directly in CI.

## Keyless proof mode

```yaml
jobs:
  verify:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
      - run: npm ci
      - uses: Keesan12/martin-loop/.github/actions/martinloop@v0.6.9
        with:
          verify: npm test
```

Proof mode runs the configured verifier with zero agent spend. A passing verifier returns `proof_passed`; it does not claim governed `VERIFIED`.

## Governed run

```yaml
      - uses: Keesan12/martin-loop/.github/actions/martinloop@v0.6.9
        env:
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
        with:
          mode: run
          engine: claude
          objective: Fix the failing unit tests without changing public APIs
          verify: npm test
          budget-usd: 3
          max-iterations: 3
```

The action uploads the MartinLoop share bundle when available and exposes `status`, `reason-code`, `loop-id`, `cost-usd`, `exit-code`, and `receipt-dir`.
