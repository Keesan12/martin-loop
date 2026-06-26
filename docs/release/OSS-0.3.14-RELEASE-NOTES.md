# MartinLoop 0.3.14

## Governance Enforcement Reliability Fixes

### `martin mcp install` now writes hooks on every install

On any machine that already had MartinLoop installed, re-running `martin mcp install --host claude` silently skipped writing the PreToolUse gate hooks into `~/.claude/settings.json`. The MCP config file already had a `martin-loop` entry, so `installMcpConfig` returned early without ever reaching the hook-write code.

The PreToolUse hook (`npx martin-loop gate`) is what blocks Bash/Edit/Write until you have an estimate receipt. Without it, governance enforcement only ran when you explicitly called `martin gate` — not automatically.

Every install path now calls `installClaudeGovernanceHooks`, which is idempotent (safe to call multiple times). Existing hooks are not duplicated.

**Who is affected:** Anyone who installed an older version before upgrading to 0.3.13. Run `martin mcp install --host claude --scope user` after upgrading to write the hooks.

### Receipt write failures now surface

When `autoBootstrapGovernedRun` writes the estimate receipt during a governed run, any write failure was silently discarded. The receipt would not be on disk, the gate would block on the next attempt, and there was no indication of why.

Write failures now appear in the run's `persistenceWarnings`, consistent with every other bootstrap step (doctor, session-start, preflight).

### 2 new regression tests

- Verifies all `installMcpConfig` code paths call `installClaudeGovernanceHooks` (catches re-introduction of the early-return bug)
- Verifies the governance hook command uses `npx` and no hardcoded absolute path (portability invariant)

## Install

```sh
npm install -g martin-loop@0.3.14
martin mcp install --host claude --scope user
```

Run the second command after upgrading to ensure governance hooks are in place.
