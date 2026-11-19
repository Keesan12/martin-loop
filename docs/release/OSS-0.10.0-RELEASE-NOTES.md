# MartinLoop 0.10.0

MartinLoop 0.10.0 makes long-running governed work durable across interruption, restart, and recovery.

## What changed

- Immutable, source-bound checkpoints preserve mission state, work queues, context, memory authority, and remaining budget.
- Governed Memory V2 provides scoped, provenance-bound, hash-chained memory with explicit promotion, expiry, supersession, and revocation.
- A durable mission supervisor schedules validated work-item graphs, bounds every child run, and admits only verifier-approved candidates for integration.
- Restart and recovery reconstruct valid state without duplicate execution, billing, verification, promotion, or integration.
- Provider-free governed runs require exactly $0; live runs require a positive budget. Overnight acceptance tooling exercises checkpoint, memory, verifier, receipt, settlement, and recovery invariants without provider calls or spend.
- Windows process supervision and cleanup are hardened for interrupted and resumed child lifecycles.

## Compatibility

Existing CLI commands, MCP tools, and provider integrations remain available. Durable mission and memory operations preserve the same explicit workspace, budget, and verifier boundaries.

## Verification

The exact release source is accepted only after build, lint, complete tests, public-surface guards, package smoke tests, governed 15-agent provider-free dogfood, and supported-platform release validation pass.
