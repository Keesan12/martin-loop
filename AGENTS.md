# MartinLoop Agent Operating Rules

These rules are mandatory for every AI agent, automation, contributor, and coding session working on MartinLoop.

## Repository authority

 is the sole development authority.

 is a public distribution repository. It is never the primary development repository.

## Mandatory internal-first sequence

Every code change must follow this sequence:

1. Start from the latest .
2. Create a private feature branch.
3. Implement and test the change privately.
4. Commit and push the private branch.
5. Open a private PR into .
6. Pass all required internal checks.
7. Fix all regressions.
8. Prove the real MartinLoop workflow works.
9. Merge the private PR only after explicit approval.
10. Record the private merge commit SHA.
11. Verify fresh  is clean and healthy.
12. Create a clean public-staging branch from the latest public .
13. Transfer only the reviewed public-safe diff from the private merge.
14. Run public tests and public-surface guards.
15. Push the public-staging branch.
16. Open a public PR.
17. Merge publicly only after hosted checks pass and explicit approval is given.

## Prohibited actions

Agents must never:

- develop directly in ;
- use public  as the implementation authority;
- push unmerged private feature commits to the public repository;
- create public staging before the private PR is merged;
- resolve implementation conflicts only in a public-staging branch;
- bypass or weaken the public-write hook;
- ask the user to bypass the hook for unfinished work;
- push directly to public ;
- merge a stale public branch wholesale;
- declare public readiness while private  is broken;
- promote code without a recorded private merge SHA;
- publish npm, tags, native assets, or GitHub Releases before public merge approval.

## Required internal health proof

Before public staging, a fresh worktree of private  must prove all packages build and test clean, portability and copy-scan pass, git diff --check passes, no conflict markers exist, martin doctor works, preflight and governed run succeed, receipt is created and readable, verification succeeds, status survives restart, and separate workspaces remain isolated.

## Public promotion evidence

Every public-staging branch must include a promotion manifest at  containing privateRepository, privateMergeSha, privateMainShaValidated, publicBaseSha, promotedBy, validatedAt (ISO-8601), and internalHealthPassed: true. Public promotion is blocked when this manifest is absent, malformed, or reports failed internal health.

## Stop condition

When any required step is missing, stop. Do not improvise around repository boundaries. Do not treat the hook as an inconvenience. Report the missing prerequisite and remain in the private repository.

---

# AGENTS.md

## Purpose

This repository uses AI coding assistants for maintenance tasks.
Agents must treat this repository as a public open-source project.

## Public Surface Rule

Everything committed to this repo must be appropriate for public users, contributors, package consumers, and external reviewers.

Do not commit:

- secrets, credentials, tokens, private URLs, or machine-specific paths
- internal planning notes or non-public roadmap language
- customer-sensitive details or unpublished commercial strategy
- copied private conversation content
- release-process notes not useful to public contributors

## Setup

Use pnpm.

```sh
pnpm install --frozen-lockfile
pnpm test
pnpm lint
pnpm build
```

## Contribution Standard

Prefer small, auditable changes. Keep docs concise, user-centered, and accurate.

## Before Opening a PR

```sh
pnpm test
pnpm lint
```

## Documentation Style

Write for developers discovering MartinLoop for the first time.
Explain what the tool does, how to install it, how to run it,
and how to verify results.

## Proof Receipt Design Lock

MartinLoop proof-card SVGs must stay in the CLI receipt style:

- dark terminal canvas
- line-based layout
- monospaced evidence rows
- semantic green for verified/pass states
- semantic red for failed, missing, or boundary states

Do not change proof receipts into rounded cards, blue palettes, gradients,
certificate layouts, dashboard cards, or decorative marketing graphics unless
the maintainer explicitly asks for that change and receives side-by-side
visual renders before approval.

## Release/version editing barrier

Agents must not update release versions, release notes, README release links, version ledgers, package manifests, or public-facing release docs by ad-hoc search/replace.

Before changing any release/version file, the agent must produce and follow a release matrix containing:

- root package version
- standalone MCP package version
- previous public root version
- previous public MCP version
- intended release branch
- intended target branch
- expected tag names
- expected npm package names
- files expected to change
- files explicitly not expected to change
- source of truth for each value

