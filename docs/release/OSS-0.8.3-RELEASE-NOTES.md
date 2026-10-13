# MartinLoop 0.8.3 — evidence and input correctness

MartinLoop 0.8.3 closes the remaining partner-retest gaps across input handling, proof lifecycle, and evidence presentation.

## What changed

- Unsupported or malformed run and preflight options fail closed before provider, probe, or run-store side effects.
- Proof-only verification reports its non-governed lifecycle, file effects, and evidence readiness consistently across CLI and MCP surfaces.
- The deterministic Swarm demo is explicitly labeled local simulation and cannot be selected as a persisted or signed run.
- Multi-runtime engine preferences and portable MCP configuration preserve explicit runtime and run-root choices.

The root package, standalone MCP package, plugin metadata, and MCPB product version are aligned at `0.8.3`.
