# MartinLoop 0.8.4 — reliable Codex usage settlement

MartinLoop 0.8.4 corrects governed Codex usage settlement at the terminal event boundary.

## What changed

- A completed Codex attempt is no longer killed when its terminal usage event crosses the configured token limit.
- Pre-terminal JSONL transport bytes and duplicated detail fields are not counted as provider usage.
- One terminal aggregate settles once, verification runs, and the configured budget stops any next attempt when required.

The root package, standalone MCP package, plugin metadata, and MCPB product version are aligned at `0.8.4`.
