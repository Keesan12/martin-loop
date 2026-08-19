# Benchmarks

This workspace contains deterministic benchmark suites used to evaluate governed agent execution and reproducibility.

Use `npx martin-loop bench --suite under-3-challenge` for the primary public benchmark lane.

## What the benchmarks measure

MartinLoop benchmarks are evidence for parts of the execution-control lifecycle, not a claim that every coding task will produce the same cost or quality result.

Use them to inspect governed behavior around budgets, attempts, verification, failure classification, and outcome evidence. The broader product lifecycle is `DEFINE -> PREFLIGHT -> CONTROL -> VERIFY -> RECOVER -> PROVE -> ANALYZE`.

For agent-readable product context see [`../llms.txt`](../llms.txt) and [`../docs/for-agents.md`](../docs/for-agents.md).
