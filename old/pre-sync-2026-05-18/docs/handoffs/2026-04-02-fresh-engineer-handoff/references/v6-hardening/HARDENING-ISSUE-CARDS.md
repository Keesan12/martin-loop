# Hardening Issue Cards

## H-01 Golden path stabilization
Owner: Runtime lead
Outcome: One canonical route runs end-to-end without crash.
Acceptance: golden-path integration test passes; ledger written; no missing-function crash.

## H-02 Grounding anatomy index
Owner: Core/grounding lead
Outcome: repo anatomy snapshot persisted and queryable.
Acceptance: anatomy artifact generated and used in grounding verdict.

## H-03 Changed-file grounding scanner
Owner: Core/grounding lead
Outcome: changed files, dependencies, missing symbols, unresolved refs captured.
Acceptance: challenge cases 1–5 pass.

## H-04 Budget preflight and admission
Owner: Runtime/budget lead
Outcome: attempt blocked before execution when unaffordable.
Acceptance: budget challenges pass.

## H-05 Accounting mode distinction
Owner: Adapter lead
Outcome: exact vs estimated accounting surfaced everywhere.
Acceptance: read model and artifacts distinguish modes correctly.

## H-06 Leash v2 profile engine
Owner: Safety lead
Outcome: profile-based command/path/network controls block unsafe operations.
Acceptance: safety challenges 10–13 pass.

## H-07 Patch truth and rollback
Owner: Runtime lead
Outcome: keep/discard/escalate/handoff decisions deterministic and evidence-backed.
Acceptance: patch challenges 14–17 pass.

## H-08 Read-model truth completion
Owner: Control-plane lead
Outcome: dashboard surfaces grounding, budget, leash, and patch decision truth.
Acceptance: no fake production metrics; traceability verified.

## H-09 Claim freeze and release gate review
Owner: TPM/VP Eng
Outcome: launch wording aligned to tested truth.
Acceptance: claim matrix approved and all frozen claims updated.
