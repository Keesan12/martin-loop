# Martin Operator Runbook

## Purpose

This runbook is for Phase 13 release-candidate operators preparing for a staged pilot. It is not permission to start Phase 14 early. Use it to run the current RC safely, collect the right evidence, and escalate quickly when behavior looks strange.

## Standard Operator Flow

1. Confirm the repo is on a reviewed RC baseline and `pnpm rc:validate` is green.
2. Review [../pilot/PILOT-DEFAULTS.md](../pilot/PILOT-DEFAULTS.md) before choosing trust profile, adapter path, and budget.
3. Use the narrowest repo scope possible with explicit `allowedPaths` and `deniedPaths`.
4. Run one task at a time and keep the verification plan explicit.
5. Run one heavy validation lane at a time. Do not overlap `pnpm rc:validate` and `pnpm release:matrix:local` in the same checkout because both build the control-plane output and can race on `.next` artifacts.
6. Review the resulting artifacts before deciding whether the run was usable, blocked correctly, or should be escalated.

## Canonical Artifact Locations

The primary source of truth is always the artifact tree under `~/.martin/runs/<runId>/`.

- `~/.martin/runs/<runId>/contract.json`
- `~/.martin/runs/<runId>/state.json`
- `~/.martin/runs/<runId>/ledger.jsonl`
- `~/.martin/runs/<runId>/artifacts/attempt-XXX/compiled-context.json`
- `~/.martin/runs/<runId>/artifacts/attempt-XXX/grounding-scan.json`
- `~/.martin/runs/<runId>/artifacts/attempt-XXX/leash.json` when a safety violation or block occurs
- `~/.martin/runs/<runId>/artifacts/attempt-XXX/rollback-boundary.json` and `rollback-outcome.json` when a blocked or discarded repo-backed attempt required restore evidence

If the artifacts and the prose disagree, trust the artifacts.

## Before You Mark A Run Acceptable

- Confirm the lifecycle state and stop reason from `ledger.jsonl` and `state.json`.
- Confirm grounding evidence exists for repo-backed attempts.
- Confirm the accounting label stays explicit as `actual`, `estimated`, or `unavailable`.
- Confirm keep or discard decisions can be explained from persisted artifacts.
- Confirm rollback evidence exists for blocked or discarded repo-backed attempts.

## Escalation Path

Escalate immediately to the current runtime owner or lead engineer on rotation when any of the following happens:

- a run mutates files outside the approved scope
- a rollback attempt reports failure or ambiguous restore state
- grounding appears to accept unresolved references
- accounting looks materially wrong relative to provider output
- repeated safety blocks prevent controlled progress and you cannot explain why from the artifacts

When escalating, include:

- repo name and commit SHA
- run ID
- trust profile used
- adapter route used
- exact command or API input
- the smallest artifact set needed to reproduce the issue

## Preparation-Only Reminder

Phase 14 has not started. This runbook supports RC operation and pilot-prep review only.