The release matrix must be derived from existing package manifests, release plan docs, git tags, current branch, and npm/package metadata where applicable. If any value conflicts, the agent must stop and report the conflict instead of guessing.

Agents must not blindly replace old versions with new versions. Every changed occurrence must be classified as one of:

- current release version
- previous/live public baseline
- next planned version
- historical changelog entry
- example command
- URL/link target
- package manifest value

Historical entries must not be rewritten unless the task explicitly says to correct history.

"Current version" and "next planned version" are different fields. Updating one does not automatically update the other.

Before staging release/version changes, the agent must show the release matrix, a diff of changed release files, and a per-file explanation of why each changed line is correct. The agent must then run the release/version consistency check if present, or manually grep all old and new version strings and explain every remaining occurrence.

No release/version commit may be made if it contains placeholder release claims, fabricated publication status, private repository paths, duplicated or contradictory version statements, mechanically-replaced "next planned" values, or test claims without exact commands and exit codes.

If context is running low before validation is complete, the agent must push a clearly named remote recovery branch and stop. It must not rush an incomplete release commit onto the source branch.

## Public repo hygiene — pre-commit scan

Before committing staged content to any public-facing repo, scan for:

- local absolute filesystem paths
- internal repo names, handoff notes, session state, or planning docs
- fabricated publication status or unpublished release claims
- local-only worktree references or machine-specific dependencies
- screenshots, logs, or transcripts that reference private systems

If any are found, stop and sanitize the staged content before committing.

## Verification completion — INC-001

A lint, build, test, smoke, or release command may only be reported as **passed** when its operating-system exit code was **observed** and equals `0`.

A terminal timeout, stream timeout, truncated log, missing exit code, or agent-session interruption is **UNKNOWN**, never PASS.

**Required reporting pattern:**

```bash
pnpm lint;  echo LINT_EXIT:$?
pnpm build; echo BUILD_EXIT:$?
pnpm test;  echo TEST_EXIT:$?
```

The actual exit code must appear in the governed receipt. Timeouts must be rerun or recovered from persisted governed command evidence before continuing.

UNKNOWN has the same release authority as FAILED. Neither may be overridden without rerunning verification and observing exit code 0.

## Release blocker inventory — INC-002 / Issue #86

During the 0.5.1 RC, the release process fell into a serial blocker loop: run one gate, stop at the first failure, patch it immediately, rerun, then discover the next blocker. This caused avoidable context switching, token/tool burn, and regression risk.

This workflow is prohibited for all future release-closing work.

For any RC, public promotion, package release, or multi-surface ship, agents must use these phases:

### Phase 1 — Audit only

- Freeze source changes.
- Run the complete applicable release matrix.
- Record every gate as PASS, FAIL, UNKNOWN, or N/A.
- Continue through independent gates after failures instead of stopping on the first failure.
- Group failures by root cause.
- Produce one complete blocker inventory before editing source.
- Do not patch during this phase.

Required audit output:

```text
AUDIT_COMPLETE=YES
TOTAL_BLOCKERS=<n>
BLOCKERS_GROUPED_BY_ROOT_CAUSE=YES
```

### Phase 2 — Repair by root-cause cluster

Only after the blocker inventory is complete, repair grouped causes in this order unless dependency order requires otherwise:

1. product/runtime correctness
2. package/facade correctness
3. MCP/MCPB correctness
4. release metadata/version consistency
5. stale tests/guards/docs

Commit and push each coherent repair slice. Do not add features, redesign architecture, or perform unrelated cleanup during release closure.

### Phase 3 — Clean RC

After repairs, run the entire applicable release matrix again from the top with no source edits during the run.

If anything fails, first produce the remaining blocker inventory again. Do not return to first-failure patching.

A release may advance only when:

```text
CLEAN_RC=PASS
```

### Phase 4 — Ship and verify

Only after the clean RC is green may the release proceed to version alignment, artifact packing, publication, tags/releases, and fresh-install verification.

If an agent begins fixing failures before the full blocker inventory is complete, stop the repair work and return to audit-only mode.

This rule is internal engineering process. Do not copy incident history, private repository details, or internal release-management notes into public user-facing documentation.