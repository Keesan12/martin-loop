# MartinLoop 0.3.16 — Governance hook install, estimate persistence, API retry

## Fixes

### martin mcp install now writes governance hooks on every invocation

`installMcpConfig` returned early without calling `installClaudeGovernanceHooks`
when `~/.claude.json` already contained a `martin-loop` entry. On any machine
that installed an older version first, re-running `martin mcp install` after
upgrading left the PreToolUse gate hook absent.

The PreToolUse hook (`npx martin-loop gate`) is what automatically blocks
Bash/Edit/Write tools until an estimate receipt exists. Without it, governance
enforcement only runs when you explicitly call `martin gate`.

All three `installMcpConfig` code paths (already-present, merged, new-file)
now call `installClaudeGovernanceHooks`, which is idempotent — duplicate hooks
are not written.

**Action required if you installed any version before 0.3.12:**

```sh
martin mcp install --host claude --scope user
```

### Governance gate fires before engine-availability check

In the non-JSON execution path, `evaluateCliRunGate` previously ran after the
check for whether the engine CLI (`claude`, `codex`, `gemini`) is on PATH. In
environments where the engine binary is absent (CI, headless runners, or
machines with a minimal PATH), the engine-absent error surfaced instead of the
governance block.

Gate now runs first. "Run estimate first" is higher-priority feedback than
"install the engine CLI". Behavior is now consistent across all environments.

### Estimate receipt write failures surfaced

`autoBootstrapGovernedRun` was catching estimate-receipt write failures with
`.catch(() => {})`. When `recordCliWorkflowStep("estimate", ...)` failed (e.g.,
runs directory not writable), no error appeared, the gate blocked on the next
call, and there was no diagnostic. Failures now appear in the run's
`persistenceWarnings`, consistent with every other bootstrap step.

### OpenAI-compatible adapter retries on 429 and 5xx

For `--engine openai` (DeepSeek, Qwen, OpenRouter, Ollama, etc.), a transient
HTTP 429 rate-limit or server error immediately failed the governed run with no
recovery attempt.

Retries up to 3 times with exponential backoff: 1s, 2s, 4s. Applies to status
codes 429, 500, 502, 503, 504. Auth errors (401, 403) and bad requests (400)
are not retried — those are permanent configuration issues.

## Tests added

- `installMcpConfig` re-install path calls `installClaudeGovernanceHooks` (regression guard)
- Governance hook command uses `npx`, no hardcoded path (portability invariant)
- 429 retry: adapter succeeds on second attempt after rate-limit
- 401 no-retry: adapter fails immediately, no wasted retries
- 503 exhausted: adapter retries exactly 3 times, then returns `status: "failed"`

## Upgrade

```sh
npm install -g martin-loop@0.3.16
martin mcp install --host claude --scope user
```
