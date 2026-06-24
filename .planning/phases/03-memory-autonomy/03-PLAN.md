---
phase: 3
name: Memory, Autonomy, and Pre Work Burn Reduction
slug: memory-autonomy
status: planned
wave_count: 3
plans_total: 5
depends_on: [1, 2]
files_modified:
  - packages/core/src/persistence/trace-store.ts
  - packages/core/src/persistence/memory-store.ts
  - packages/core/src/routing.ts
  - packages/core/src/index.ts
  - packages/cli/src/index.ts
  - packages/mcp/src/resources.ts
  - packages/mcp/src/prompts.ts
autonomous: true
---

# Phase 3: Memory, Autonomy, and Pre Work Burn Reduction

## Phase Goal

Three tightly coupled improvements that make MartinLoop smarter over time:
1. Drop Pre Work Burn from ~25% by injecting historical route intelligence into every run
2. Build MartinLoop-branded persistent memory that aggregates and never overwrites
3. Autonomously switch models and prompt users proactively — no manual model selection

---

## Plan 1: Pre Work Burn Reduction via Historical Routing

**Wave:** 1

### Objective

Wire the append-only trace store (already built) into `classifyRoute()` so every
estimate and run uses real historical data. Currently `historicalDirectSuccessRate`
is accepted as input but never populated from real data.

### Files to read first

- `packages/core/src/routing.ts` — RouteClassificationInput.historicalDirectSuccessRate
- `packages/core/src/persistence/trace-store.ts` — getHistoricalDirectSuccessRate()
- `packages/cli/src/index.ts` — executeEstimateCommand, executeRunCommand
- `packages/core/src/index.ts` — exports

### Tasks

**Task 1.1 — Wire historical rate into estimate command**

```
In executeEstimateCommand (packages/cli/src/index.ts):
1. Import getHistoricalDirectSuccessRate from @martin/core
2. Call: const historicalRate = await getHistoricalDirectSuccessRate(runsRoot)
3. Pass to classifyRoute: { ...existingInput, historicalDirectSuccessRate: historicalRate }
```

`<read_first>` packages/cli/src/index.ts, packages/core/src/persistence/trace-store.ts
`<acceptance_criteria>` npx martin-loop estimate "Fix typo" --json shows historicalDirectSuccessRate in output when trace data exists

**Task 1.2 — Append trace entry after every governed run**

```
In runMartin (packages/core/src/index.ts), after loop completes:
1. Import appendTraceEntry from ./persistence/trace-store.js
2. Build TraceEntry from the completed loop record
3. appendTraceEntry(runsRoot, entry) — fire and forget (.catch(() => {}))
```

`<read_first>` packages/core/src/index.ts (runMartin function, ~line 487), packages/core/src/persistence/trace-store.ts (TraceEntry interface)
`<acceptance_criteria>` After running `martin run --proof --verify "pnpm test"`, `_martin/trace-log.jsonl` file exists and contains a valid JSON line with loopId, selectedRoute, actualCostUsd, verificationPassed

**Task 1.3 — Add trace aggregation to martin gate output**

```
In executeGateCommand: additionally show trace summary stats when governance passes
- totalRuns, directSuccessRate, averageCostUsd from aggregateTraces()
```

`<read_first>` packages/cli/src/index.ts (executeGateCommand, ~line 2660)
`<acceptance_criteria>` `martin gate` output includes "Trace: N runs, X% direct success" when trace data exists

### Verification

```sh
npx martin-loop estimate "Fix typo" --json | grep "historicalDirectSuccessRate"
cat "$HOME/.martin/runs/_martin/trace-log.jsonl" | wc -l  # > 0 after any run
```

---

## Plan 2: MartinLoop-Branded Persistent Memory Store

**Wave:** 1

### Objective

Build an append-only, never-overwriting memory store under MartinLoop's own
branding. Not GSD, not mempalace, not openwolf — MartinLoop Memory. It aggregates
user preferences, consent signals, and behavioral patterns over time to make the
product smarter with every interaction.

### Files to read first

- `packages/core/src/persistence/trace-store.ts` — pattern to follow for JSONL append
- `packages/core/src/index.ts` — existing exports

### New file: packages/core/src/persistence/memory-store.ts

