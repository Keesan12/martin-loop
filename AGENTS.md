# Martin Loop OSS Agent Instructions

## Project Overview

Martin Loop OSS is the public local-first runtime, CLI, and MCP workspace for governed AI coding loops.

This repository is a public surface. Keep all docs, release notes, PRs, package metadata, examples, screenshots, comments, and changelogs suitable for public users and external review.

## Setup And Commands

- Use `pnpm@10.33.0`.
- Install dependencies with `pnpm install --frozen-lockfile`.
- Run the full test suite with `pnpm test`.
- Run the release matrix locally with `pnpm release:matrix:local`.
- Validate MCP release readiness with `pnpm --filter @martinloop/mcp verify:release`.
- Validate public package boundaries with `pnpm oss:validate`.

## Public Repo Surface Standard

- Rule: every public-facing repo file, release note, package README, GitHub release, npm metadata entry, public PR description, doc, example, screenshot, and changelog must be clean client-facing copy.
- Guardrail: preserve internal work and ideas in private handoffs, planning docs, release playbooks, or internal repos. Before publishing, editing, merging, or summarizing public material, scan for and remove internal repo names, local machine paths, private roadmap language, removed-branch/process notes, workflow plumbing, paid-tier plans, private implementation commentary, customer-sensitive details, and workspace chatter.
- Verification: final public-surface status must name the surface checked and the guardrail used, such as `pnpm exec node --test scripts/tests/mcp-release-docs.test.mjs`, a forbidden-term scan, `gh release view`, `npm view`, `rg`, or `pnpm oss:validate`.
- Rule: outreach/article export artifacts must never land as top-level files in the OSS repo root.
- Guardrail: keep publishable articles under `docs/posts/` if they belong in the public repo at all; otherwise keep them in the outreach workspace, not in the package/release surface.
- Verification: `pnpm oss:validate` and `scripts/tests/oss-boundary.test.mjs` must stay green after any content move.

## Release Workflow

- Publish public packages through GitHub Actions release workflows by default.
- When npm trusted publishing is connected, use GitHub Actions trusted publishing/OIDC only. Do not add, use, prefer, or fall back to npm publish tokens (`NPM_TOKEN`, `NODE_AUTH_TOKEN`, token selection, or local `npm publish`) unless Keesan explicitly approves an exception after trusted publishing is proven unavailable.
- If trusted publishing fails, debug the trusted-publisher setup, workflow identity, tag/ref trigger, package mapping, runner Node/npm version, and live npm/GitHub release state before changing release mechanics.
- Do not publish locally unless the workflow path is unavailable and the user explicitly approves a fallback.
- Keep the root `martin-loop` package version separate from the standalone `@martinloop/mcp` package version.
- For MCP releases, keep `packages/mcp/package.json`, `packages/mcp/server.json`, release docs, and published package smoke tests aligned.

## Code Style

- Prefer small, auditable changes.
- Keep public-facing language concise, user-centered, client-facing, and free of workspace/process chatter.
- Use existing scripts and tests before adding new release machinery.

## Safety And Security

- Treat credentials, local paths, private URLs, workspace names, and unpublished roadmap details as non-public.
- Do not add secrets, tokens, or machine-specific paths to tracked files.
- If a public artifact appears contaminated, clean or close it before merging.
