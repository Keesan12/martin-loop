# Adapter Stability and Golden Path Spec

## Problem
Nothing else matters if the adapter or runtime crashes before completion. Golden-path stability is a prerequisite for all hardening work.

## Golden path definition
One canonical path must succeed end-to-end:
1. contract load
2. context compile
3. budget admission
4. leash check
5. adapter execution
6. verifier run
7. grounding evaluation
8. patch decision
9. settlement
10. persistence
11. read-model visibility

## Rules
- One adapter interface only.
- One canonical runtime entrypoint.
- Duplicate or dead runtime paths must be quarantined.
- Missing-function or unhandled-mode crashes are release blockers.

## Required adapter capability declaration
Every adapter must declare:
- accounting mode
- streaming support
- tool support
- max envelope capability
- exact vs estimated usage support
- failure semantics

## One-week goal
Certify one golden path first, then expand.

## Acceptance tests
- Adapter initializes.
- Adapter executes.
- Runtime completes with a structured failure or success.
- Contract, state, events, and attempts are persisted.
- Read model can display the run.
