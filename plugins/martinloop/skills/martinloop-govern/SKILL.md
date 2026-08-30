---
name: martinloop-govern
description: Govern coding-agent implementation with MartinLoop budgets, preflight checks, stop conditions, recovery, and verifier-backed evidence.
---

# Govern With MartinLoop

Use MartinLoop as the execution-control and evidence layer around the coding agent. Preserve the user's requested scope and never replace verifier evidence with an agent assertion.

## Workflow

1. Call `martin_doctor` to confirm the environment is ready.
2. Call `martin_estimate` to expose budget and cost posture before spend.
3. Call `martin_plan` to define the bounded objective, files, and verification.
4. Call `martin_preflight` and resolve blocking contract issues before execution.
5. Call `martin_run` only after preflight accepts the contract.
6. Call `martin_dossier` after the run and inspect its evidence.

## Outcome Rules

- Report `VERIFIED` only with verifier-backed completion evidence.
- Treat `STOPPED` as a real enforced boundary and report its recorded reason.
- Treat `NEEDS_REVIEW` as unresolved evidence, never successful completion.
- Preserve the dossier or Verified Handoff as the completion record.
- Never weaken a gate, increase a budget, or approve protected work without authorization.
- Let the coding agent or provider select its model unless the user explicitly overrides it.

## First Task

For a low-risk trial, govern a small repository change with a real verifier and inspect the resulting dossier.
