# Packages

This directory contains MartinLoop package modules for contracts, core runtime, adapters, CLI, and MCP server support.

Together these packages implement one execution-control lifecycle around coding agents:

```text
DEFINE -> PREFLIGHT -> CONTROL -> VERIFY -> RECOVER -> PROVE -> ANALYZE
```

Keep shared contracts, runtime decisions, presentation, CLI, and MCP surfaces aligned so `VERIFIED`, `STOPPED`, and `NEEDS REVIEW` mean the same thing everywhere.

For the public category and agent-facing definitions see [`../README.md`](../README.md), [`../llms.txt`](../llms.txt), and [`../docs/for-agents.md`](../docs/for-agents.md).
