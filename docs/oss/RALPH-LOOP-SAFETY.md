# Ralph-Style Loop Safety Guide

Ralph-style loops are useful because they keep trying until a coding task reaches a stopping condition. MartinLoop is not a replacement for that pattern. It is the governance layer that makes the pattern safer to run unattended.

For install and first-run steps, start with the repo quickstart: [README.md#quick-start](../../README.md#quick-start)

## 1. What Ralph-style loops do well

Ralph-style loops are good at persistence:

- they retry after a failed attempt
- they keep working toward a concrete objective
- they help teams automate long-running coding tasks that would otherwise need constant supervision

That persistence is the reason teams use them. The problem is not the existence of the loop. The problem is what happens when the loop keeps running without a clear governance contract.

## 2. Where unattended loops fail

An unattended coding loop can fail in ways that are expensive even when no single attempt looks dramatic on its own:

- spend keeps accumulating across retries
- verifier failures repeat without a meaningful strategy change
- file edits drift outside the intended task boundary
- the final outcome is hard to audit because the reasoning trail is incomplete
- operators know that the loop stopped, but not whether it stopped for success, safety, or exhaustion

Those are governance failures, not only model failures.

## 3. Why max iterations alone are not enough

A max-iteration limit is helpful, but it only answers one question: "How many times may this loop try?"

It does not answer:

- how much budget can be spent before the next attempt is rejected
- whether the verifier command is safe to run
- whether the patch stayed inside the approved file scope
- whether a failed run left rollback evidence behind
- whether the recorded outcome is trustworthy enough to resume or inspect later

Iteration caps are one guardrail. They are not a full control layer.

## 4. What MartinLoop adds

MartinLoop governs the loop before, during, and after execution:

- **Budget governance** rejects work that would exceed the configured spend, token, or iteration envelope
- **Verifier gates** only allow a run to finish as `completed` when the agent result and verification state both pass
- **Safety leash checks** evaluate verifier commands, file boundaries, and approval-sensitive actions before work is accepted
- **Stop reasons** make the final lifecycle state explicit, such as `completed`, `budget_exit`, or `human_escalation`
- **Run records** append JSONL evidence under `~/.martin/runs/` so operators can inspect what happened later
- **Rollback evidence** preserves the recovery boundary for repo-backed runs when persistence is configured

That is why MartinLoop should be thought of as a companion governance layer around a Ralph-style loop, not an argument against using one.

## 5. Example governed run

```bash
martin run "fix the auth regression" \
  --budget 3.00 \
  --soft-limit-usd 2.00 \
  --max-iterations 2 \
  --verify "pnpm test"
```

This changes the operator contract in a few important ways:

- the next attempt can be rejected before overspend happens
- the run still has to satisfy the verifier
- the final state is inspectable instead of being inferred from logs alone

## 6. Example stop reason

MartinLoop returns an explicit lifecycle state and reason when a run stops:

```json
{
  "decision": {
    "shouldExit": true,
    "lifecycleState": "budget_exit",
    "status": "exited",
    "reason": "Martin exited because the budget governor hit a hard limit."
  }
}
```

That answer is more useful than "the loop stopped" because it tells the operator whether the run ended for success, safety, or exhaustion.

## 7. Example JSONL run record

Each run appends a JSONL record shaped like:

```json
{
  "loopId": "loop_example123",
  "workspaceId": "ws_demo",
  "projectId": "proj_demo",
  "status": "exited",
  "lifecycleState": "budget_exit",
  "budget": {
    "maxUsd": 3,
    "softLimitUsd": 2,
    "maxIterations": 2,
    "maxTokens": 20000
  },
  "metadata": {
    "policyProfile": "balanced",
    "telemetryDestination": "local-only"
  }
}
```

The full record can also include attempts, events, verifier outcomes, and persisted artifact references. That is the evidence trail MartinLoop adds around a retrying coding loop.
