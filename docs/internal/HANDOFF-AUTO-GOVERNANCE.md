# Handoff: MartinLoop Auto-Governance

## What needs to happen

MartinLoop is installed as an MCP server but it's passive. It should proactively govern agent work across all hosts: Claude Code, Codex, Gemini CLI, Cursor, Copilot, Continue.

## Three pieces to build

### 1. MCP Server: Proactive governance resource

**File:** `packages/mcp/src/server.ts`

The `martin://agent/governance-status` resource should return:
- Is this session governed? (has a run been started?)
- Current budget remaining (if a run is active)
- Unreceipted runs count
- Recommended action ("Run `martin_preflight` before making changes")

The existing `martin://agent/next-step` resource partially does this but needs to be more assertive.

### 2. Host-specific governance hooks

When `martin mcp install --host <host>` runs, it should output governance hook config for that host:

**Claude Code** (`--host claude`):
```json
{
  "hooks": {
    "PreToolUse": [{"matcher": "Bash|Edit|Write", "command": "martin-loop doctor --json --quiet"}],
    "Stop": [{"command": "martin-loop dossier --latest --quiet"}]
  }
}
```

**Codex** (`--host codex`): Add to `~/.codex/config.toml` approval/governance section.

**Gemini** (`--host gemini`): Gemini CLI settings integration.

**Cursor/Copilot/Continue** (`--host cursor|copilot|continue`): MCP-only (hooks not supported), rely on the proactive MCP resource.

**File:** `packages/cli/src/mcp-config.ts` — extend the install command to also output hook config.

### 3. `martin estimate` CLI command

**File:** `packages/cli/src/index.ts`

New command:
```sh
martin estimate "Fix the auth bug" --engine claude --budget-usd 3
```

Uses `classifyRoute()` from `packages/core/src/routing.ts` to return:
- Selected route (direct/manager/consensus)
- Estimated cost
- Estimated Pre Work Burn
- Recommended budget

No spend. Pure estimation.

## What's already built that should be reused

- `classifyRoute()` in `packages/core/src/routing.ts` — task complexity scoring
- `evaluatePreworkBurnPolicy()` — policy caps
- `calculateCostPerOutcome()` — cost metrics
- `buildLoopPreview()` in `packages/mcp/src/tools/tool-support.ts` — already surfaces `routingEconomics`
- `martin://agent/next-step` resource — existing proactive hint resource
- `parseMcpProfile()` and `executeMcpInstallCommand()` — existing host config generation

## Acceptance criteria

- An agent connecting via MCP should see governance guidance without being asked
- `martin estimate` should return cost estimate in under 2 seconds
- `martin mcp install --host claude` should output hook config alongside MCP config
- Works for: Claude Code, Codex, Gemini CLI, Cursor, Copilot, Continue
- No spend, no side effects from the governance check

## Current state

- Subpath exports shipped (`martin-loop/core`, `martin-loop/contracts`, `martin-loop/adapters`)
- `martin-loop@0.3.10` live on npm with all CLI commands working
- Public repo synced
- 481 tests passing