```typescript
/**
 * MartinLoop Memory Store
 *
 * Append-only, never-overwriting memory that aggregates over time.
 * Records user consent signals, preferences, behavioral patterns,
 * and learning outcomes so Martin gets smarter with every session.
 *
 * Storage: <runsRoot>/_martin/memory.jsonl
 */

export type MemoryKind =
  | "consent"        // User approved or denied a governance action
  | "preference"     // User expressed a preference
  | "pattern"        // Observed behavioral pattern
  | "feedback"       // Explicit user feedback on a run outcome
  | "budget"         // Budget preference for a task category
  | "model";         // Model preference for a task type

export interface MemoryEntry {
  timestamp: string;
  kind: MemoryKind;
  key: string;       // e.g. "model.direct.claude", "budget.auth.usd"
  value: unknown;    // the memory payload
  source: "explicit" | "inferred";  // did user say it or did Martin observe it?
  confidence: number; // 0-1
}

// appendMemory(), readMemoryEntries(), getPreference(), buildMemorySummary()
```

### Tasks

**Task 2.1 — Implement memory-store.ts**

Create `packages/core/src/persistence/memory-store.ts` with:
- `appendMemory(runsRoot, entry)` — JSONL append, never overwrites
- `readMemoryEntries(runsRoot)` — reads all entries
- `getPreference(runsRoot, key)` — returns most recent entry for a key
- `buildMemorySummary(entries)` — returns top 20 most recent entries per kind

`<acceptance_criteria>` File exists at packages/core/src/persistence/memory-store.ts; appendMemory writes JSONL; readMemoryEntries returns same entries; getPreference returns latest match

**Task 2.2 — Export from core index**

Add exports to packages/core/src/index.ts under "// ─── Memory Store"

`<acceptance_criteria>` `import { appendMemory, getPreference } from 'martin-loop/core'` resolves without error after build

**Task 2.3 — Add martin://agent/memory-summary MCP resource**

In packages/mcp/src/resources.ts:
- Add URI: `martin://agent/memory-summary`
- Returns top preferences, recent consents, budget patterns
- Agents read this at session start to personalize behavior

`<acceptance_criteria>` MCP server lists martin://agent/memory-summary resource; reading it returns JSON with entries array

---

## Plan 3: Autonomous Model Switching

**Wave:** 2 (depends on Plan 1)

### Objective

MartinLoop automatically selects the right model for each run based on the route
decision. No more asking the user to pick a model. The `resolveModelForTier()`
function (already built) feeds into the adapter selection automatically.

### Files to read first

- `packages/core/src/routing.ts` — resolveModelForTier()
- `packages/adapters/src/claude-cli.ts` — createClaudeCliAdapter options
- `packages/core/src/index.ts` — runMartin, selectRecommendedEngine

### Tasks

**Task 3.1 — Auto-select model in runMartin based on route**

```
In packages/core/src/index.ts (runMartin):
1. classifyRoute() on the task before selecting adapter
2. const suggestedModel = resolveModelForTier(route.recommendedModelTier, input.engine ?? 'claude')
3. If no model was explicitly passed, use suggestedModel
4. Log: "MartinLoop auto-selected ${suggestedModel} (${route.recommendedModelTier} tier, ${route.confidence*100}% confidence)"
```

`<read_first>` packages/core/src/index.ts (~line 487), packages/core/src/routing.ts (resolveModelForTier)
`<acceptance_criteria>` Running a simple task without --model flag uses haiku-tier model; log line shows "MartinLoop auto-selected"

**Task 3.2 — Show auto-selection in martin run output**

```
In executeCli run command output: add "Model: auto-selected ${model} (${tier} tier)"
```

`<acceptance_criteria>` `martin run "Fix typo" --proof --verify "echo pass" --json` output contains autoSelectedModel field

**Task 3.3 — Respect user override via --model flag**

```
If --model is explicitly provided, skip auto-selection and log:
"Using explicitly requested model: ${model} (auto-selection bypassed)"
```

`<acceptance_criteria>` `--model claude-opus-4-6` on a simple task uses opus, not haiku

---

## Plan 4: Proactive User Prompting and Consent Learning

**Wave:** 2 (depends on Plan 2)

### Objective

Martin asks users for consent and learns from their responses. Consent signals
are stored in the memory store and used to personalize future interactions.
No annoying repeated questions — once a user says "always use sonnet for auth work",
Martin remembers that.

