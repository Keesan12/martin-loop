# Roadmap: Martin Loop v4 Controller Rebuild

## Overview

Full rebuild of Martin Loop from a partial retry harness into a production-grade evidence-driven
execution controller. The rebuild proceeds in order: clean repo → typed state machine → real
persistence stack → grounding/policy/budget engine → safety leash → real control plane →
eval bakeoff. The control plane dashboard cannot be real until the persistence stack (Phase 3)
produces structured data for it to read.

## Phases

- [x] **Phase 1: Repo Surgery** - Clean rebuild branch, remove embedded zips and generated artifacts, establish canonical module map
- [x] **Phase 2: Runtime State Machine** - Replace FailureClass-only brain with typed EvidenceVector + PolicyPhase state machine
- [x] **Phase 3: Persistence Stack** - Every run writes contract.json + state.json + ledger.jsonl + artifacts (prerequisite for real control plane)
- [x] **Phase 4: Grounding and Policy Engine** - Grounding scanner, policy transitions, budget governor v3 with admission control
- [x] **Phase 5: Safety Leash and Adapters** - Blocking safety enforcement, normalized adapter interfaces
- [x] **Phase 6: Real Control Plane** - Delete mock data, wire Supabase + Clerk, CTO-ready dashboard
- [x] **Phase 7: Eval Bakeoff** - Benchmark v4 vs baseline, release gate report
- [x] **Phase 8: Grounding Integrity Hardening** - Challenge cases 1-5 with persisted anatomy artifacts; grounding scan wired into loop at VERIFY
- [ ] **Phase 9: Safety Leash v2 Profile Engine** - Network + change-approval leash; ExecutionProfile dispatch; challenges 10-13
- [ ] **Phase 10: Patch Truth and Rollback** - PatchTruthArtifact; regression/entropy/improvement-ratio guards; challenges 14-17
- [ ] **Phase 11: Read-Model Truth** - Control-plane API surfaces costProvenance, budgetSettlement, patchTruth, groundingScanResult
- [ ] **Phase 12: Certification and Claim Freeze** - 20-challenge certification test suite; hardening report; claim matrix

## Phase Details

### Phase 1: Repo Surgery
**Goal**: Create a clean `rebuild/v4-controller` branch with zero noise. Engineers and agents can identify live code paths in under 10 minutes.
**Depends on**: Nothing (first phase)
**Requirements**: R1.1, R1.2, R1.3, R1.4, R1.5, R1.6, R1.7, R1.8
**Success Criteria** (what must be TRUE):
  1. `rebuild/v4-controller` branch exists and is checked out
  2. No zip archives in tracked git paths at repo root
  3. `MartinLoop V3 3-31-2026/` is not in tracked paths
  4. `.gitignore` covers node_modules, dist, .next, .turbo, .npm-cache, root *.zip
  5. Root `README.md` lists the 5 canonical runtime files
  6. `docs/legacy/` directory exists with relocated reference material
**Plans:** 3 plans
Plans:
- [x] 01-01-PLAN.md — Git init, branch setup, and gitignore hardening
- [x] 01-02-PLAN.md — Root cleanup: remove noise, relocate legacy docs to docs/legacy/
- [x] 01-03-PLAN.md — README update with canonical runtime path map

### Phase 2: Runtime State Machine
**Goal**: Replace the FailureClass-only controller brain with a typed EvidenceVector and explicit PolicyPhase state machine. Policy reads evidence, not just labels.
**Depends on**: Phase 1
**Requirements**: R2.1, R2.2, R2.3, R2.4, R2.5, R2.6
**Success Criteria** (what must be TRUE):
  1. `PolicyPhase` enum exists in packages/contracts/src/index.ts with all 8 values
  2. `EvidenceVector` interface exists with all required fields
  3. `MachineState` interface exists with all required fields
  4. Phase transitions in core/src/index.ts are explicit and typed
  5. FailureClass is still present but used as output label only
  6. Tests cover phase transition logic
**Plans**: 2 plans
Plans:
- [x] 02-01-PLAN.md — Import slice work: policy.ts, leash.ts, grounding.ts + add PolicyPhase/EvidenceVector/MachineState to contracts + wire compilePromptPacket and evaluateAttemptPolicy
- [x] 02-02-PLAN.md — Test coverage: compilePromptPacket, evaluateAttemptPolicy, safety leash, grounding index

### Phase 3: Persistence Stack
**Goal**: Make persistence the operating system. Every run writes a structured artifact tree (contract.json, state.json, ledger.jsonl, artifacts). This is the direct prerequisite for a real control plane.
**Depends on**: Phase 2
**Requirements**: R3.1, R3.2, R3.3, R3.4, R3.5, R3.6, R3.7, R3.8
**Success Criteria** (what must be TRUE):
  1. `~/.martin/runs/<runId>/contract.json` written at run start and immutable
  2. `~/.martin/runs/<runId>/state.json` updated on every phase transition
  3. `~/.martin/runs/<runId>/ledger.jsonl` receives all 13 event types
  4. `~/.martin/runs/<runId>/artifacts/attempt-<n>/` written after each attempt
  5. RunStore abstraction exists in packages/core/src/persistence/
  6. ContextCompiler produces deterministic compiled-context.json from disk artifacts
  7. A prompt packet can be reconstructed from disk without chat history
