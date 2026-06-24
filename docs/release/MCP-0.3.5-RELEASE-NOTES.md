# @martinloop/mcp 0.3.5 Release Notes

## Auto-Governance Tools

The MCP server now proactively helps agents understand governance state and estimate costs before spending.

### What's new

**`martin_estimate` tool**
Estimate cost, recommended route, and Pre Work Burn for any objective without spending. Returns the selected execution mode (direct/manager/consensus), confidence score, expected cost, and a recommended budget. Available in all MCP tool profiles (minimal, diagnostic, starter, full, paid-remote).

**`martin://agent/governance-status` resource**
New static resource that returns whether the current session is governed. Shows workflow receipt state (doctor/plan/preflight completions), budget remaining from the latest active run, unreceipted run count, and the recommended next action. Agents can read this before starting work to know if they're operating without governance.

### Fixed

- **MCP server conflict in governed Claude runs** — spawned Claude subprocesses now pass `--strict-mcp-config` to prevent the child process from loading the parent's MCP servers.
- **Budget cap enforcement hardened** — streaming usage inspector terminates subprocesses that receive data for 30+ seconds without usage events, preventing unmetered spend.

### Verification

- All MCP baseline and discovery tests passing.
- `martin_estimate` tool registered and callable.
- `martin://agent/governance-status` resource listed and readable.
- Tool profiles updated: martin_estimate in minimal, diagnostic, starter, full, paid-remote.
