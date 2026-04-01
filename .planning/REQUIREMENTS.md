# Requirements: Martin Loop v4 Rebuild

## Source
v6 rebuild execution pack + v5 remediation pack (council decision memo + red team addendum)

---

## Phase 1 — Repo Surgery
- [x] R1.1: Create `rebuild/v4-controller` branch from main
- R1.2: Remove all embedded zip archives from tracked git paths
- [x] R1.3: Remove generated artifacts (node_modules, dist, .next, .turbo, .npm-cache) from tracking
- R1.4: Remove historical directory `MartinLoop V3 3-31-2026/` from tracking
- R1.5: Move legacy reference material to `docs/legacy/`
- [x] R1.6: Add strict .gitignore covering all generated outputs
- R1.7: Update root README with canonical runtime path map
- R1.8: One engineer unfamiliar with the repo can identify live code in under 10 minutes

## Phase 2 — Runtime State Machine + Evidence Vector
- R2.1: Add `PolicyPhase` enum: GATHER | ADMIT | PATCH | VERIFY | RECOVER | ESCALATE | ABORT | HANDOFF
- R2.2: Add `EvidenceVector` interface with all required fields
- R2.3: Add `MachineState` interface (mutable, typed)
- R2.4: Wire explicit phase transitions in core/src/index.ts
- R2.5: FailureClass remains as thin output label only — not the controller brain
- R2.6: Phase transitions are test-covered

## Phase 3 — Persistence Stack + Context Compiler
- R3.1: Every run writes contract.json (immutable after start)
- R3.2: Every run writes state.json (mutable, typed MachineState)
- R3.3: Every event appends to ledger.jsonl (append-only)
- R3.4: Ledger covers: contract.created, attempt.admitted, attempt.rejected, prompt.compiled,
         patch.generated, verification.completed, grounding.violations_found,
         safety.violations_found, budget.settled, attempt.kept, attempt.discarded, run.exited
- R3.5: artifacts/attempt-<n>/ directory written with diff, verifier output, grounding scan
- R3.6: RunStore abstraction isolates persistence from orchestration logic
- R3.7: Context compiler produces deterministic compiled-context.json
- R3.8: Any attempt prompt can be reconstructed from disk artifacts alone (no chat history needed)

## Phase 4 — Grounding + Policy Engine + Budget Governor v3
- R4.1: Grounding scanner detects nonexistent files/symbols referenced in patches
- R4.2: Policy transitions are implemented for all state pairs
- R4.3: Recovery recipes keyed on evidence vector (not just failure label)
- R4.4: Budget preflight runs before every attempt admission
- R4.5: Admission control rejects attempts that exceed budget band or per-attempt cap
- R4.6: Settlement records actual vs estimated spend with provenance label
- R4.7: Patch budget and verification budget are tracked as separate sub-budgets
- R4.8: Zero attempts admitted without preflight estimate passing

## Phase 5 — Safety Leash + Adapter Normalization
- R5.1: Filesystem leash blocks writes outside repo root or to secret paths
- R5.2: Command leash blocks rm -rf, git reset --hard, git clean, credential manipulation
- R5.3: Secret leash prevents .env / ssh keys from entering prompts or logs
- R5.4: Spend circuit breaker fires on estimate variance or runaway usage
- R5.5: All leash violations are blocking (not advisory) and written to ledger
- R5.6: Direct API adapter interface defined (Anthropic SDK)
- R5.7: CLI bridge adapter interface defined (Claude Code / Codex terminal)
- R5.8: Cost provenance is normalized: actual | estimated | unavailable — never conflated
- R5.9: One run can execute across two adapter types with consistent state and telemetry

## Phase 6 — Real Control Plane (CTO Demo)
- R6.1: mock-control-plane-data.ts is DELETED
- R6.2: demo-data.js is DELETED
- R6.3: No file in apps/control-plane/ imports mock-control-plane-data
- R6.4: Supabase schema created: runs, attempts, events, violations, budget_metrics, workspaces, policies
- R6.5: Ingestion worker reads ledger.jsonl and upserts to Supabase
- R6.6: All control-plane-queries.ts queries hit Supabase
- R6.7: All view-models (executive-overview, operator-economics) derive from Supabase
- R6.8: workspaces API route reads from Supabase workspaces table
- R6.9: policies API route reads from Supabase policies table
- R6.10: Clerk auth installed, ClerkProvider wraps layout.tsx
- R6.11: All routes protected by Clerk middleware
- R6.12: Every dashboard metric shows provenance label (actual/estimated/modeled)
- R6.13: Empty states show "No runs yet" — not fake numbers
- R6.14: Demo banners removed (data is real — banners were a stopgap)
- R6.15: Local dashboard removes demo-data.js fallback, shows empty state if no runs

## Phase 7 — Eval Bakeoff
- R7.1: Benchmark variants A/B/C comparing v4 vs baseline
- R7.2: Failure replay suite covering type error, oscillation trap, scope enforcement
- R7.3: Safety incident drills (forbidden command, out-of-scope touch)
- R7.4: Budget estimate variance measured across 20+ runs
- R7.5: Go/no-go report produced for CTO sign-off

---

## Acceptance Criteria (v6 pack)
1. Repo has one clear canonical runtime path
2. Rebuild branch excludes archives, generated artifacts, historical packs from live source
3. Every run writes contract.json, state.json, ledger.jsonl, artifacts
4. Every attempt prompt packet is reconstructable
5. Every completion claim is backed by verifier evidence
6. Grounding violations are detected and persisted
7. Budget control happens before attempt admission
8. Safety leash blocks forbidden file/command/secret/spend violations
9. Production control-plane pages no longer rely on mock sources
10. Release bakeoff beats baseline on solve rate, materially reduces false progress
