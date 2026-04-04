# Project: Martin Loop v4 Controller Rebuild

## Purpose
Rebuild Martin Loop from a partially-real retry harness into a production-grade
evidence-driven execution controller. The previous implementation carried mock data in
production paths, embedded zips in the repo, and shallow fixes that didn't address structural
problems. This rebuild follows the v6 rebuild execution pack specification.

## Core Problem Being Solved
A "real control plane dashboard" requires a real persistence stack beneath it. The dashboard
is a read model — it can only show what the runtime writes. The rebuild addresses this in order:
clean repo → real persistence → real control plane.

## Tech Stack
- Language: TypeScript (strict)
- Package manager: bun
- Runtime packages: packages/contracts, packages/core, packages/adapters, packages/cli, packages/mcp
- Control plane: Next.js App Router (apps/control-plane)
- Local dashboard: Express + vanilla JS (apps/local-dashboard)
- Database (control plane): Supabase / Postgres
- Auth: Clerk
- Testing: Vitest
- Formatter: Prettier, 2-space indent

## Architecture Target (v4 System)
```
A. Contract Store   — immutable per run (contract.json)
B. Evidence Ledger  — append-only per attempt (ledger.jsonl)
C. Machine State    — mutable typed state (state.json)
D. Grounding Index  — repo anatomy (file map, symbol lookup)
E. Context Compiler — builds next attempt packet deterministically
F. Policy Engine    — state machine: GATHER→ADMIT→PATCH→VERIFY→RECOVER→ESCALATE→ABORT
G. Safety Leash     — blocking enforcement: filesystem, command, secret, spend
H. Control Plane    — read model over B+C, no mock data, Supabase-backed, Clerk-authed
```

## Canonical Runtime Files
- `packages/contracts/src/index.ts` — all shared types
- `packages/core/src/index.ts` — orchestration engine
- `packages/adapters/src/claude-cli.ts` — Claude CLI adapter
- `packages/cli/src/index.ts` — CLI entry point
- `packages/mcp/src/server.ts` — MCP server

## What Is Real (verified)
- Runtime orchestration, Claude subprocess execution, CLI flags
- Budget tracking, oscillation detection, git reset, scope enforcement
- Flat run persistence to ~/.martin/runs/*.jsonl
- Telemetry POST → JSONL append

## What Must Be Deleted
- apps/control-plane/lib/data/mock-control-plane-data.ts
- apps/local-dashboard/data/demo-data.js
- Embedded zip archives in repo root
- MartinLoop V3 3-31-2026/ directory

## Commands
- Typecheck: bun run typecheck (or node_modules/.bin/tsc --noEmit)
- Test: bun run test
- Lint: bun run lint
- Dev (control plane): bun run dev (from apps/control-plane)
- Eval: MARTIN_LIVE=true bun run eval (from benchmarks)
