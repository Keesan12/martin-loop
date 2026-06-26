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

### OpenAI-compatible adapter retries on rate limits and server errors

When using `--engine openai` (DeepSeek, Qwen, OpenRouter, Ollama, etc.), a transient HTTP 429 rate-limit or 5xx server error immediately failed the entire governed run with no recovery. Any work done before the API call was lost.

The adapter now retries up to 3 times with 1s / 2s / 4s exponential backoff on status codes 429, 500, 502, 503, and 504. Auth errors (401/403) and bad-request errors (400) are not retried — those indicate permanent configuration problems.

### 5 new regression tests

- Verifies all `installMcpConfig` code paths call `installClaudeGovernanceHooks` (catches re-introduction of the early-return bug)
- Verifies the governance hook command uses `npx` and no hardcoded absolute path (portability invariant)
- 429 retry: succeeds on second attempt after rate-limit
- 401 no-retry: fails immediately without wasting retries on auth errors
- 503 exhausted: retries exactly 3 times then surfaces the error clearly

## Install

```sh
npm install -g martin-loop@0.3.14
martin mcp install --host claude --scope user
```

Run the second command after upgrading to ensure governance hooks are in place.
