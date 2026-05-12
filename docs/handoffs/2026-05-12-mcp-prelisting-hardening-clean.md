# 2026-05-12 MCP Prelisting Hardening Clean Handoff

## Objective

Finish PR #34 on `codex/mcp-prelisting-hardening-clean`, merge it into `main`, publish `@martinloop/mcp@0.1.2` via trusted publishing, and attach GitHub release notes for the MCP package.

## Execution Log

### 2026-05-12 23:00 America/Toronto

- Started execution from the dirty local branch `codex/mcp-prelisting-hardening-clean`.
- Confirmed tracked intended diffs:
  - workflow pnpm version bumps to `10.33.0`
  - `README.md` RC gate list includes `pnpm mcp:published:smoke`
  - root `package.json` version is set to `0.1.6`
  - `packages/mcp/scripts/smoke-published-package.mjs` contains npm-first / tarball fallback hardening
  - generated audit reports have timestamp-only churn
- Confirmed local npm CLI auth is healthy with `npm whoami -> martinloop`.
- Confirmed live npm package is still `@martinloop/mcp@0.1.1`.
- Confirmed PR #34 remote head is stale relative to local branch and still needs the local commits pushed before GitHub reflects the true branch state.
- Confirmed current plan is to:
  - keep root `martin-loop` at `0.1.6`
  - merge PR #34
  - publish via `mcp-v0.1.2`
  - use `docs/release/MCP-0.1.2-RELEASE-NOTES.md` for GitHub release notes

### Next Actions

- Run `pnpm release:matrix:local`.
- Fix any blockers exposed by the matrix.
- Commit and push the finalized branch.
- Merge PR #34.
- Tag `mcp-v0.1.2`, publish, and verify npm/live smoke.

### 2026-05-12 23:20 America/Toronto

- Ran `pnpm release:matrix:local` from repo root.
- Result: PASS on the local Windows lane.
- Release matrix log dir:
  - `C:\Users\Torram\AppData\Local\Temp\martin-release-matrix-C5GEye\logs`
- Nested RC validation log dir:
  - `C:\Users\Torram\AppData\Local\Temp\martin-rc-validation-4KsGZR\logs`
- Verified successful commands within the matrix:
  - `pnpm install --frozen-lockfile`
  - `pnpm build`
  - `pnpm oss:validate`
  - `pnpm public:smoke`
  - `pnpm mcp:published:smoke`
  - `pnpm repo:smoke`
  - `pnpm rc:validate`
- Confirmed the MCP published smoke used the fallback local tarball path because npm still only has `@martinloop/mcp@0.1.1`.
- Regenerated report artifacts now reflect the successful final validation run timestamps and should be kept with the PR.

### Updated Next Actions

- Stage only the intended tracked diffs plus this handoff file.
- Commit the finalized PR fix set.
- Push `codex/mcp-prelisting-hardening-clean` so PR #34 reflects the real branch head.
- Verify GitHub reruns CI on the pushed head, then merge PR #34.
- Publish `@martinloop/mcp@0.1.2` from merged `main` via `mcp-v0.1.2`.
