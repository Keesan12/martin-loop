# 0.5.5 -> 0.5.7 release incident index

This index maps the August 2026 release incidents to their owning internal repository. It exists so future agents do not re-open completed work, misfile hosted defects as Engine defects, or treat public output as the source of truth.

## Core / CLI / MCP / release process

Owner: `private OSS staging repository`

- `CORE-055-001` execution knobs contaminated governance scope identity — P1 — resolved
- `CORE-055-002` global workflow-state cross-repo contamination — P1 — resolved
- `CORE-055-003` post-success release churn after 0.5.5 — P2 — resolved
- `CORE-055-004` macOS `/var` vs `/private/var` smoke harness aliasing — P2 — resolved
- `CORE-056-001` npm stripped MCP executable aliases — P0 — resolved
- `CORE-056-002` MCPB manifest 0.5.5 vs package 0.5.6 — P1 — resolved in 0.5.7
- `CORE-056-003` 0.5.6 README still pinned to 0.5.5 — P1 — resolved in 0.5.7
- `CORE-056-004` stale/incomplete promotion authority — P1 — resolved
- `CORE-056-005` 0.5.6 omitted signed/privacy-safe hosted receipt path required for paid acceptance — P1 — resolved in 0.5.7
- `CORE-057-001` implicit Claude fallback violated provider-neutral auto — P1 — resolved
- `CORE-057-002` persisted engine preference `MemoryEntry` treated as string — P1 — resolved
- `CORE-057-003` tracked `.txt` falsely failed grounding — P1 — resolved
- `CORE-057-004` verified run became `budget_exit` due implicit token cap — P1 — resolved
- `CORE-057-005` caller-owned estimate/preflight/run choreography — P1 — resolved
- `CORE-057-006` noninteractive milestone prompt hang — P2 — resolved
- `CORE-057-007` real desktop Codex contaminated deterministic public-facade smoke — P2 — resolved
- `CORE-057-008` generated dependency residue contaminated release tests — P2 — resolved
- `CORE-057-009` MCP schema required `remainingTokens` without a token cap — P1 — resolved
- `CORE-057-010` blanket internal-vs-public deletions risked public-only assets — P1 — contained before public commit
- `CORE-057-011` stale tests encoded removed manual-prerequisite behavior — P2 — resolved
- `CORE-057-012` sync multiprocessing duplicate upload observed once — P2 — watch/unconfirmed
- `CORE-057-013` pack/schema defects surfaced later than standard suite — P2 — post-release prevention item
- `CORE-057-014` Track 1 / Track 2 ownership confusion — P2 — resolved by explicit handoff boundaries
- `CORE-057-015` workaround-shaped fixes threatened invariants during release debugging — P2 — rejected/reverted before merge

Detailed ledger: `docs/incidents/2026-08-release-0.5.5-0.5.7.md`.

## Engine

Owner: `private engine repository`

- `ENG-056-001` master status listed LB4-LB6 active after PR #8 merged — P2
- `ENG-057-001` code-complete Trace Intelligence PR risked being treated as validated — P2
- `ENG-057-002` incident-report -> Atlas adapter stayed critical after bottleneck changed — P2

Detailed ledger is on the corresponding incident branch/PR in `private engine repository`.

## Control Plane / hosted

Owner: `private hosted control-plane repository`

- `CP-056-001` invalid/missing URL could inherit `open_testing` — P0 — fixed before merge
- `CP-057-001` Trace Intelligence route test used full URL with path-only helper — P2
- `CP-057-002` hosted verifier canonicalization mismatched Core signing semantics — P1
- `CP-057-003` no hosted trust bootstrap for Core per-run HMAC key — P1
- `CP-057-004` hosted-invented fixtures overstated Core compatibility — P1
- `CP-057-005` CP PR #39 overlapped active CTO A11/A12 authority — P2
- `CP-057-006` dashboard/hosted production authority temporarily forked — P2

Detailed ledger is on the corresponding incident branch/PR in `private hosted control-plane repository`.

## Explicit non-incident

GitHub Actions zero-step runner admission caused by account billing/spending-limit state is a recurring external condition, not a product incident. Record it as `HOSTED_CI=BLOCKED_ZERO_STEP_RUNNER_ADMISSION_NOT_CLAIMED_PASS`; do not file recurring incident tickets for it and do not call it PASS.

## Release-training rule

Before any future release, read this index and the owning repo's detailed ledger. For each new failure ask:

1. Is this the same invariant already documented here?
2. Is the failure product, harness, environment, integration, or process?
3. Which repo owns the correction?
4. What independent evidence proves the correction?
5. Does the packed/installed artifact prove the contract, or only the workspace?

Do not rediscover these incidents as new architecture work.
