# Budget Control v3 Hardening Spec

## Problem
Budget control is not real enough if it only records cost after the attempt or if the accounting path breaks before settlement.

## Goal
Budget must control permission to run, not just report what happened after overspend.

## Budget modes
- `exact_accounting`: provider returns reliable usage/cost data and Martin can settle exact usage.
- `estimated_accounting`: Martin can preflight and estimate but cannot claim exact settled cost.
- `unsupported_accounting`: Martin can enforce non-cost envelopes only; no exact or estimated savings claims are allowed.

## Budget stages
### 1. Preflight estimation
For every attempt, compute:
- input packet token estimate
- tool/schema overhead estimate
- output max token estimate
- verifier budget reserve
- retry reserve
- projected worst-case attempt cost

### 2. Admission gate
Block the attempt if:
- projected worst-case exceeds remaining budget,
- marginal value score is below threshold,
- accounting mode is insufficient for the requested policy,
- the route exceeds trust constraints.

### 3. Attempt envelope
Each attempt must carry:
- max input tokens
- max output tokens
- max tool calls
- max files changed
- max commands
- max wall-clock time
- max verifier steps
- max spend for the attempt

### 4. In-flight accounting
Capture:
- provider request usage
- retries and partial failures
- verifier spend
- tool overhead usage
- cumulative loop spend

### 5. Settlement
Persist:
- projected cost
- actual cost if exact
- estimated cost if not exact
- variance
- cost-per-progress-unit
- next-attempt affordability

### 6. Next-attempt permission
Allow the next attempt only if:
- budget remains,
- marginal utility is acceptable,
- novelty is non-trivial,
- failure class is retryable,
- safety state is green.

## Marginal utility score
Initial formula:
- positive factors:
  - verifier delta
  - novelty score
  - grounding improvement
- negative factors:
  - projected next cost
  - repeated failure signature count
  - risk score

A loop with low novelty and low verifier improvement should lose permission even if budget technically remains.

## Saved-spend truth rules
- Never call savings “actual” unless the route supports exact accounting.
- Label estimated savings as estimated and show the methodology.
- CLI-only routes must not masquerade as exact spend-control if they do not settle exact usage.

## Implementation steps
1. Add accounting mode to adapter capability declaration.
2. Add preflight estimator interface.
3. Add route-specific estimator plugins.
4. Add attempt envelope type.
5. Add admission gate before adapter execution.
6. Persist settlement artifacts.
7. Add budget variance to read model.

## Acceptance tests
- Attempt blocked before execution when projected cost exceeds budget.
- Estimated-mode route labels all spend fields as estimated.
- Exact-mode route persists projected and actual values.
- No next attempt permitted when marginal utility collapses.
