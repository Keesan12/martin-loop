---
name: martinloop-govern
description: Govern coding-agent implementation end to end with MartinLoop preflight, budgets, scope, stop conditions, verification, recovery evidence, receipts, and post-run analysis.
---

# Govern With MartinLoop

Use MartinLoop as the execution-control and evidence layer around the coding agent. The coding agent still performs the software work. MartinLoop governs the run from Definition of Done through Controlled Run and Verified Handoff.

Do not make the user stitch together separate control scripts for each stage when the existing MartinLoop surface can cover the lifecycle.

```text
DEFINE -> PREFLIGHT -> CONTROL -> VERIFY -> RECOVER -> PROVE -> ANALYZE
```

Preserve the user's requested scope and never replace verifier evidence with an agent assertion.

## Workflow

1. Call `martin_doctor` to confirm the environment and coding-agent host are ready.
2. Call `martin_estimate` to expose budget and cost posture before spend.
3. Call `martin_plan` to define the bounded objective, files, and verification.
4. Call `martin_preflight` and resolve blocking contract issues before execution.
5. Call `martin_run` only after the required readiness evidence accepts the contract.
6. Call `martin_dossier` after the run and inspect its evidence.
7. Use run history, receipt integrity, failure classification, and evaluation surfaces when post-run analysis is useful.

## Outcome Rules

- Report `VERIFIED` only when configured evidence supports the Definition of Done.
- Treat `STOPPED` as a real enforced hard boundary and report its recorded reason.
- Treat `NEEDS_REVIEW` as unresolved completion evidence, never successful completion.
- A verifier failure can lead to repair and another allowed attempt; do not automatically relabel it as `STOPPED`.
- Preserve the dossier or Verified Handoff as the completion record.
- Never weaken a gate, increase a budget, widen scope, or approve protected work without authorization.
- Let the coding agent or provider select its model unless the user explicitly overrides it.

## Codex Hosts

Do not assume one Codex flag contract applies to every installation. MartinLoop 0.5.5 resolves and interrogates the exact Codex executable, negotiates governed-autonomous capabilities, proves a workspace-bound writable strategy, and reuses that execution contract for the governed run.

Do not add a guessed approval, automation, sandbox, or model flag to work around a host mismatch.

## Presentation Boundary

Terminal color, motion, and MartinLoop Arcade are presentation-only. They cannot alter governance decisions, verifier evidence, budgets, run outcomes, or receipts.

## First Task

For a low-risk trial, govern a small repository change with a real verifier and inspect the resulting dossier and receipt evidence.
