# Martin Incident And Rollback Runbook

## When To Use This

Use this runbook when a run produces suspicious behavior, a restore boundary is crossed, or an operator is no longer confident that the repo state and the persisted artifacts match.

## Immediate Incident Triage

1. Stop launching new runs against the same repo until the current state is understood.
2. Capture the run ID, repo path, commit SHA, trust profile, adapter route, and the exact command or request that triggered the behavior.
3. Pull the run artifacts from `~/.martin/runs/<runId>/`.
4. Determine whether the problem is:
   - grounding truth
   - leash or approval boundary behavior
   - rollback or restore behavior
   - accounting or provider-path behavior

## Rollback Procedure

1. Open the affected attempt bundle under `~/.martin/runs/<runId>/artifacts/attempt-XXX/`.
2. Inspect `rollback-boundary.json` to confirm the expected restore boundary.
3. Inspect `rollback-outcome.json` to see whether restore completed, failed, or needs manual follow-up.
4. Compare the current repo state against the recorded boundary before resuming work.
5. If restore failed, do not treat the repo as safe until the boundary is manually reconciled and the failure is documented.

## Stop using Martin for this repo/task if

- a run writes outside the approved scope and restore does not complete cleanly
- the repo state after restore cannot be reconciled with `rollback-boundary.json`
- grounding appears to accept a success claim without verifier-backed evidence
- accounting cannot be explained as `actual`, `estimated`, or `unavailable`
- repeated operator review shows Martin is not predictable enough for the current repo or task class

## Escalation Package

Every incident escalation should include:

- the run ID
- the repo commit SHA before the run
- `ledger.jsonl`
- the relevant `grounding-scan.json`, `leash.json`, `rollback-boundary.json`, and `rollback-outcome.json`
- a short statement of what the operator expected versus what actually happened

## Exit Condition

Do not resume the repo or widen usage until the restore state, operator explanation, and persisted artifacts all agree.
