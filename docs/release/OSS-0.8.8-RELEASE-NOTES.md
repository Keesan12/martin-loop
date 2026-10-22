# MartinLoop 0.8.8 — fail-closed observation and bounded private-file checks

MartinLoop 0.8.8 is a security follow-up to 0.8.7. It closes cases where a late workspace-observation error could outlive a successful verifier, where a newly created focused test could weaken the effective test run, and where ignored-file integrity checks could consume excessive I/O.

## What's fixed

- **Observation failures stay terminal.** If MartinLoop cannot inspect repository effects after provider execution, the attempt stops with an explicit workspace-observation failure, attempts safe rollback, and cannot be reported as VERIFIED.
- **New focused tests need approval.** Brand-new tests that introduce focused, skipped, or expected-failure markers are treated as test weakening and require `--approve-test-changes`. Ordinary new tests remain allowed.
- **Ignored-file integrity work is bounded.** Per-file and aggregate hashing limits cap private-file inspection. Hashes remain in memory only and are not written to receipts or rollback artifacts. Files outside the hash budget still use metadata checks so later changes are not silently accepted.
- **Claude cost evidence stays authoritative.** Provider-reported `total_cost_usd` is retained even when Claude Code omits token usage, without inventing token counts or calculated spend.
- **Launcher parsing accepts supported forms safely.** Versioned `npx` and package-manager `exec` invocations are recognized while malformed quotes and accidentally folded MartinLoop options remain rejected. MCP JSON verification-plan entries are parsed as discrete commands rather than receiving CLI argv-fold detection; malformed quotes are still rejected.
- **Blocked-run guidance is actionable.** The CLI points to the supported attempt-inspection command when a governed change is rejected.

## Upgrade

```sh
npx -y martin-loop@0.8.8 --version
npx -y martin-loop@0.8.8 doctor
```

If you use the standalone MCP server, upgrade it to `@martinloop/mcp@0.8.8`. The CLI, MCP server, plugin manifests, and MCPB product version advance together; MCPB manifest schema remains `0.3`.

## Security boundary

MartinLoop governs observed repository changes and its own rollback operations. It does not provide an operating-system sandbox for a provider process launched with host-level filesystem access. Use an isolated sandbox when outside-repository writes must be prevented.
