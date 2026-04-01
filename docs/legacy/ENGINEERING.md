# Martin Loop — Engineering Reference

Status: production harness in progress. Not yet a CFO dashboard or a claimed "intelligent"
controller. Runtime is real. Control plane is partially real. Claims ahead of implementation
have been called out below.

---

## What is actually real

| Component | Status | Evidence |
|---|---|---|
| Loop orchestration | Real | `packages/core/src/index.ts` — `runMartin()` |
| Claude CLI adapter | Real | `packages/adapters/src/claude-cli.ts` — spawns subprocess |
| Token cost tracking | Real | `--output-format json` → Claude returns real `inputTokens`/`outputTokens` |
| Budget governor (hard limit) | Real | Stops loop when `actualUsd >= maxUsd` or iterations exhausted |
| Model escalation | Real | `withModel()` executed on `change_model` intervention |
| Run persistence | Real | `~/.martin/runs/<workspaceId>.jsonl` written after every run |
| Cost Dashboard | Real (local) | Reads JSONL — real loops only, falls back gracefully when no data |
| Negation-aware classifier | Real | `containsPositive()` prevents "no syntax errors" → `syntax_error` |
| Oscillation detection | Real | `detectOscillation()` catches A→B→A and A→B→A→B in last 4 attempts |
| Preflight budget check | Real | Estimates prompt cost before submitting; bails if > 95% remaining |
| Zero-diff detection | Real | `git diff --name-only HEAD` after attempt; sets `no_progress` class hint |
| Structured error extraction | Real | Parses TypeScript/ESLint/Jest patterns from stderr into `file:line:message` |
| PROGRESS.md checkpoint | Real | Written to repoRoot after each failed attempt; re-anchors next attempt |
| Git state reset | Real | `git restore --staged --worktree .` before next attempt on failure |
| Prompt sanitizer | Real | Strips `[INST]`, `<system>`, `IGNORE/OVERRIDE` injection patterns |
| Task contract (prompt) | Real | `allowedPaths`, `deniedPaths`, `acceptanceCriteria` injected into prompt |

---

## What is still incomplete or not yet real

| Component | Status | Gap |
|---|---|---|
| Task contract (machine check) | Partial | Paths injected into prompt but `git diff --name-only` not yet checked against `allowedPaths` |
| Full verifier stack | Partial | `verificationStack` type defined, not yet wired into `runVerification()` |
| Resume / replay | Not real | `--resume` not implemented in CLI. Dashboard copy only. |
| Multi-tenant control plane | Not real | Billing, governance, economics pages feed from `mock-control-plane-data.ts` |
| Hosted telemetry persistence | Not real | `/api/telemetry` accepts POSTs, echoes back, stores nothing in a real ledger |
| Semantic oscillation detection | Not real | Same failure class different error text not yet detected (Jaccard/hash approach) |
| API-native provider adapters | Not real | All adapters are CLI subprocess wrappers. Token costs estimated, not API-native. |

---

## Canonical runtime path

```
packages/contracts/src/index.ts     ← shared types (source of truth for all packages)
packages/core/src/index.ts          ← THE canonical engine (runMartin, classifyFailure, etc.)
packages/adapters/src/claude-cli.ts ← adapter implementation
packages/cli/src/index.ts           ← CLI entry point
```

There are NO other runtime files. The following files no longer exist (deleted as dead code):
- ~~`packages/core/src/run-martin.ts`~~ — was not imported by any live path
- ~~`packages/core/src/failure-taxonomy.ts`~~ — duplicate classifier, stale
- ~~`packages/core/src/cost-governor.ts`~~ — duplicate, stale
- ~~`packages/core/src/exit-intelligence.ts`~~ — duplicate, stale
- ~~`packages/core/src/context-distillation.ts`~~ — duplicate, stale
- ~~`packages/core/src/types.ts`~~ — types only used by above dead files

If you see an import from any of those file paths, it is an error.

---

## Failure classes

```
syntax_error            compiler/parser/linter failure (structural evidence: exit code + error pattern)
type_error              TypeScript type system violation
test_regression         test suite failure, specific tests known
verification_failure    verification ran but criteria not met (default for unclassified failures)
scope_creep             files outside task contract were touched (git diff evidence)
no_progress             attempt ran but zero files changed (git diff empty)
repo_grounding_failure  referenced symbol/API/file not found in repo
environment_mismatch    runtime/CLI/tool not found (not retryable)
logic_error             none of the above; switch model
budget_pressure         cost/token headroom too tight
hallucination           extremely short response on non-trivial task (weak signal — use sparingly)
```

