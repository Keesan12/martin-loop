# Next Hardening

This continuation plan is grounded in the attached `martin-loop-complete-handoff-v6-hardening-pack.zip` and the current repository state.

Hardening standard of proof:

- A passing test is required
- A persisted artifact is required where the hardening spec expects one
- Do not ship based on prose claims, logs, or mutable status text alone

## Hardening Program Sources

Copied source references are included under `references/v6-hardening/`:

- `HARDENING-CHARTER.md`
- `ONE-WEEK-HARDENING-EXECUTION-PLAN.md`
- `PROOF-OF-TRUTH-RELEASE-GATES.md`
- `HARDENING-ISSUE-CARDS.md`
- `FAILURE-MODE-CHALLENGE-SET.md`

## Repo Status Against v6 Hardening Cards

### H-01 Golden Path Stabilization

Status: mostly done

Why:

- Phase 5 adapter normalization and spawn hardening landed
- Phase 6 and Phase 7 verification passed
- The biggest remaining stability work is challenge-set completion, not first-pass golden-path construction

### H-02 Grounding Anatomy Index

Status: partial

Why:

- Grounding/index work exists from earlier phases
- The v6 pack raises the bar from basic grounding to harder integrity guarantees and challenge coverage

### H-03 Changed-File Grounding Scanner

Status: partial

Why:

- There is already grounding and safety enforcement in core runtime paths
- The hardening pack expects more exhaustive changed-file truth and challenge-case coverage

### H-04 Budget Preflight And Admission

Status: mostly done

Why:

- Budget preflight, settlement, and provenance-aware cost handling already landed
- Remaining work is certification-level challenge coverage and stricter proof gates

### H-05 Accounting Mode Distinction

Status: partial

Why:

- Cost provenance exists
- The hardening pack wants stronger truth boundaries in read models and claims so estimated values are never accidentally presented as settled fact

### H-06 Leash v2 Profile Engine

Status: partial

Why:

- Blocking safety enforcement exists
- The pack calls for a more explicit profile/trust-mode structure than the current baseline

### H-07 Patch Truth And Rollback

Status: foundation only

Why:

- Safety and adapter groundwork is in place
- The pack expects explicit keep/discard truth, rollback-capable persistence, and stronger patch-decision evidence

### H-08 Read-Model Truth Completion

Status: partial

Why:

- Phase 6 moved the control plane onto real repository-backed data
- The hardening pack expects read-model truth to line up exactly with persisted artifacts and accounting modes

### H-09 Claim Freeze And Release Gate Review

Status: not started in repo

Why:

- Phase 7 created the evaluation/reporting foundation
- The release gate and claim-freeze policy layer still needs to be encoded in repo-facing docs and launch language

## Recommended Order Of Execution

1. Finish H-02 and H-03 grounding integrity work first
2. Implement H-06 leash v2 trust-mode and profile behavior
3. Implement H-07 patch truth, keep/discard evidence, and rollback behavior
4. Tighten H-08 read-model truth so UI and APIs only speak from persisted facts
5. Complete H-09 claim freeze and release gate wording using the certification outputs

## Challenge Areas Still Worth Running

From `FAILURE-MODE-CHALLENGE-SET.md`, the highest-value unresolved challenge clusters appear to be:

- Grounding challenges `1-5`
- Safety challenges `12-13`
- Patch truth challenges `14-17`
- Stability challenges `18-20`

## One-Week Hardening Translation

If the next engineer wants to follow the source pack sequencing closely, use this order:

1. Day 1: stabilize the golden path and eliminate remaining crash classes
2. Day 2: finish grounding integrity core and changed-file truth
3. Day 3: tighten budget-control-v3 admission and settlement proof boundaries
4. Day 4: add leash-v2 trust modes and patch-truth behavior
5. Day 5: run certification, align read models with truth artifacts, and freeze claims

## Practical First Task

The best immediate starting task is to audit the current grounding and changed-file enforcement against the v6 failure-mode challenge set, then add any missing tests before touching runtime behavior.
