# MartinLoop 0.8.2 — CLI input hardening

MartinLoop 0.8.2 is a narrow correctness patch for three CLI input contracts.

## What changed

- `martin preflight ... --proof` now remains non-live even when `MARTIN_LIVE=true`.
- `--max-tokens` now requires a finite number greater than zero.
- Unsupported single-dash run options, including `-proof`, now fail closed instead of being ignored.

These checks run before provider execution or run-store creation. The root package, standalone MCP package, plugin metadata, and MCPB product version are aligned at `0.8.2`.