**Plans**: 2 plans
Plans:
- [x] 03-01-PLAN.md — RunStore foundation: LedgerEvent types, FileRunStore, CLI persistence shim
- [x] 03-02-PLAN.md — ContextCompiler + wire RunStore into runMartin + full test coverage

### Phase 4: Grounding and Policy Engine
**Goal**: No attempt executes without passing admission control, grounding scan, and budget gate.
**Depends on**: Phase 3
**Requirements**: R4.1, R4.2, R4.3, R4.4, R4.5, R4.6, R4.7, R4.8
**Success Criteria** (what must be TRUE):
  1. Grounding scanner detects and persists violations for nonexistent files/symbols
  2. All policy transitions (GATHER→ADMIT→PATCH→VERIFY→RECOVER→ESCALATE→ABORT) implemented
  3. Budget preflight runs and can reject an attempt before execution
  4. Settlement records actual vs estimated spend with provenance label
  5. Patch budget and verification budget tracked separately
  6. Zero admitted attempts without preflight passing (enforced in tests)
**Plans**: 2 plans
Plans:
- [x] 04-01-PLAN.md — Grounding scanner, budget preflight, provenance types, and core re-exports
- [x] 04-02-PLAN.md — EvidenceVector/recovery recipes, runMartin preflight wiring, and Phase 4 regression tests

### Phase 5: Safety Leash and Adapters
**Goal**: Blocking (not advisory) safety enforcement. Normalized cost/usage across all adapter types.
**Depends on**: Phase 3
**Requirements**: R5.1, R5.2, R5.3, R5.4, R5.5, R5.6, R5.7, R5.8, R5.9
**Success Criteria** (what must be TRUE):
  1. Filesystem leash blocks writes outside repo root (tested with a violation attempt)
  2. Command leash blocks rm -rf and git reset --hard
  3. Secret leash prevents .env content from appearing in compiled prompts
  4. All violations written to ledger as blocking events
  5. Direct API adapter interface defined in packages/adapters/src/
  6. CLI bridge adapter interface defined
  7. Cost provenance labels: actual / estimated / unavailable — never mixed
  8. One run executes across two adapter types with consistent ledger output
**Plans**: Inline execution completed

### Phase 6: Real Control Plane
**Goal**: Delete every mock import. Wire Supabase + Clerk. Ship a dashboard the CTO can open to live run data with no mock values anywhere.
**Depends on**: Phase 3, Phase 1
**Requirements**: R6.1, R6.2, R6.3, R6.4, R6.5, R6.6, R6.7, R6.8, R6.9, R6.10, R6.11, R6.12, R6.13, R6.14, R6.15
**Success Criteria** (what must be TRUE):
  1. `apps/control-plane/lib/data/mock-control-plane-data.ts` does not exist
  2. `apps/local-dashboard/data/demo-data.js` does not exist
  3. No file in apps/control-plane/ contains `import.*mock-control-plane-data`
  4. Supabase schema migrations exist covering all 7 required tables
  5. Ingestion worker reads ledger.jsonl and upserts to Supabase
  6. All dashboard pages show provenance labels (actual/estimated/modeled)
  7. All dashboard pages show "No runs yet" when database is empty
  8. Clerk auth protects all routes (401 without auth token)
  9. Every metric on every page traces to a ledger event in Supabase
**Plans**: Inline execution completed

### Phase 7: Eval Bakeoff
**Goal**: Prove Martin v4 beats baseline. Generate the go/no-go report for CTO sign-off.
**Depends on**: Phase 6
**Requirements**: R7.1, R7.2, R7.3, R7.4, R7.5
**Success Criteria** (what must be TRUE):
  1. Benchmark variants A/B/C produce comparable results across 3+ runs each
  2. v4 solve rate matches or exceeds baseline on same task set
  3. False progress rate materially lower than baseline
  4. Budget estimate variance documented across 20+ runs
  5. Final go/no-go report produced and reviewed
**Plans**: Inline execution completed

### Phase 8: Grounding Integrity Hardening
**Goal**: Challenge cases 1-5 pass with persisted anatomy artifacts. No grounding claim depends on prose or mutable log text.
**Depends on**: Phase 4
**Requirements**: H-02, H-03
**Success Criteria** (what must be TRUE):
  1. Challenge 1 test passes: `import_not_found` fires for fake relative import in diff
  2. Challenge 2 test passes: `symbol_not_found` fires for unrecognized symbol in diff
  3. Challenge 3 test passes: external npm import without approval detected
  4. Challenge 4 test passes: `patch_outside_allowed_paths` blocks out-of-scope file modification
  5. Challenge 5 test passes: diff with only comments/whitespace classified as content-only
  6. Anatomy artifact written to `~/.martin/grounding/<hash>.json` and schema-validated in test
  7. `scanPatchForGroundingViolations` called in runMartin VERIFY phase and result appended to ledger
**Plans:** 2 plans
Plans:
- [x] 08-01-PLAN.md — Challenge-set grounding tests (cases 1-5) + anatomy persistence test
- [x] 08-02-PLAN.md — Wire scanPatchForGroundingViolations into runMartin VERIFY phase + ledger integration
