# MartinLoop Arcade — Space Invaders

A terminal Space Invaders game that runs in the foreground while a governed
agent run executes in the background. The game resolves with the same value
the background task resolves with, so callers require no structural changes
to handle the result.

Zero external dependencies. Node 18+. Pure ANSI escape codes.

## Current product contract

Arcade is part of MartinLoop's interactive terminal presentation, not its governance authority.

- the governed coding-agent run starts independently of Arcade
- Arcade input cannot change the agent, budget, verifier, policy decision, final outcome, or receipt evidence
- quitting Arcade returns to the CLI while governed work continues according to the run contract
- game completion cannot mark a coding task complete
- JSON, quiet, CI, non-TTY, reduced-motion, unsuitable-terminal, and `NO_COLOR` paths must not receive Arcade presentation output that contaminates machine-readable evidence
- terminal state, cursor visibility, and input mode must be restored after Arcade exits

The intended user experience is simple: the coding agent works, MartinLoop keeps the run bounded, and the user can play while waiting without weakening the run contract.

For the full agent-facing product model see [`../../../../llms-full.txt`](../../../../llms-full.txt) and [`../../../../docs/for-agents.md`](../../../../docs/for-agents.md).

---

## Theming

Arcade uses terminal color to make run-state presentation legible while keeping color out of governed evidence and machine-readable output.

| Element | Sprite | What it represents |
|---|---|---|
| Player | `<[∞]>` | Martin — the governance engine |
| Row 0 | `[-^-]` / `[^_^]` | Token Spenders (30 pts) |
| Row 1 | `<o_o>` / `<O_O>` | CPU Hogs (20 pts) |
| Row 2 | `{x_x}` / `{X_X}` | API Callers (15 pts) |
| Row 3 | `/vvv\` / `\vvv/` | Budget Drains (10 pts) |
| UFO | `«$RUN»` | Runaway Agent (150 pts) |
| Score | `BUDGET PROTECTED: $N` | — |

Wave progression: enemies speed up as the wave depletes. Every cleared wave
increments the level — faster movement, faster fire rate, spread shot at
level 4, faster cooldown at level 5.

---

## Controls

| Key | Action |
|---|---|
| `← →` or `A D` | Move |
| `Space` / `↑` / `Z` | Fire |
| `P` | Pause / unpause |
| `R` | Restart (game over screen only) |
| `Q` | Quit and return to CLI |
| `Ctrl+C` | Hard exit (restores terminal first) |

---

## Wiring into `packages/cli/src/index.ts`

The implementation is integrated into the CLI. The example below documents the boundary that must remain true if the integration is refactored.

### 1. Import

```typescript
import { playWhileWaiting } from "./arcade/index.js";
```

### 2. Replace the blocking `await` on the governed run

Find the line where you `await` the long-running governed run and wrap it:

```typescript
// Before
const result = await governedRun(request);

// After — show the game while the run is in flight.
// Falls through automatically in CI, non-TTY, or small terminals.
const result = await playWhileWaiting(governedRun(request), {
  runResultLabel: buildArcadeRunLabel(runSummary),
});
```

The `runResultLabel` string appears in the run-complete overlay inside the
game. Use the same value-line copy from the Loop Experience v5 spec:

```typescript
function buildArcadeRunLabel(summary: RunSummary): string {
  if (summary.savingsConfidence === "confirmed" && summary.savedThisRun > 0) {
    return `confirmed saved $${summary.savedThisRun.toFixed(2)} · $${summary.lifetimeSaved.toFixed(2)} lifetime`;
  }
  if (summary.savingsConfidence === "estimated" && summary.savedThisRun > 0) {
    return `estimated saved ~$${summary.savedThisRun.toFixed(2)} this run`;
  }
  return `${summary.successfulRunCount} governed runs completed`;
}
```

### 3. Trigger condition (recommended)

Only show the arcade when the run is expected to take meaningful time.
A 2-second run doesn't need a game.

```typescript
// Simple: always show when interactive (function guards itself)
const result = await playWhileWaiting(governedRun(request), opts);

// Selective: only show when expected duration exceeds threshold
const showArcade = estimatedDurationMs > 8_000;
const result = showArcade
  ? await playWhileWaiting(governedRun(request), opts)
  : await governedRun(request);
```

`playWhileWaiting` guards against CI, non-TTY, and terminal size < 50×18
automatically — so even if you always call it, it falls through silently
in unsuitable environments.

---

## Files

```
packages/cli/src/arcade/
  index.ts            — public API re-export
  space-invaders.ts   — complete game engine (zero deps)
  README.md           — this file
```

No changes required to `package.json`, `tsconfig.json`, or `pnpm-lock.yaml`.
The game uses only `node:readline` from the Node.js standard library.

---

## What NOT to add

- No color library (`chalk`, `kleur`, etc.) — palette uses raw ANSI RGB codes
- No terminal library (`blessed`, `ink`, etc.) — frame buffer is bespoke
- No `process.exit()` calls except the hard Ctrl+C path — game resolves the
  outer promise cleanly so the caller's cleanup logic still runs
- No persistence — arcade score is session-only, intentionally ephemeral
