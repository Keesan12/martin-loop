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
