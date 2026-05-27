# AGENTS.md

## Purpose

This repository uses AI coding assistants for maintenance. Agents must treat this repository as a public open-source project.

## Setup

- Use `pnpm@10.33.0`.
- Install dependencies with `pnpm install --frozen-lockfile`.
- Run `pnpm test`, `pnpm lint`, `pnpm build`, `pnpm oss:validate`, and `pnpm public:smoke` before opening a pull request when relevant.
- For MCP package work, also run `pnpm --filter @martinloop/mcp verify:release`.

## Public Surface Rule

Everything committed to this repo must be appropriate for public users, contributors, package consumers, and external reviewers.

Do not commit:

- secrets, credentials, tokens, private URLs, or machine-specific paths
- planning notes, operator chat, unpublished roadmap language, or private conversation content
- customer-sensitive details
- copied dashboard output or account-specific setup material
- release-process notes that are not useful to public contributors
- generated reports or scratch artifacts that are not linked from public docs

## Contribution Standard

- Prefer small, auditable changes.
- Keep docs concise, user-centered, and accurate.
- Preserve functional examples or remove them if they no longer work.
- Keep README content focused on what MartinLoop is, how to try it, and where deeper docs live.
- Put detailed CLI, SDK, MCP, security, and concept explanations under `docs/`.

## Validation

Before opening a PR, run the checks that match the change:

```sh
pnpm test
pnpm lint
pnpm build
pnpm oss:validate
pnpm public:smoke
```

For public docs or package metadata changes, also run the repository public-surface tests and a grep scan for non-public process language. If a term is a real API field or source-code concept, keep it. If it appears in public copy as process language, rewrite it.
