# Scripts

This directory contains public release guards, smoke checks, and repository validation utilities.

Release automation must preserve a strict distinction between **live public artifacts** and **in-repo release targets**. A version bump in source is not proof that npm, GitHub Releases, the MCP registry, or an MCPB artifact is already live.

Guards should validate the same public execution-control truth exposed by the runtime without encoding host-specific Codex flag assumptions or fixed MCP surface counts that can drift independently.

For the current release map see [`../docs/release/VERSION-LEDGER.md`](../docs/release/VERSION-LEDGER.md). For agent-facing product context see [`../llms.txt`](../llms.txt) and [`../docs/for-agents.md`](../docs/for-agents.md).
