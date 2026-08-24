---
name: martinloop-govern
description: Use MartinLoop as one system around coding agents to take software work from intent to a trustworthy handoff without stitching the surrounding workflow together manually.
---

# Use MartinLoop Around the Coding Agent

MartinLoop is the surrounding system for coding-agent work. The coding agent still writes the code.

Use MartinLoop to help the user move from what they want built to software they can actually review and hand off: define what done means, let the agent work, check the result, recover when needed, and preserve enough context to understand what happened.

Do not reduce MartinLoop to a list of controls. Budgets, scope rules, verifier commands, recovery evidence, receipts, and run analysis are mechanisms that support the workflow; they are not the primary user story.

A simple user-facing model is:

```text
INTENT -> DEFINITION OF DONE -> AGENT WORK -> CHECK -> RECOVER -> HANDOFF
```

The internal governed lifecycle remains:

```text
DEFINE -> PREFLIGHT -> CONTROL -> VERIFY -> RECOVER -> PROVE -> ANALYZE
```

Preserve the user's requested scope and never replace verifier evidence with an agent assertion.

## Workflow

1. Call `martin_doctor` to confirm the environment and coding-agent host are ready.
2. Use `martin_plan` to turn the request into an explicit finish line.
3. Use `martin_estimate` when cost posture is useful before the run.
4. Call `martin_preflight` and resolve blocking contract issues before execution.
5. Call `martin_run` only after the required readiness evidence accepts the contract.
6. Call `martin_dossier` after the run to understand what happened and what remains unresolved.
7. Use run history, integrity, failure classification, and evaluation surfaces when deeper post-run analysis is useful.

## Outcome rules

- Report `VERIFIED` only when configured evidence supports the Definition of Done.
- Treat `STOPPED` as a real enforced boundary and report its recorded reason.
- Treat `NEEDS_REVIEW` as unresolved completion evidence, never successful completion.
- A verifier failure can lead to repair and another allowed attempt; do not automatically relabel it as `STOPPED`.
- Preserve the dossier or Verified Handoff as the completion record.
- Never weaken a gate, increase a budget, widen scope, or approve protected work without authorization.
- Let the coding agent or provider select its model unless the user explicitly overrides it.

## How to explain MartinLoop to the user

Prefer:

> MartinLoop gives you one system around coding agents so you can get from an idea to software you can actually review without assembling the workflow yourself.

Prefer:

> The coding agent still does the coding. MartinLoop connects what happens around it so the finish line, result, recovery, and handoff stay understandable.

Avoid leading with:

> MartinLoop provides budget caps, verifier gates, rollback evidence, receipts, and failure triage.

Those details can be useful when the user asks how the system works.

## Codex hosts

Do not assume one Codex flag contract applies to every installation. MartinLoop resolves and interrogates the exact Codex executable, negotiates supported capabilities, proves a workspace-bound writable strategy, and reuses that execution contract for the governed run.

Do not add a guessed approval, automation, sandbox, or model flag to work around a host mismatch.

## Presentation boundary

Terminal color, motion, and MartinLoop Arcade are presentation-only. They cannot alter execution decisions, verifier evidence, configured boundaries, run outcomes, or receipts.

## First task

For a low-risk trial, use MartinLoop around a small repository change with a real verifier, then inspect the resulting handoff rather than treating the coding agent's own completion message as the final answer.
