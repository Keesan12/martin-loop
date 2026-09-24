# MartinLoop Agent Operating Rules

This file is the sole durable operating guide for AI agents and automation working on MartinLoop.

Do not treat historical release notes, old audits, old handoff files, previous branches, terminal history, or prior session summaries as current instructions.

## Repository authority

Development authority:

the private MartinLoop development repository

Public distribution repository:

`Keesan12/martin-loop`

All implementation starts, is reviewed, and is health-proven in the private development authority before public promotion begins.

The public repository is a distribution surface, not a development workspace.

## Current-state authority

For current release/version state, use only:

1. current Git branch / commit state;
2. `package.json`;
3. `packages/mcp/package.json`;
4. `docs/release/VERSION-LEDGER.md`;
5. current required release checks and current open PRs.

Do not infer current status from dates or claims embedded in old documentation.

## Required development sequence

For product changes:

1. start from current private `main`;
2. create a private feature/fix branch;
3. implement privately;
4. run the required targeted and repo health checks;
5. open a private PR;
6. merge only after the change is reviewed and green;
7. sync fresh private `main`;
8. run the required private-main health proof;
9. record the validated private release SHA;
10. only then begin public promotion.

Never implement the real fix directly in the public repository.

## Required release sequence

Use this order:

private authority → private health proof → clean public staging → promotion guard → public tests → public PR → public merge → publish → fresh-install proof → production E2E.

Do not reorder the sequence unless an existing release controller explicitly requires it.

Do not create an additional release phase merely because another agent used one previously.

## Public promotion

Public promotion must be derived from the validated private release authority and the exact current public base.

Use the canonical release commands instead of manually editing SHA coordinates or divergence hashes:

1. on clean private `main`, run `pnpm release:health:evidence`; this executes the canonical health matrix and binds the evidence to the exact current `HEAD`;
2. from the same exact private `HEAD`, run `pnpm release:promotion:prepare -- --public-repo <public-checkout>`;
3. the preparer fetches current public `main`, derives the public base SHA, creates `public-staging/<version>` only from that base, copies the complete non-divergent surface, and three-way merges reviewed content divergences using previous-private → current-private changes over the current public base;
4. review the staged public diff, commit it, and run `pnpm public:promotion-guard` from the public staging checkout.

Never hand-edit `validatedReleaseSha`, `privateMainShaValidated`, `privateMergeSha`, `publicBaseSha`, `privateSha256`, or `publicSha256` merely to make a release guard pass.

Never create version-specific `apply-promotion-XYZ` scripts. The canonical preparer is the reusable promotion path.

If exact-SHA health evidence is stale, regenerate it by rerunning the canonical health command. Do not rewrite its SHA or timestamp.

If a reviewed content divergence cannot be three-way merged cleanly, stop on that exact path and reconcile the conflict explicitly. Do not bless the unchanged public file with a refreshed private hash.

For a true conflict, use a release-local reviewed resolution file and pass it with `--resolutions <json>`. Each entry must name the path, choose `private` or `public`, give a substantive reason, and record `reviewedBy`. The preparer rejects unused/stale resolution entries and computes the resulting hashes itself.

The promotion manifest and promotion guard are authoritative for the reviewed private/public boundary.

When the promotion guard reports a mismatch, resolve only the exact missing, extra, or changed paths it reports.

Do not weaken the guard, downgrade its schema, fabricate divergence entries, or hand-select a smaller release surface merely to make the guard pass.

Historical private/public differences may remain only when they are explicit reviewed divergences.

## Public-write protection

Never bypass repository-owned public-write controls.

If local policy blocks the final authorized public push/PR step after the candidate is fully validated, stop at that boundary and return the exact candidate SHA and validation results for an authorized GitHub write channel.

A public-write block is not permission to redesign the release process.

## Persistent workspaces only

MartinLoop release, acceptance, and handoff work must use persistent repo-owned locations.

Preferred locations:

- `.release/<version>/`
- `_worktrees/<purpose>/`

Do not place release authority, evidence, manifests, patches, acceptance results, or agent handoff state in:

- `C:\\tmp`
- OS temp directories
- disposable scratch directories
- unnamed ad-hoc folders outside the repository

Temporary directories created internally by automated tests are fine; operator/release state is not.

## Verification rules

A gate is PASS only when its command completes successfully with an observed exit code of `0`.

Timeout, interrupted output, missing exit code, or truncated execution is UNKNOWN, not PASS.

On clean workspaces, build generated workspace dependencies before lint when package type declarations are emitted into `dist`.

Use the repository's existing scripts and dependency order. Do not edit source merely to compensate for an unbuilt clean checkout.

## Failure handling

When a required gate fails:

1. identify whether the failure is a product defect, stale test/guard, environment/bootstrap issue, or external infrastructure issue;
2. investigate only the exact failure;
3. make the smallest coherent correction;
4. rerun only invalidated gates plus any mandatory final release matrix.

Do not respond to one failing gate by starting a broad audit.

Do not reopen previously closed issues without a new deterministic reproduction.

Only a new deterministic P0 or launch-blocking P1 should interrupt a locked final-ship sequence.

## Stale tests and superseded controls

When a release controller or workflow is intentionally replaced, old tests that assert the retired protocol must be removed or replaced by the current controller's canonical regression suite.

Do not keep two executable test suites that assert mutually exclusive release protocols.

Historical release documentation may remain when clearly historical, but it must never be referenced as current operating guidance.

## Trusted publishing identity

The release controller validates current public `main` and atomically creates the paired root/MCP tags. It does not invoke npm publisher workflows as reusable workflows.

The root publisher (`.github/workflows/release.yml`) and MCP publisher (`.github/workflows/publish-mcp.yml`) run as their own workflows after a successful `Validate and cut paired release tags` controller run. This preserves the npm Trusted Publisher workflow identities and avoids the reusable-workflow caller mismatch that previously required temporary recovery triggers.

Do not reintroduce temporary version-pinned push recovery hooks. Do not change npm trusted-publisher governance merely to recover a normal release. A failed publisher may be rerun idempotently because each publisher checks whether its exact package version already exists before publishing.

## Release/version edits

Do not blindly replace version strings.

Before release/version changes, distinguish:

- current package version;
- live public baseline;
- pending release target;
- historical changelog entry;
- example command;
- link target;
- package metadata.

Historical release records must not be rewritten merely to align with the current release.

## Public hygiene

Anything promoted publicly must be appropriate for external users and contributors.

Do not promote:

- internal planning notes;
- private incident notes;
- customer-sensitive material;
- secrets or credentials;
- absolute workstation paths;
- internal repository coordination text;
- stale handoff/session files;
- fabricated publication or verification claims.

## Security and tenancy

Never weaken entitlement, authentication, token, workspace, tenant-isolation, receipt-integrity, or verifier behavior merely to make an acceptance test pass.

Any reproducible cross-tenant access is a P0.

Any deterministic false-success or broken receipt-integrity path that affects the release contract is launch-blocking until fixed.

## Completion rule

Once the locked release acceptance criteria are all green, stop testing and ship.

Do not invent additional gates after the defined acceptance matrix is satisfied.
