# MartinLoop 0.6.9 — Proof Truth + Loop-Tax Audit

## What changed

### Proof mode now reports what actually happened

The explicit `--proof` lane remains verification-only and cannot claim governed `VERIFIED` completion. In 0.6.9, its process result now follows the verifier instead of failing solely because the run is intentionally governance-ineligible:

- verifier passes → `PROOF_PASSED`, exit 0
- verifier fails → `PROOF_FAILED`, exit 7
- safety or policy blocks still take precedence

Human output says `proof passed` or `proof failed` and does not render the governed Verified Handoff banner for proof-only runs.

### Measure your coding-agent loop tax

Run:

```sh
npx -y martin-loop@0.6.9 audit
```

`martin audit` reads local Claude Code session history and reports:

- API-equivalent agent spend
- spend inside fix-and-retry loops
- failed verifier runs and longest retry chain
- repeated stuck verifier loops
- sessions that ended on a failing check
- edited sessions where no recognized verifier command ran

Session contents are analyzed locally. The default mode may fetch the public LiteLLM model-price list; no session contents are sent. Use `--offline` for zero-network analysis.

Use `--share` to write `loop-tax-card.svg` and `loop-tax.md`.

## Trust boundary

The audit is diagnostic evidence, not billing truth. When Claude Code records a session cost MartinLoop uses that total; otherwise it estimates API-equivalent cost from model token pricing. Subscription users pay according to their provider plan, so the dollar output should be read as API-equivalent spend.

A passing `--proof` run is verifier evidence only. It remains `executionMode=verification_only` and `governanceClaimEligible=false`.
