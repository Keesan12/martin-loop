# Post-Pack Integration Plan Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Safely resume Martin Loop hardening after the other engineer's in-flight pack lands, without overlapping their active runtime work or losing proof.

**Architecture:** Treat the incoming pack as the temporary source of truth for the currently active runtime-core surfaces, reconcile it against the working repo with artifact-first verification, then resume on the first unclaimed hardening block. This plan is intentionally overlap-avoidant: it front-loads ownership checks, diff review, and proof-based verification before any new feature work resumes.

**Tech Stack:** Git, PowerShell, pnpm workspaces, TypeScript, Vitest, GSD planning docs

---

## Current No-Overlap Boundary

Observed in the working tree on 2026-04-03, the active in-flight files are:

- `packages/contracts/src/index.ts`
- `packages/core/src/compiler.ts`
- `packages/core/src/leash.ts`
- `packages/core/src/policy.ts`
- `packages/core/tests/leash.test.ts`
- `.planning/STATE.md`

These surfaces are currently hot and should be treated as owned by the other engineer until their pack is delivered.

Safe surfaces to own in parallel before their pack lands:

- `docs/plans/**`
- `docs/handoffs/**`
- release matrices and certification docs that do not mutate runtime behavior
- post-pack reconciliation notes and verification checklists

### Task 1: Freeze The Incoming Pack And Capture Ownership

**Files:**
- Create: `docs/handoffs/2026-04-03-incoming-pack-reconciliation.md`
- Modify: `docs/plans/2026-04-03-post-pack-integration-plan.md`

- [ ] **Step 1: Extract the incoming pack to an isolated review directory**

Run:

```powershell
New-Item -ItemType Directory -Force "output\incoming-pack-review" | Out-Null
Expand-Archive -LiteralPath "C:\path\to\incoming-pack.zip" -DestinationPath "output\incoming-pack-review" -Force
```

Expected: the pack is available for side-by-side inspection without touching tracked source files.

- [ ] **Step 2: Capture the incoming file inventory and overlap list**

Run:

```powershell
Get-ChildItem -Recurse "output\incoming-pack-review" | Select-Object FullName | Out-File "output\incoming-pack-review\file-list.txt"
git status --short | Out-File "output\incoming-pack-review\working-tree-status.txt"
```

Expected: two inventories exist, one for the incoming pack and one for the active working tree.

- [ ] **Step 3: Write the ownership memo before merging anything**

Write `docs/handoffs/2026-04-03-incoming-pack-reconciliation.md` with:

```markdown
# Incoming Pack Reconciliation

## Incoming Pack
- Source zip:
- Extracted review path:

## Overlapping Files
- packages/contracts/src/index.ts
- packages/core/src/compiler.ts
- packages/core/src/leash.ts
- packages/core/src/policy.ts
- packages/core/tests/leash.test.ts
- .planning/STATE.md

## Ownership Rule
- Incoming pack owns overlapping runtime-core files.
- Non-overlapping docs and handoff assets may be preserved locally.
- No new runtime work starts until targeted verification passes.
```

- [ ] **Step 4: Commit the reconciliation note only if asked**

Run:

```bash
git add docs/handoffs/2026-04-03-incoming-pack-reconciliation.md
git commit -m "docs: add incoming pack reconciliation note"
```

Expected: only documentation is committed, never speculative runtime merges.

### Task 2: Reconcile The Overlapping Runtime Surfaces

**Files:**
- Modify: `packages/contracts/src/index.ts`
- Modify: `packages/core/src/compiler.ts`
- Modify: `packages/core/src/leash.ts`
- Modify: `packages/core/src/policy.ts`
- Modify: `packages/core/tests/leash.test.ts`
- Modify: `.planning/STATE.md`
- Read: `.planning/phases/08-grounding-integrity/08-01-PLAN.md`
- Read: `.planning/phases/08-grounding-integrity/08-02-PLAN.md`
- Read: `.planning/phases/08-grounding-integrity/08-VERIFICATION.md`

- [ ] **Step 1: Compare incoming overlapping files against the live repo**

Run:

```powershell
git diff -- packages/contracts/src/index.ts packages/core/src/compiler.ts packages/core/src/leash.ts packages/core/src/policy.ts packages/core/tests/leash.test.ts .planning/STATE.md
```

Expected: a precise before/after view of the currently hot files.

- [ ] **Step 2: Prefer the incoming pack for overlapping hunks unless local proof is newer**

Use this rule:

```text
If the incoming pack changes an overlapping runtime hunk and the live repo has no stronger passing proof tied to that hunk, take the incoming version.
If the live repo has stronger passing proof, preserve the proven local behavior and document why.
```

- [ ] **Step 3: Re-run the targeted core verification immediately after reconciliation**

Run:

```powershell
pnpm --filter @martin/core exec tsc --noEmit
pnpm --filter @martin/core test
```

Expected: the reconciled runtime-core surfaces typecheck and the core suite passes.

- [ ] **Step 4: Write the reconciliation result into the note**

Append to `docs/handoffs/2026-04-03-incoming-pack-reconciliation.md`:

```markdown
## Reconciliation Result
- Merged files:
- Preserved local files:
- Conflicts resolved:
- Targeted verification:
  - pnpm --filter @martin/core exec tsc --noEmit
  - pnpm --filter @martin/core test
```

