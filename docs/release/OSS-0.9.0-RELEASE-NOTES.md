# MartinLoop 0.9.0

MartinLoop 0.9.0 strengthens governed multi-agent execution, live run control, cleanup recovery, and release evidence.

## What changed

- Governed Swarm runs require explicit agent and concurrency limits. Provider-free governed runs require exactly $0; live runs require a positive budget, canonical provider execution, and settlement evidence that reconciles with the run ledger.
- Local MCP clients can pause, continue, and cancel eligible runs. Controls are capability-aware, preserve terminal-state precedence, and record requested versus applied outcomes.
- Execution leases, control journals, cancellation publication, and stale-lock recovery are hardened against replay, PID reuse, link attacks, and concurrent reclaim races.
- Cleanup ownership is crash-safe and quarantine recovery remains explicit when the workspace cannot be restored safely.
- The 13-class failure taxonomy and governed Live Swarm release evidence are bound to exact source and build bytes across supported platforms.

## Compatibility

No existing CLI command or MCP tool is removed. Live Swarm execution is intentionally stricter: agent count, concurrency, budget, and provider evidence must be explicit and internally consistent.

## Safety boundary

MartinLoop governs observed repository changes and its own recovery operations. It is not an operating-system sandbox for a provider process with host-level filesystem access. Use an isolated sandbox where outside-repository writes must be prevented.

## Verification

The release is accepted only after the exact versioned source passes build, lint, full tests, public-surface guards, package smoke tests, and hosted Windows, macOS, and Linux release validation.
