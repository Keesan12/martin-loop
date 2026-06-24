# MartinLoop 0.3.10 Release Notes

## Auto-Governance: MartinLoop becomes proactive

MartinLoop 0.3.10 turns passive MCP installation into active governance. Agents now know when they're ungoverned, see cost estimates before work starts, and get host-native governance rules installed alongside the MCP server.

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

- Codex error guidance wording cleaned for public surface compliance.
- README version references updated to 0.3.10.

### Verification

- All tests passing across contracts, core, adapters, CLI, and MCP packages.
- `martin estimate` returns route classification and cost estimate without spend.
- `martin mcp print-config --host <host>` outputs governance hooks for all 6 hosts.
- MCP server lists `martin://agent/governance-status` resource and `martin_estimate` tool.
- Build passes with zero type errors.
