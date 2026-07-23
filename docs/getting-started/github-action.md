# GitHub Action Budget Gate

Fail a pull request when the latest governed AI coding run exceeded its budget, failed verification, or produced an untrusted receipt.

## One-Line Gate

After a MartinLoop run has written its local run record, add:

```yaml
- uses: Keesan12/martin-loop@v1
```

The default gate is `$3.00`. When no receipt path is supplied, the Action runs the published `martin-loop` package to export the latest `run-receipt.json`, then evaluates it.

The Action fails when:

- actual spend is above `$3.00` or above the run's stricter recorded budget
- actual spend is missing or explicitly marked `estimated` or `unavailable`
- the verifier did not pass
- receipt integrity is missing, unsigned, relocated, incomplete, or tampered

## Explicit Configuration

```yaml
- uses: Keesan12/martin-loop@v1
  with:
    max-usd: 3
    martin-version: latest
```

For deterministic CI, pin both the Action commit/tag and the npm package line:

```yaml
- uses: Keesan12/martin-loop@<full-commit-sha>
  with:
    max-usd: 3
    martin-version: 0.4.5
```

## Complete Pull-Request Example

```yaml
name: AI Agent Budget Gate

on:
  pull_request:

permissions:
  contents: read

jobs:
  governed-agent-check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v6

      # Run the governed task earlier in this job or download its receipt artifact.
      - name: Governed verification run
        run: >-
          npx -y martin-loop@latest run
          "Verify this pull request"
          --verify "npm test"
          --budget-usd 3
          --max-iterations 3

      - uses: Keesan12/martin-loop@v1
```

The gate does not reinterpret a timeout, missing verifier, proof fixture, or self-reported agent success as a pass.

## Gate an Existing Receipt

```yaml
- uses: Keesan12/martin-loop@v1
  with:
    receipt: artifacts/run-receipt.json
    max-usd: 3
```

This is useful when the governed run happened in another job and its redacted share receipt was downloaded as an artifact.

## Cost Provenance

MartinLoop labels cost as `actual`, `estimated`, or `unavailable` where the host exposes that distinction. The default Action requires actual cost because an estimated amount cannot prove that a hard dollar threshold was respected.

To permit estimated or unavailable cost while still enforcing verifier and integrity checks:

```yaml
- uses: Keesan12/martin-loop@v1
  with:
    allow-unknown-cost: true
```

Use that exception only when the adapter cannot expose authoritative usage, and keep the warning visible in the GitHub job summary.

## Outputs

- `receipt-path`
- `actual-usd`
- `verifier-status`
- `integrity-status`

## Release Namespace

The implementation currently lives in the `Keesan12/martin-loop` repository. The shorter desired form, `martinloop/action@v1`, requires a dedicated `action` repository under a GitHub organization or account named `martinloop`. Do not publish that usage string until the repository and immutable `v1` release tag exist.