### Files to read first

- `packages/core/src/persistence/memory-store.ts` (Plan 2)
- `packages/cli/src/index.ts` — start command, gate command
- `packages/mcp/src/prompts.ts` — kickoff prompt

### Tasks

**Task 4.1 — Add consent prompting to martin start**

```
In executeStartCommand, after detecting IDE:
1. Check memory for existing preferences (getPreference(runsRoot, 'budget.default'))
2. If no budget preference stored, output:
   "What's your default budget per governed run? ($ USD, press Enter for $5)"
3. Store response: appendMemory(runsRoot, { kind: 'preference', key: 'budget.default', ... })
```

`<acceptance_criteria>` On first run, `martin start` prompts for budget; on second run, skips prompt and shows stored preference

**Task 4.2 — Inject memory summary into MCP kickoff prompt**

```
In buildKickoffPrompt (packages/mcp/src/prompts.ts):
1. Read martin://agent/memory-summary resource
2. If non-empty, prepend to system message:
   "User preferences from MartinLoop Memory: {preferences}"
3. Agent uses these to personalize recommendations
```

`<acceptance_criteria>` After storing a preference, the martin_start MCP prompt includes it in the assistant message

**Task 4.3 — Record consent signals from gate command**

```
When martin gate returns BLOCKED and user runs missing steps anyway (detected via
trace store — next run proceeds without gate passing):
1. appendMemory(runsRoot, { kind: 'feedback', key: 'gate.bypassed', value: { step, objective } })
2. Pattern: if bypassed 3+ times, add recommendation to martin start output
```

`<acceptance_criteria>` After 3 gate bypasses, `martin start` output includes "You often skip governance — consider running martin gate in your hooks"

---

## Plan 5: Pre Work Burn Tests + Memory Tests

**Wave:** 3 (depends on Plans 1-4)

### Objective

Real, audit-ready tests for all new functionality. No mocks. No stubs.
Every test exercises real code paths with real assertions.

### Files to create

- `packages/core/tests/memory-store.test.ts`
- `packages/cli/tests/model-auto-selection.test.ts`
- Update `packages/cli/tests/release-hardening.test.ts`

### Tasks

**Task 5.1 — Memory store tests (8 tests)**

Test: appendMemory creates file; multiple appends don't overwrite; readMemoryEntries returns all; getPreference returns latest match; buildMemorySummary groups by kind.

`<acceptance_criteria>` `pnpm --filter @martin/core test` passes with 8 new memory-store tests

**Task 5.2 — Model auto-selection tests (5 tests)**

Test: simple task → haiku tier; complex security task → opus tier; explicit --model bypasses auto-selection; resolveModelForTier returns correct model per engine.

`<acceptance_criteria>` `pnpm --filter @martin/cli test` passes with 5 new model auto-selection tests

**Task 5.3 — Trace wiring smoke test**

After estimate with real runsRoot, verify historicalDirectSuccessRate is populated from trace data.

`<acceptance_criteria>` Test writes 5 trace entries, runs estimate, confirms historicalDirectSuccessRate matches expected rate

---

## Verification (full phase)

```sh
# Build clean
pnpm build

# All tests pass
pnpm test

# Trace wiring
npx martin-loop estimate "Fix a typo" --json | grep historicalDirectSuccessRate

# Auto model selection
npx martin-loop estimate "Fix a typo" --engine claude --json | grep -E "recommendedModelTier|haiku"

# Memory store created after gate/start
npx martin-loop start 2>/dev/null
ls ~/.martin/runs/_martin/memory.jsonl

# MCP resource available
npx martin-loop estimate "Migrate auth database" --json | grep "opus"
```

## must_haves (goal-backward verification)

- [ ] Pre Work Burn decreases measurably when historicalDirectSuccessRate is wired (simple tasks route to haiku 90%+ of the time)
- [ ] `_martin/memory.jsonl` grows with each session, never truncated or overwritten
- [ ] `martin estimate` auto-populates historicalDirectSuccessRate from real trace data
- [ ] Governed Claude runs use haiku for simple tasks without user specifying --model
- [ ] MCP `martin://agent/memory-summary` resource returns real data
- [ ] All new tests pass with real assertions, no stubs

---
*Phase planned: 2026-06-24*
*Estimated cost: $3.50 (direct route, haiku tier)*
