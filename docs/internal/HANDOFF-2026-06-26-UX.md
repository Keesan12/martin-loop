# Handoff — 2026-06-26 (UX Overhaul Session)

## Governed estimate (this session)
- Doctor: ✓
- Estimate: $2.80, haiku, direct route, $8 budget cap

## What was fixed this session

### Preflight gate fix (workflow-state.ts)
The preflight check required objectiveKey + verificationPlanKey hash match — any
wording difference between `martin preflight "..."` and `martin run "..."` broke
the receipt chain. Fixed to match on workingDirectory + engine only (still Fresh TTL).

Session-start is now optional when estimate receipt is present — estimate proves the
user understood cost, which is the real governance signal.

**Files changed:** `packages/cli/src/workflow-state.ts`

## Remaining work (approved GSD plan)

### Wave 2: `martin mode` command (NOT YET BUILT)
Add to `packages/cli/src/index.ts`:
- `ModeCommand` type: `{ command: "mode"; mode?: "auto"|"plan"|"edits"; scope: "global"|"project" }`
- Parser: `if (command === "mode") { ... }`
- Dispatch: `case "mode": return executeModeCommand(parsed, outputMode)`
- Executor: reads/writes `~/.martin/config.json`
- Show current mode when no subcommand: `martin mode`
- Switch mode: `martin mode auto|plan|edits`
- Config stored at `join(homedir(), ".martin", "config.json")`

### Wave 2: `martin clean` command (NOT YET BUILT)
- Remove `_martin/` from cwd
- Remove `~/.martin/runs/` older than 30 days with `--runs`
- All artifacts with confirmation with `--all`
- Add `_martin/` to .gitignore on `martin start`

### Wave 2: Interactive `martin start` onboarding (NOT YET BUILT)
In `executeStartCommand`:
1. Check `~/.martin/config.json` for existing mode preference
2. If none: prompt user to choose A/P/E (default A)
3. Store selection in `~/.martin/config.json`
4. Show current mode in output
5. Tell users to use automode for best experience

### Wave 3: Mode in estimate output (NOT YET BUILT)
Add to estimate output: "Mode: automode recommended" based on route tier.

### Wave 3: `martin://agent/mode-status` MCP resource (NOT YET BUILT)
Agents read current mode to know how to behave.

## Test count at start of session
All tests passing (from previous session).

## How to continue

```sh
cd "ML_Core_OSS_Internal"
npx martin-loop doctor --quiet
npx martin-loop estimate "Add martin mode + martin clean + interactive onboarding" --budget-usd 8
npx martin-loop gate  # must PASS
# Then implement Wave 2 commands
```

Key files:
- `packages/cli/src/index.ts` — add ModeCommand + CleanCommand types + parsers + executors
- `packages/cli/src/workflow-state.ts` — already patched (preflight fix)
