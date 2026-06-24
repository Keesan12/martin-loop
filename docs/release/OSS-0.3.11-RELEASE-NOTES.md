# MartinLoop 0.3.11 Release Notes

## Auto-Governance: MartinLoop becomes proactive

MartinLoop 0.3.11 turns passive MCP installation into active governance. Agents now know when they're ungoverned, see cost estimates before work starts, and get host-native governance rules installed alongside the MCP server.

### What's new

**`martin_estimate` tool and CLI command**
Estimate cost, route, and Pre Work Burn for any objective without spending. Uses the route classifier from 0.3.9 to predict whether a task needs direct execution or manager orchestration, and recommends a budget.

```sh
martin estimate "Fix the auth bug" --engine claude --budget-usd 3
```

Available via MCP (`martin_estimate` tool) and CLI (`martin estimate`).

**`martin://agent/governance-status` resource**
New MCP resource that proactively tells agents whether the current session is governed. Returns workflow receipt state (doctor/plan/preflight), budget remaining, unreceipted runs, and the recommended next action. Agents can read this before starting work to know if they're operating without governance.

**Host-specific governance hooks**
`martin mcp install` and `martin mcp print-config` now output governance configuration alongside the MCP server config for every supported host:

| Host | Mechanism |
|------|-----------|
| Claude Code | PreToolUse + Stop hooks in `~/.claude/settings.json` |
| Codex | AGENTS.md governance instructions |
| Gemini CLI | GEMINI.md governance rules |
| Cursor | `.cursor/rules/martin-governance.mdc` rules file |
| GitHub Copilot | `.github/copilot-instructions.md` instructions |
| Continue.dev | `.continue/rules/martin-governance.md` rules |

### Fixed

- **MCP server conflict in governed Claude runs** — spawned Claude subprocesses now pass `--strict-mcp-config` to prevent the child process from loading the parent's MCP servers. Previously, a MartinLoop MCP server in the user's config would get spawned inside the governed subprocess, causing "MCP server being overwritten" errors and blocking runs.
- **Budget cap enforcement hardened with time-based fallback** — the streaming usage inspector now terminates subprocesses that receive data for 30+ seconds without emitting any usage events. Previously, if Claude's stream-json event format changed, the inspector would go blind and the subprocess would run unmetered past the budget cap. The byte-ceiling fallback is retained as a second layer.
- **Budget cap applies from first attempt** — the remaining-budget cap passed to the streaming inspector correctly starts at the full budget minus prior spend, so the very first attempt is bounded.
- Codex error guidance wording cleaned for public surface compliance.
- README version references updated to 0.3.11.

### Verification

- All tests passing across contracts, core, adapters, CLI, and MCP packages.
- `martin estimate` returns route classification and cost estimate without spend.
- `martin mcp print-config --host <host>` outputs governance hooks for all 6 hosts.
- MCP server lists `martin://agent/governance-status` resource and `martin_estimate` tool.
- Build passes with zero type errors.
