# C.0-C.11 Verification Snapshot

Date: 2026-06-08  
Repo: `martin-loop`  
Branch: `codex/gsd-phase08-mainline`

## Exact branch commits in scope

- `230c955` fix(cli): enforce cwd-scoped config and reject traversal path policies
- `4a27c12` fix(cli): harden share trust output and canonical file selector integrity
- `4b594c8` fix(cli): align proof-mode execution and flag untrusted copied receipt fields
- `d71314d` fix(cli): add run timeout fail-closed guard and proof-mode parser alignment
- `3d9b2e7` fix(cli): use probed codex executable for runtime adapter launch

## Targeted hardening gates

- `pnpm --filter @martin/cli test` -> PASS (12 files, 109 tests)
- `pnpm --filter @martin/cli lint` -> PASS

## Repo-level staging gates

- `pnpm test` -> PASS
- `pnpm build` -> PASS
- `pnpm oss:validate` -> PASS
- `pnpm public:smoke` -> PASS
- `pnpm release:matrix:local` -> PASS

## MCP package gates

- `pnpm --filter @martinloop/mcp lint` -> PASS
- `pnpm --filter @martinloop/mcp test` -> PASS
- `pnpm --filter @martinloop/mcp build` -> PASS
- `pnpm --filter @martinloop/mcp smoke:pack` -> PASS
- `pnpm --filter @martinloop/mcp smoke:published:pack` -> PASS
- `pnpm --filter @martinloop/mcp verify:release` -> PASS

## Known pending items before public promotion

- External field rerun against the client contract task (C.10 external replay) is not yet completed on this exact commit line.
- Promotion packet (C.11) still needs contamination-safe changed-path review and final public copy sweep on the promotion branch.
