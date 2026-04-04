# Martin Loop Dual-Track Design

## Product Shape

Martin Loop is organized as two coordinated tracks under one roadmap:

1. An OSS, CLI-first runtime that executes coding loops with explicit state, budget governance, failure classification, and verifier-driven exits.
2. A hosted, multi-tenant SaaS control plane that ingests Martin telemetry and turns it into finance, policy, billing, and operational visibility.

The system is coding-loop-first. It is not positioned as a generic workflow platform.

## Track A: OSS Runtime

The runtime is built as a TypeScript/Node monorepo with these package boundaries:

- `packages/contracts`: shared types, telemetry schema, lifecycle vocabulary, and runtime-to-SaaS interfaces
- `packages/core`: state machine, context distillation, failure taxonomy, cost governor, exit intelligence, and orchestration helpers
- `packages/adapters`: direct provider adapters, coding-agent CLI adapters, and adapter-facing request/response contracts
- `packages/cli`: operator entry points such as `martin run`, `martin bench`, and `martin inspect`
- `benchmarks`: fixtures and baseline runners that compare Martin against Ralph/Ralphy-style retry loops

### Runtime invariants

- Every run has a stable loop ID, workspace ID, project ID, and explicit lifecycle state.
- Every attempt generates structured events instead of relying on append-only transcript replay.
- Verification is separate from generation and can declare completion, non-completion, or escalation.
- Budget, token, and exit information is persisted in a machine-readable format from the first event onward.

## Track B: Hosted SaaS Control Plane

The control plane treats the OSS runtime as a data plane. It ingests telemetry, applies workspace policy, and presents multi-tenant visibility for finance and engineering stakeholders.

### Primary personas

- CFO / finance lead
- Engineering leader
- Operator / agent platform owner

### Primary control-plane jobs

- Explain what was spent vs. what Martin prevented.
- Show which loops are failing, regressing, or burning money.
- Let operators define and audit policy.
- Manage usage, billing, integrations, and exports.

### Navigation

- Overview
- Loops
- Savings
- Policies
- Integrations
- Billing
- Settings

## Shared Contract

The shared contract must stabilize early around:

- loop IDs, workspace IDs, project IDs, and team IDs
- loop lifecycle states and exit reasons
- iteration, intervention, and failure-class vocabulary
- token and spend accounting fields
- verifier results
- artifact metadata
- signed telemetry ingestion payloads

## Delivery Sequence

1. Finalize contracts, lifecycle vocabulary, and event schema.
2. Implement the OSS runtime alpha with CLI, adapters, and benchmarks.
3. Implement the hosted foundation with typed ingest routes, SaaS queries, and executive dashboards.
4. Add billing, alerts, exports, and control-plane hardening.

## Acceptance Standard

Martin is successful when it improves verified solve-rate under budget and makes that improvement legible to finance and engineering operators through the control plane.

