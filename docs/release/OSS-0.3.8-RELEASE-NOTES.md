# MartinLoop 0.3.8 — Budget Safety, Engine Discovery, Verification Diagnosis

`0.3.8` fixes a critical budget overshoot defect, adds engine auto-discovery so runs don't fail on missing PATH entries, and gives failed attempts real diagnostic context instead of generic error messages.

## Budget Circuit Breaker (Critical Fix)

The streaming usage inspector only matched `type=assistant` events from Claude's `stream-json` output. When the event shape didn't match, the inspector did nothing — the subprocess ran to completion with no mid-stream budget check. In production this produced a $28 spend on a $1.50 budget.

**Fixed:**
- Matches usage fields on any event type, not just `assistant`
- Checks `total_cost_usd` on every event for authoritative mid-stream cost
- Triggers at 80% of cap instead of 100% to bound single-turn overshoot
- Falls back to a byte-ceiling kill switch when no usage events arrive at all

## Shell Operators in Verify Commands

`bun run lint && bun run test` was split into `["bun", "run", "lint", "&&", "bun", "run", "test"]` — the `&&` was passed as a literal argument. Commands with shell operators now route through `cmd.exe /c` (Windows) or `sh -c` (Unix).

## Engine Auto-Discovery

If `claude`, `codex`, or `gemini` isn't on PATH, the CLI now checks common install directories before failing:
- npm global (`AppData/Roaming/npm`, `.npm-global/bin`)
- homebrew (`/opt/homebrew/bin`)
- Local installs (`.local/bin`, `.bun/bin`, `.cargo/bin`)
- nvm (`$NVM_DIR/current/bin`)
- Scoop, Codex Desktop (Windows)

When the CLI is genuinely missing, the error message includes a copy-pasteable install command.

## Verification Diagnostic Hints

Failed attempts now carry a `diagnosticHint` that gets injected into the next attempt's prompt:

- "command not found" → names the missing tool and its install command
- "cannot find module" → identifies the unresolved package or relative path
- Assertion failures → counts them so the agent knows the severity
- Timeouts → flags possible infinite loops or unresolved async

This replaces the previous generic "Verification did not pass" message.

## Other Changes

- Git operations retry once after 500ms for lock-file contention
- `git restore` falls back to `git checkout` on failure
- Invalid `--profile` warns and defaults to `minimal` instead of crashing
- Invalid `--run-scan-limit` clamps to 50 instead of exiting

## Upgrade

```sh
npm install -g martin-loop@0.3.8
```

## Quick Check

```sh
martin-loop --version    # should print 0.3.8
martin-loop doctor       # should auto-discover engines
```
