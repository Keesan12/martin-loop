# MartinLoop OSS `0.2.2` Release Notes

`martin-loop@0.2.2` makes the persisted-run review flow easier to use and easier to trust in the public package surface.

## Included

- `npx martin-loop triage` as the documented first stop when several saved runs need review
- failure-category ranking for persisted runs, including failed verification, budget exits, human escalation, and missing verification evidence
- degraded run-store behavior that skips unreadable saved-run entries with warnings instead of aborting the whole review pass
- refreshed README, quickstart, and CLI docs so the public npm surface explains the triage-first operator workflow clearly

## Compatibility

- the root `martin-loop` package advances to `0.2.2`
- the standalone `@martinloop/mcp` package remains at `0.2.0` for this release
- `inspect` and `resume` remain supported as compatibility views alongside the triage-and-dossier flow
