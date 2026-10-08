# MartinLoop 0.8.1 — Governed-run closeout

MartinLoop 0.8.1 tightens governed execution and input handling after the 0.8.0 release.

## What changed

- Retired `--verify-only` input now fails closed before provider launch; use `--proof` for non-governed verification-only evidence.
- Unknown `run` flags and malformed verifier input now return invalid input instead of starting a run.
- Windows Codex governed runs preserve writable workspace execution through capability-driven launch negotiation.
- Codex preflight rejects explicitly configured token caps that cannot cover a viable first turn before provider launch or spend.
- Multi-runtime onboarding now documents the required `martin enable --engine <engine>` selection.
- The deterministic Swarm demo labels its result as local demo evidence and does not imply that it was persisted to the Swarm run store.

The root package, standalone MCP package, plugin metadata, and MCPB product version are aligned at `0.8.1`.