### Task 3: Recompute Phase Ownership After The Pack Lands

**Files:**
- Create: `docs/handoffs/2026-04-03-post-pack-status.md`
- Modify: `.planning/STATE.md`
- Modify: `.planning/ROADMAP.md`

- [ ] **Step 1: Decide whether Phase 8 is fully closed in code, not just in prose**

Use this checklist:

```text
- grounding challenge cases 1-5 pass
- grounding verdicts are persisted
- changed-file truth is persisted
- anatomy artifact persistence still passes
- grounding.violations_found is present in the loop path
```

Expected: Phase 8 is marked complete only if all five conditions are true in tests and artifacts.

- [ ] **Step 2: Decide whether the incoming pack has already started or completed Phase 9**

Use this checklist:

```text
- trust profile schema exists
- command/filesystem/secret/spend policies are explicit
- violation artifacts persist
- trust profiles have tests
- trusted mode has deterministic technical behavior
```

Expected: Phase 9 is marked `not started`, `partial`, or `active` from code and tests, not from summary text.

- [ ] **Step 3: Write the status memo**

Write `docs/handoffs/2026-04-03-post-pack-status.md` with:

```markdown
# Post-Pack Status

## Phase 8
- Status:
- Evidence:

## Phase 9
- Status:
- Evidence:

## First Safe Next Block
- Owner:
- Scope:
- Files:
```

- [ ] **Step 4: Update planning state only after status is proven**

Run:

```text
Update .planning/STATE.md and .planning/ROADMAP.md to reflect the proven phase state after reconciliation.
```

Expected: planning docs match verified repo reality.

### Task 4: Resume On The First Unclaimed Hardening Block

**Files:**
- Create: `docs/plans/2026-04-03-next-execution-block.md`
- Modify: `docs/handoffs/2026-04-02-fresh-engineer-handoff/NEXT-HARDENING.md`

- [ ] **Step 1: Choose the next block using the post-pack decision tree**

Use this decision tree:

```text
If Phase 9 is not complete, execute the remaining Leash v2 work.
Else if Phase 10 is untouched, plan Patch Truth and rollback truth next.
Else if Phase 11 is the first incomplete block, plan Read-Model Truth completion next.
```

- [ ] **Step 2: Write the next execution block plan**

Write `docs/plans/2026-04-03-next-execution-block.md` with:

```markdown
# Next Execution Block

## Selected Block
- Phase:
- Why this is next:

## File Ownership
- Safe to touch:
- Do not touch:

## Verification Gate
- Required tests:
- Required artifacts:
```

- [ ] **Step 3: Refresh the fresh-engineer handoff**

Update `docs/handoffs/2026-04-02-fresh-engineer-handoff/NEXT-HARDENING.md` so the "recommended order" section reflects the actual post-pack state, not the pre-pack assumption.

- [ ] **Step 4: Commit only once the plan and handoff agree**

Run:

```bash
git add docs/plans/2026-04-03-next-execution-block.md docs/handoffs/2026-04-02-fresh-engineer-handoff/NEXT-HARDENING.md docs/handoffs/2026-04-03-post-pack-status.md
git commit -m "docs: record post-pack hardening ownership and next block"
```

Expected: planning artifacts are synchronized before implementation restarts.

### Task 5: Repackage The Fresh-Engineer Handoff After Reconciliation

**Files:**
- Modify: `docs/handoffs/2026-04-02-fresh-engineer-handoff/SUMMARY.md`
- Modify: `docs/handoffs/2026-04-02-fresh-engineer-handoff/CURRENT-STATE.md`
- Modify: `docs/handoffs/2026-04-02-fresh-engineer-handoff/VERIFICATION.md`
- Create: `output/martin-loop-complete-handoff-v9-post-pack.zip`

- [ ] **Step 1: Update the handoff summary files with the reconciled truth**

Each file must include:

```text
- what landed from the other engineer's pack
- what remains incomplete
- what block is next
- what verification passed after reconciliation
```

- [ ] **Step 2: Build the updated handoff zip**

Run:

```powershell
Compress-Archive -Path "docs\handoffs\2026-04-02-fresh-engineer-handoff" -DestinationPath "output\martin-loop-complete-handoff-v9-post-pack.zip" -Force
```

Expected: a new shareable handoff zip exists for the next engineer.

- [ ] **Step 3: Record the artifact path in the reconciliation note**

Append to `docs/handoffs/2026-04-03-incoming-pack-reconciliation.md`:

```markdown
## Repackaged Handoff
- Zip artifact: output/martin-loop-complete-handoff-v9-post-pack.zip
```

## Verification

After the incoming pack lands and reconciliation is complete, the minimum verification set is:

```powershell
pnpm --filter @martin/core exec tsc --noEmit
pnpm --filter @martin/core test
```

If the pack touches control-plane, benchmarks, or read-model surfaces, also run:

```powershell
pnpm --filter @martin/control-plane test
pnpm --filter @martin/benchmarks test
pnpm --filter @martin/benchmarks eval:phase7
```

## Success Criteria

- No overlapping runtime-core edits are made while the other engineer still owns the pack
- The incoming pack is reconciled with explicit ownership notes
- Phase 8 and Phase 9 status are determined from code and passing checks, not summaries
- The next execution block is chosen from the first incomplete hardening phase
- A refreshed handoff zip exists after reconciliation
