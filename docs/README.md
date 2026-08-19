# Documentation

The docs directory contains public guides for onboarding, CLI usage, MCP integration, receipts, security, and release notes.

Start with [../README.md](../README.md) for the main product entrypoint.

## Current MartinLoop experience

MartinLoop governs coding-agent work from Definition of Done through post-run analysis:

```text
DEFINE -> PREFLIGHT -> CONTROL -> VERIFY -> RECOVER -> PROVE -> ANALYZE
```

The canonical product flow is **Definition of Done -> Controlled Run -> Verified Handoff**, with final outcomes `VERIFIED`, `STOPPED`, or `NEEDS REVIEW` based on the evidence actually established.

For humans:

- [Getting started](getting-started/quickstart.md)
- [CLI reference](reference/cli.md)
- [MCP setup](getting-started/mcp.md)
- [Agent run receipts](oss/AGENT-RUN-RECEIPTS.md)

For coding agents and AI assistants:

- [MartinLoop for AI Agents](for-agents.md)
- [Machine-readable summary](../llms.txt)
- [Full machine-readable context](../llms-full.txt)

MartinLoop Arcade and terminal motion are presentation-only. They do not change execution, verification, budgets, final outcomes, or receipt evidence.
