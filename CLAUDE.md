# Claude Code Instructions

## Current working status — 2026-08-11

### Working now

- Governed live runs work with both Codex (`gpt-5.4`) and Claude.
- Successful runs persist signed receipts under `~/.martin/runs`; `martin runs verify --loop-id <id> --json` verifies receipt integrity and `martin dossier --loop-id <id>` renders the evidence.
- Verification commands are recorded with exit-code evidence. Real Claude and Codex runs against the OpenDesign test workspace passed `pnpm build` and produced verified receipts.
- The CLI renders a verified completion state for successful governed runs and a signed-failure-receipt state for failed persisted runs.
- Feedback and pilot-interest intake waits for the Supabase response and records a privacy-safe local delivery outcome: `accepted`, `duplicate`, `queued`, or `rejected`.

### Fixed in the current `fixes` branch

- OpenAI-compatible inferred usage or fallback model pricing is marked `estimated`, with `estimatedUsd`; only provider usage with known pricing is marked `actual`.
- Windows Codex launches use the compatible `--approve-for-me` write mode and choose runnable npm shims.
- Dirty worktrees are baselined before a governed attempt, preventing existing operator changes from becoming false scope violations; automatic rollback is skipped for a dirty starting workspace.
- The stale Claude test expectation for Codex write mode was updated.

### Still not complete

- Intake delivery is recorded in local milestone state, not cryptographically bound to the already-finalized loop receipt.
- Live agent output and full persisted agent transcripts are not yet implemented.
- The remaining numbered findings in `CTO_AUDIT_PLEASE.md` / `CTO_AUDIT.md` are backlog unless individually marked fixed; do not describe the whole audit as resolved.

Read and obey `AGENTS.md` before making any change.

The most important repository rule is:

> All MartinLoop implementation must be completed, tested, committed, reviewed, and merged in `ML_Core_OSS_Internal` before any public staging begins.

The public repository is distribution-only.

A blocked public write is a successful guardrail event. Never bypass it or instruct the user to bypass it for unfinished or unmerged work.

Before proposing a public command, verify all of the following:

- the private feature PR is merged;
- the private merge SHA is known;
- private `main` contains that SHA;
- fresh private `main` passed the full internal health proof;
- the public branch starts from current public `main`;
- `.martin/promotion-manifest.json` exists and is valid;
- the promoted diff is public-safe;
- explicit approval exists for the requested public action.

If any condition is false, remain in `ML_Core_OSS_Internal`.
