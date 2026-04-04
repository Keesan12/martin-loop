# Artifact Review Template

Use this template after each candidate pilot run.

## Required Artifacts

- `contract.json`
- `state.json`
- `ledger.jsonl`
- `compiled-context.json`
- `grounding-scan.json`
- `leash.json`
- `rollback-boundary.json`
- `rollback-outcome.json`

## Review Prompts

1. What was the final lifecycle state and why?
2. Did the grounding evidence support the claimed patch or stop condition?
3. Was the accounting label `actual`, `estimated`, or `unavailable`, and was that label honest?
4. If safety blocked the run, did `leash.json` explain the block clearly?
5. If rollback was involved, do `rollback-boundary.json` and `rollback-outcome.json` prove the repo state was restored or explicitly mark failure?
6. Would you allow this task class again under the same trust profile?

## Decision

- keep as acceptable pilot evidence
- acceptable with follow-up
- reject and escalate
