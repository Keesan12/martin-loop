# MartinLoop CLI — Audit Findings

Found via live testing of `martin-loop` v0.3.16 against a seeded test project
with deliberately introduced, verifiable bugs. Two distinct, reproducible
defects were confirmed. **Both have since been fixed and verified live** — see
the "Fix applied" note at the end of each section.

---

## 1. Successful, verified runs are mislabeled as failures

**Status: FIXED and live-verified.**

**Severity:** High — misleads the operator about whether their fix actually
worked, and corrupts lifetime usage stats.

### What's happening

A run that genuinely succeeds — the objective is correctly completed and the
verifier (e.g. `npm test`) passes — can still exit via the `HANDOFF` policy
phase when the run took the compressed "direct worker" route (i.e. `manager`
and `consensus` steps were skipped, as shown by `estimate`'s `Blocked steps:
manager, consensus`). `HANDOFF` is mapped to the lifecycle state
`"human_escalation"` — the same state used for genuine escalations/failures.

The CLI's success check treats anything that isn't exactly
`lifecycleState === "completed"` as a failure. So a `HANDOFF` result renders:

```
✗ run failed · 1 attempt
  that one got away. no receipts this time.
```

— even though `martin-loop dossier --latest` for that same run shows
`Verification: passed`, a correct fix description, and a signed,
integrity-verified receipt. The failure banner is directly contradicted by
the dossier one command later.

**Secondary effect:** because the CLI's `success` boolean feeds directly into
`recordRunAndGetPrompt`, these successful runs are also recorded as **failed**
in `~/.martin/milestone-state.json` (`failedRunCount` increments,
`successfulRunCount` does not) — so lifetime loop counts, rank progression,
and savings tracking are all corrupted by the same bug.

### Where it's located

- `packages/core/src/policy.ts:113-115` — successful verification transitions
  to `HANDOFF`:
  ```ts
  if (result.status === "completed" && result.verification.passed) {
    return "HANDOFF";
  }
  ```
- `packages/core/src/policy.ts:93-95` — `HANDOFF` (and `ESCALATE`) both map to
  lifecycle state `"human_escalation"`:
  ```ts
  case "ESCALATE":
  case "HANDOFF":
    return "human_escalation";
  ```
- `packages/cli/src/index.ts:1259` — the run-header success flag:
  ```ts
  result.loop.status === "completed" && result.loop.lifecycleState === "completed"
  ```
- `packages/cli/src/index.ts:1268` — the same flawed check, feeding
  `recordRunAndGetPrompt`'s `success` field (corrupts milestone stats too).

### Fix applied

- `ux.ts`: `renderRunHeader` now takes a three-way `RunOutcome` ("success" |
  "awaiting_signoff" | "failure") instead of a boolean, with its own copy for
  the middle case ("✓ verified — awaiting sign-off").
- `index.ts` (`run` command): computes `runOutcome` using
  `buildVerificationSummary(result.loop).status === "passed"` combined with
  `lifecycleState === "human_escalation"`, and feeds the resulting
  success/failure boolean into both the header and `recordRunAndGetPrompt`'s
  `success` field.
- Verified live end-to-end: re-ran the same scenario and confirmed both the
  corrected header text and that `successfulRunCount` incremented correctly.
- Full CLI test suite passes: 274/274 (273 pre-existing + 0 regressions).

---

## 2. Interactive feedback/waitlist/star prompts never capture the user's answer

**Status: FIXED and fully live-verified — two layered root causes found and fixed.**

**Severity:** High — the CLI's entire feedback-collection mechanism is
non-functional as built, with no error or indication that it failed.

### What's happening

After a run, the CLI may show an interactive prompt (0-5 feedback score,
feature request, pilot-access email). The prompt's text prints correctly, but
**whatever the user types is never captured or acted on**, because the code
that awaits the keystroke is never actually waited on by the CLI's control flow.

**Two confirmed failure modes:**

- **Non-interactive/piped stdout:** the prompt is skipped entirely by design
  (`isTTY` check) — nothing is printed, nothing is asked.
- **Real terminal (TTY) stdout:** the prompt prints and looks interactive, but
  the user's actual input is discarded. `~/.martin/milestone-state.json` shows
  the input was processed as an empty skip, and the Supabase POST
  (`submitToIntake()`) was never attempted.

### Where it's located

- `packages/cli/src/index.ts` — the prompt is fired without being awaited:
  ```ts
  void renderMilestonePrompt(...)
  ```
- `packages/cli/src/ux.ts:308` — TTY gate:
  ```ts
  if (!prompt || !process.stdout.isTTY) return;
  ```
- `packages/cli/src/ux.ts` (`readLine`) — creates a new `readline.Interface`
  per question; `"close"` event wins the race against `"line"`, silently
  resolving to `""`.
- `packages/cli/src/cli-milestone-state.ts` (`submitToIntake`) — the Supabase
  POST that never gets reached because input is discarded upstream.

### Fix applied

**Layer 1:** `index.ts`: changed `void renderMilestonePrompt(...)` to
`await renderMilestonePrompt(...)`.

**Layer 2:** `ux.ts`: replaced `readLine()` with `createLineReader()` — one
shared `readline.Interface` per prompt interaction, reused across all sequential
questions, closed only when the whole interaction completes.

- Added `packages/cli/tests/ux-milestone-prompt.test.ts` with 3 tests.
- Full CLI test suite: 276/276 passing (0 regressions from either fix).
- Fully live-verified: typed score and email both persisted correctly for the
  first time after the fix.

---

## Notes (not bugs, relevant context found during audit)

- `estimate`'s routing/model-tier selection varies based on objective wording —
  an objective mentioning "credentials" was classified as "Security-sensitive"
  and routed to the `manager`/`sonnet` tier ($3.00 expected cost) rather than
  the `direct`/`haiku` route (~$1.75) used for otherwise-similar objectives.
  Not necessarily wrong, worth knowing when comparing cost estimates across runs.
