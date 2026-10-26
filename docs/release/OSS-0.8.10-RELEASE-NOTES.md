# MartinLoop 0.8.10

MartinLoop 0.8.10 is a correctness release for CLI contracts, path scope, verifier evidence, and Swarm readiness state.

## What changed

- Command help is read-only and command-specific. JSON help and other machine modes remain directly parseable, and unknown help targets fail closed.
- Unknown long options are rejected before execution instead of being silently accepted by unrelated commands.
- Telemetry and sync return structured machine output without human-stream contamination.
- Native absolute paths that resolve inside the selected working directory are normalized to repository-relative scope. Paths that escape, use a foreign syntax, cross drives, traverse, use UNC roots, or target only the root remain blocked.
- Persisted verifier filesystem bindings are compared using their recorded Windows or POSIX syntax, including the correct case-sensitivity rules.
- Verifier-only execution declares its actual zero-provider pricing during budget preflight.
- Swarm planning and readiness commands now share one canonical workflow-state authority with exact receipt hashes and bounded clock-skew handling.
- Interactive milestone prompts stay out of JSON, quiet, and CI execution.

## Safety boundary

This release does not weaken scope, rollback, verifier, budget, or receipt-integrity controls. MartinLoop governs observed repository changes and its own rollback operations; it is not an operating-system sandbox for a provider process that already has host-level filesystem access.

## Verification

The release is accepted only after the exact versioned source passes the complete build, lint, test, public-surface, package-smoke, MCP, and platform-release validation gates.