Classification priority: `classHint` from adapter (structural evidence) > keyword matching.
Never trust text-only keyword scanning as primary signal.

---

## Intervention → behavior mapping

| Intervention | What actually changes |
|---|---|
| `compress_context` | `distillContext()` uses `maxRecentAttempts: 1` next attempt |
| `change_model` | `currentAdapter = adapter.withModel(nextModel)` — haiku→sonnet→opus |
| `tighten_task` | Injects SCOPE LOCK directive into next prompt |
| `run_verifier` | Injects VERIFICATION FOCUS directive into next prompt |
| `tighten_task` | Injects SCOPE LOCK directive into next prompt |
| `switch_adapter` | Not yet wired; currently falls through to `escalate_human` |
| `escalate_human` | Loop exits with `human_escalation` lifecycle state |
| `stop_loop` | Loop exits immediately with `budget_exit` |

---

## Oscillation detection

`detectOscillation()` in `core/src/index.ts` checks the last 4 attempt failure classes:
- A→B→A (3-attempt alternation) → exits with `diminishing_returns`
- A→B→A→B (4-attempt alternation) → exits with `diminishing_returns`

Combined with `countRecentFailureMatches()` which catches A→A→A patterns.
Together these prevent both consecutive and alternating death cycles.

---

## PROGRESS.md

Written to `task.repoRoot` (when set) after each failed attempt. Content:
```
# Martin Loop Progress

**Original objective:** [objective]

## Attempt N — [timestamp]
- Failure class: syntax_error
- Verification: Verification failed: bun run typecheck
  STRUCTURED ERRORS:
    src/auth.ts:42 — TS2322: Type 'string' is not assignable to type 'number'
```

The agent is instructed to read this file before starting each attempt. This re-anchors the agent on the original objective and prevents it from re-deriving the same wrong hypothesis.

File is NOT committed (add to `.gitignore` or it will pollute the repo).

---

## Run verification locally

```bash
# Prerequisites: Claude CLI installed and authenticated
# pnpm install from repo root

# Stub mode (no real AI calls, instant)
MARTIN_LIVE=false martin run --objective "test" --max-iterations 1 --budget-usd 2

# Live mode
martin run \
  --objective "Add a type annotation to the greet function in src/hello.ts" \
  --cwd /path/to/your/project \
  --verify "bun run typecheck" \
  --model claude-haiku-4-5 \
  --max-iterations 3 \
  --budget-usd 0.50

# After the run, check:
cat ~/.martin/runs/*.jsonl | jq .cost   # real token costs
cat /path/to/your/project/PROGRESS.md  # hypothesis chain
```

---

## Known engineering issues (P0 / immediate)

1. **Task contract machine check not wired** — `allowedPaths`/`deniedPaths` appear in prompt but
   `git diff --name-only HEAD` output is not checked against them post-attempt. A `scope_creep`
   classHint should fire when a changed file is not in `allowedPaths`.

2. **`verificationStack` type defined, not wired** — `LoopTask.verificationStack` exists in
   contracts but `runVerification()` in `claude-cli.ts` ignores it and runs `verificationPlan`
   string array only.

3. **`--resume` is dashboard copy** — displayed in local dashboard as `martin run --resume ...`
   but the CLI flag does not exist. Remove from dashboard until implemented.

4. **Control plane mock paths not guarded** — `apps/control-plane/lib/data/mock-control-plane-data.ts`
   is still imported in production routes for billing/governance/economics. These pages need a
   real data source or an explicit `DEMO_MODE` guard that renders a "demo mode" banner.

---

## Senior code standards for this repo

- One canonical source of truth per policy area. No shadowing.
- No helper modules that silently duplicate live runtime logic.
- No hard-coded business metrics in any production path.
- No retry without a measurable reason to continue (failure class + evidence).
- No mutation of the same workspace across failed attempts (git reset enforced).
- No `hallucination` as primary classification signal — it is a last resort.
- Every displayed metric must carry provenance: actual / estimated / modeled / unavailable.
- Prefer deletion over patch-stacking when code is duplicated or unclear.

---

## Remediation pack

A full remediation specification with PR-sized tickets and file-by-file diff checklist exists in
`martin-loop-remediation-pack-v3/` (shared separately). Key documents:
- `10-actual-code-patch-plan.md` — exact implementation waves
- `12-pr-sized-implementation-tickets.md` — reviewable PR sequence
- `13-file-by-file-diff-checklist.md` — surgical diff checklist
- `14-issue-cards.md` + `15-issue-cards-import.csv` — ready to import into Jira/Linear/GitHub
