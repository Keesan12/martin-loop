# Incident Report — MartinLoop CLI v0.3.16

**Status:** Resolved
**Severity:** High (both issues)
**Component:** `packages/cli`

## Summary

Two independent, high-severity defects were found in the CLI's `run` command
during live testing. Both are now fixed and verified end-to-end against real
`martin-loop run` invocations (real verifier runs, real `~/.martin/milestone-state.json` state).

1. Genuinely successful, verifier-passed runs were reported to the operator
   as failures, and were miscounted as failures in lifetime usage stats.
2. The CLI's interactive feedback/waitlist prompts printed their questions
   but never actually captured the operator's typed answer, regardless of
   terminal type.

Neither defect crashed the CLI or corrupted repo state — both are
misreporting/data-loss issues rather than availability issues. No user data
beyond feedback-prompt responses (score, free-text note, optional email) was
affected.

---

## Issue 1 — Successful runs reported as failures

**Impact:** An operator running `martin-loop run` with a genuinely correct
fix — verifier passed, receipt signed and persisted — would see:

```
✗ run failed · 1 attempt
    that one got away. no receipts this time.
```

This is a directly false statement: `martin-loop dossier --latest` for the
same run shows `Verification: passed` and a signed, integrity-verified
receipt. The failure message actively contradicts the tool's own audit
trail one command later.

Beyond the display bug, the same flawed check fed `recordRunAndGetPrompt`'s
`success` field, so these runs were also recorded as failures in
`~/.martin/milestone-state.json` (`failedRunCount` incremented,
`successfulRunCount` did not) — corrupting lifetime loop counts, rank
progression, savings tracking, and the repo's own "run history risk" scoring.

**Root cause:** a run that completes via the compressed "direct worker"
route (no `manager`/`consensus` steps) transitions to policy phase `HANDOFF`
on successful verification (`packages/core/src/policy.ts:113-115`). `HANDOFF`
is mapped to lifecycle state `"human_escalation"` (`policy.ts:93-95`) — the
same state used for genuine escalation failures. The CLI's success check
required `lifecycleState === "completed"` exactly, so `human_escalation` was
always treated as failure, regardless of whether verification had passed.

**Fix:**
- `packages/cli/src/ux.ts` — `renderRunHeader` now takes a three-way
  `RunOutcome` (`"success" | "awaiting_signoff" | "failure"`) instead of a
  boolean, with distinct copy for the middle case: `✓ verified — awaiting
  sign-off` plus an explanatory line.
- `packages/cli/src/index.ts` — the `run` command now computes outcome using
  `buildVerificationSummary(result.loop).status === "passed"` combined with
  the lifecycle state, rather than requiring the literal `"completed"` state.

**Verification:** re-ran the same class of scenario (a real, verifier-passed
fix on the `direct/compressed` route, twice, against two different seeded
bugs) post-fix. Header correctly showed `✓ verified — awaiting sign-off` both
times; `successfulRunCount` incremented correctly without `failedRunCount` moving.

---

## Issue 2 — Feedback/waitlist prompt answers silently discarded

**Impact:** The CLI's post-run prompt (0–5 score, optional feature request,
optional pilot-access email) appeared to work — questions printed, keystrokes
echoed — but no answer was ever actually recorded or transmitted.

**Root cause 1:** `packages/cli/src/index.ts` called
`void renderMilestonePrompt(...)` — fire-and-forget, never awaited — then
returned immediately. The process could exit mid-prompt before the user's
keystroke was ever read.

**Root cause 2 (found after fixing #1):** `readLine()` in `ux.ts` created a
new `readline.Interface` for every individual question. Each fresh interface
raced its own `"line"` event (the real answer) against its own `"close"`
event — `"close"` consistently won, resolving to `""` as if the user had
pressed Enter to skip.

**Fix:**
- `packages/cli/src/index.ts` — changed `void renderMilestonePrompt(...)` to
  `await renderMilestonePrompt(...)`.
- `packages/cli/src/ux.ts` — replaced per-question `readLine()` with
  `createLineReader()`: one shared `readline.Interface` created once per
  prompt interaction and reused across all sequential questions, closed only
  once the whole interaction completes.
- Added `packages/cli/tests/ux-milestone-prompt.test.ts` (3 tests): single-
  question capture, a full 3-question follow-up flow asserting only one
  `readline.createInterface` call happens across all three questions, and the
  score ≤ 2 single-follow-up path. All pass.

**Verification:** re-ran live, post-fix, in a real terminal. Typed score and
email were both correctly persisted in `~/.martin/milestone-state.json` —
the first successful capture across the entire testing session.

---

## Known, confirmed-as-intentional (not a defect)

The feedback/waitlist prompt never appears when `martin-loop` is invoked
through a non-interactive tool execution context (CI, piped, Bash tool).
`process.stdout.isTTY` is `false` in that context and `ux.ts` explicitly
skips the prompt. This is correct, deliberate behavior.

---

## Testing

- Full CLI package test suite: **276/276 passing** (273 pre-existing + 3 new),
  0 regressions, across both fixes.
- `pnpm build` clean, no type errors.
- Both fixes verified against real, live `martin-loop run` invocations.

## Files changed

- `packages/cli/src/index.ts`
- `packages/cli/src/ux.ts`
- `packages/cli/tests/ux-milestone-prompt.test.ts` (new)
