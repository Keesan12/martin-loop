# AGENTS.md

## Purpose

This repository uses AI coding assistants for maintenance tasks.
Agents must treat this repository as a public open-source project.

## Mandatory Local Workspace Rule

All MartinLoop repositories, clones, worktrees, temporary test repositories,
runner installations, durable test evidence, and agent-created working folders
on a maintainer machine must live under the maintainer's canonical workspace
root, as defined in the local environment.

Confirm the exact approved workspace root before beginning work on a machine.
This rule is non-negotiable.

Agents must not create, clone, copy, move, or continue MartinLoop work in:

- Desktop or any Desktop subfolder
- user-profile folders outside the approved workspace root
- Downloads or Documents outside the approved workspace root
- AppData
- operating-system Temp directories
- arbitrary `tmp-*`, scratch, cache, or one-off folders elsewhere on the machine
- consumer repositories used only for external testing

Use clearly named subdirectories beneath the approved root for every clone,
worktree, disposable test environment, self-hosted runner, and evidence folder.
Operating-system temporary files created automatically during a command are
allowed only while that command runs; they must not become durable repositories,
workspaces, evidence stores, or agent handoff locations.

Before creating any local folder, an agent must print and verify the intended
absolute path. If the path is outside the approved root, stop and correct it
before doing any work.

Agents must not instruct another agent or the maintainer to create a MartinLoop
workspace outside the approved root. Existing MartinLoop work discovered outside
the approved root must be preserved safely, moved or recreated beneath the
approved root, and removed from the old location only after all valid work is
confirmed on the correct remote branch.

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
