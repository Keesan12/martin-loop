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
