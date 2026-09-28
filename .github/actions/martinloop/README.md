# MartinLoop GitHub Action

Run MartinLoop proof or governed execution directly in CI.

## Keyless proof mode (default)

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

Proof mode runs the configured verifier without governed agent execution.

- `proof_passed` — the verifier passed; execution mode remains `verification_only`
- `proof_failed` — the verifier did not pass
- Proof mode is not governance-claim eligible; it never emits `verified`

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

Governed runs invoke a configured coding agent within a budget cap and verifier gate. A successful governed run returns `verified`.

## Output status values

| Status | Meaning |
| --- | --- |
| `proof_passed` | Verifier passed (proof mode, `verification_only`) |
| `proof_failed` | Verifier did not pass (proof mode) |
| `verified` | Governed agent run — verifier passed |
| `stopped` | Governed run exited early (budget, policy, or interruption) |
| `needs_review` | Governed run completed without meeting the verification goal |

`proof_passed` and `verified` are distinct results. Proof mode confirms the verifier passes without agent intervention and is not governance-claim eligible. `verified` confirms a governed agent run met the acceptance criteria.

## Outputs

| Output | Description |
| --- | --- |
| `status` | `proof_passed | proof_failed | verified | stopped | needs_review` |
| `reason-code` | MartinLoop decision or Action validation reason code. |
| `loop-id` | Loop ID emitted by MartinLoop. |
| `cost-usd` | Actual spend in USD. |
| `exit-code` | Raw MartinLoop CLI exit code. |
| `receipt-dir` | Directory containing the share bundle. |

## Inputs

| Input | Default | Description |
| --- | --- | --- |
| `verify` | — | Verifier command, required |
| `mode` | `proof` | `proof` or `run` |
| `objective` | — | Task description (labels the receipt in proof mode) |
| `version` | `0.6.9` | `martin-loop` version |
| `budget-usd` | `2` | Hard spend ceiling in USD (run mode) |
| `max-iterations` | `3` | Maximum attempts (run mode) |
| `engine` | `auto` | `auto`, `claude`, `codex`, `gemini`, or `openai` |
| `fail-on-unverified` | `true` | Fail the workflow step unless status is `proof_passed` or `verified` |
| `upload-receipt` | `true` | Upload the share bundle as a workflow artifact |

## Versioning

The Action is versioned with MartinLoop. Pin to a release tag:

```yaml
uses: Keesan12/martin-loop/.github/actions/martinloop@v0.6.9
```

The Action and CLI are released together. No separate Action tags or repositories.
