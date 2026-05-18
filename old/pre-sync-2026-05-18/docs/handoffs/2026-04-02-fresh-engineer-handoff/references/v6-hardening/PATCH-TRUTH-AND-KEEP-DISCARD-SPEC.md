# Patch Truth and Keep/Discard Spec

## Problem
Many agent systems implicitly keep the latest patch even if it is low-quality, weakly grounded, or harmful.

## Goal
Make the patch decision explicit, repeatable, and evidence-backed.

## Decisions
- `KEEP`
- `DISCARD`
- `ESCALATE`
- `HANDOFF`

## Inputs to patch scoring
- verifier passed?
- verifier delta
- grounding verdict
- scope compliance
- novelty score
- changed-file count
- diff size and risk
- dependency delta
- safety violations
- cost consumed

## Default decision rules
### KEEP
Only if:
- no grounding failure
- no critical safety violation
- scope compliant
- verifier improved or passed
- patch score above threshold

### DISCARD
If any of:
- grounding failure
- critical safety violation
- low novelty + no progress
- significant regression
- forbidden file changes

### ESCALATE
If:
- repeated no-progress across retryable attempts
- human approval required
- conflicting evidence

### HANDOFF
If:
- budget exhausted with useful partial state
- ambiguous business-logic decision remains
- unsupported execution capability required

## Rollback discipline
- Never mutate the working tree without a recoverable state boundary.
- Failed or discarded attempts must restore the baseline or isolated attempt state.

## Required artifacts
- `patch-score.json`
- `patch-decision.json`
- diff stats
- changed files
- keep/discard reason codes

## Acceptance tests
- Regressing patch discarded.
- Grounding-failure patch discarded.
- Improved verifier result with compliant patch kept.
- Unsafe patch escalates or hands off.
