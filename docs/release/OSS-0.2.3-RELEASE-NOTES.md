# MartinLoop OSS `0.2.3` Release Notes

`martin-loop@0.2.3` sharpens the Context Diet workflow so agents and operators can hand off the smallest useful run packet with proof attached.

## Included

- `npx martin-loop dossier --latest` as the documented Context Diet default for one-run handoffs
- compact dossier framing that highlights:
  - summary
  - proof card
  - budget status
  - verifier evidence
  - rollback or artifact evidence
  - next safe action
- refreshed README and quickstart copy so the packed npm surface points directly to context-light, evidence-first run review

## Compatibility

- the root `martin-loop` package advances to `0.2.3`
- the standalone `@martinloop/mcp` package remains at `0.2.0` for this release
- `triage`, `inspect`, and `resume` remain supported alongside the Context Diet `dossier` workflow
