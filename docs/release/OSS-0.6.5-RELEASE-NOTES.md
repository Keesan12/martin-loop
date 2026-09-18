# MartinLoop 0.6.5

MartinLoop 0.6.5 is a targeted usability patch that closes the final prelaunch acceptance gaps in project-mode config, badge scoring, MCP schema discovery, and proof-card verdicts.

## What changed

- Project-mode config now canonicalizes the working directory path on write and read so `martin mode --scope project` round-trips correctly on Windows and other case-insensitive file systems.
- Badge reliability score propagates an explicit `--runs-dir` value to the persisted loop store so workspaces configured with a non-default runs directory are scored from the right data.
- MCP `loopPreviewSchema` advertises `activeAttemptId` as an optional string property so MCP hosts can display the active attempt ID without inferring it from side channels.
- `proofCardInputFromLoop` maps a cleanly completed run (`status=completed`, `lifecycleState=completed`) to `rollbackStatus="not_required"` so the proof card can reach a `VERIFIED` verdict for runs that succeeded without needing a rollback. Receipt-integrity gating is preserved: a run without a verified receipt remains `EVIDENCE_BOUNDARY` regardless of rollback state.
- Root package, standalone MCP package, plugin metadata, MCPB product version, release-truth metadata, and built runtime version authority align at `0.6.5`.

## Upgrade

No configuration changes are required.

```sh
npx -y martin-loop@0.6.5 --version
npx -y martin-loop@0.6.5 doctor
npx -y @martinloop/mcp@0.6.5
```
