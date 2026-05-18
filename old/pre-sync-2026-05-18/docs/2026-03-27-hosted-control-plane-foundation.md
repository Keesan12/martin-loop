# Hosted Control Plane Foundation

## Goal

This note turns the approved dual-track plan into a buildable boundary between the OSS Martin runtime and the hosted control plane. The runtime remains the data plane for loop execution. The hosted product is a multi-tenant control plane that ingests runtime facts, applies workspace policy, and produces finance and operator views without taking over execution.

The key implementation rule is simple: the runtime emits canonical facts, and the control plane owns derived views.

## Control Plane Contract

`packages/contracts` should become the meeting point between runtime and dashboard work. The contract should be versioned, append-only, and usable without any direct dependency on control-plane UI code.

### Runtime responsibilities

- Execute loops, attempts, verification, and local budget enforcement.
- Emit immutable identifiers and lifecycle events.
- Attach artifact references and verifier outcomes.
- Retry telemetry delivery with idempotent envelopes.
- Never depend on control-plane page state to complete a run.

### Control-plane responsibilities

- Authenticate workspace-scoped ingest keys.
- Validate, store, and project telemetry into queryable models.
- Resolve tenant ownership, policies, alerts, approvals, and billing state.
- Serve dashboard queries, exports, and audit trails.
- Compute rollups such as spend, savings, and policy violations from ingested facts.

### Minimum canonical envelope

Every ingest payload should include:

- `schemaVersion`
- `workspaceId`
- `projectId`
- `environment`
- `source` metadata such as runtime version, adapter, provider, and model
- `ingestKeyId`
- `envelopeId` or idempotency key
- ordered events with `eventId`, `loopId`, `attemptId` when applicable, `emittedAt`, `sequence`, and typed payloads

The event set should cover:

- run lifecycle
- attempt lifecycle
- verification result
- budget or usage delta
- approval requested or resolved
- artifact published

The runtime should not send org membership, billing totals, alert state, or dashboard-specific aggregates. Those belong to the control plane.

## Ingestion Pipeline

The first hosted foundation should use a narrow pipeline:

1. The runtime batches versioned telemetry envelopes and signs them with a workspace-scoped ingest key.
2. `app/api/telemetry` authenticates the key, validates schema and ordering, and rejects duplicates by idempotency key.
3. The control plane persists both the raw envelope and canonical event rows.
4. Projectors build loop snapshots, workspace rollups, approval records, alert inputs, and usage ledger entries.
5. Query models back the dashboard pages and scheduled jobs evaluate alerts, quotas, and billing periods.

This keeps ingestion stable even while dashboard pages evolve. It also lets runtime and hosted teams work in parallel against the same event vocabulary.

## Multi-Tenant Model

The minimum hosted tenancy model should be:

- organization: billing and ownership boundary
- workspace: operational boundary for ingest keys, policies, integrations, and dashboards
- project: grouping for repo, team, or environment slices inside a workspace
- loop run: unit of execution
- attempt and event: execution detail records

Recommended minimum roles:

- `org_owner`
- `workspace_admin`
- `operator`
- `finance_viewer`

Tenant resolution should happen from the ingest key and workspace context, not from user-supplied org identifiers inside telemetry. Every stored run, artifact, approval, alert, and ledger entry must carry `workspaceId` and `projectId` so queries and exports stay partition-safe from day one.

## Billing And Metering Flow

Billing should be derived from an immutable usage ledger, not from dashboard snapshots.

The foundation flow is:

1. The runtime emits usage deltas and final run summaries with provider, model, tokens, and actual cost.
2. Ingestion normalizes those events into usage ledger entries keyed by workspace, project, loop, and billing period.
3. A billing job aggregates ledger entries into period summaries and exportable invoice views.
4. Savings projection separately computes attributed savings from verified outcomes and declared ROI assumptions.
5. The billing page reconciles billed usage with savings attribution by linking both views back to the same loop and project identifiers.

This supports predictable cost and auditability early, while allowing polished self-serve billing to arrive later.

## Page Responsibilities

The hosted app should stay thin and opinionated around the approved navigation.

- `Overview`: workspace KPIs, current spend, attributed savings, active alerts, and pending approvals
- `Loops`: run explorer, timeline, attempt details, artifacts, exit reason, and investigation entry point for runaway loops
- `Savings`: CFO-ready rollups, attribution assumptions, verified savings lineage, and CSV export
- `Policies`: budgets, guardrails, approval rules, quota settings, and policy audit history
- `Integrations`: ingest keys, Slack or webhook destinations, CSV export setup, and connector health
- `Billing`: usage ledger views, pricing summary, billing-period rollups, and spend-versus-savings reconciliation
- `Settings`: organization, workspace, project, member, role, retention, and key-rotation controls

The approval queue does not need its own top-level section in the first cut. It should surface in `Overview`, drill into `Loops`, and be configured from `Policies`.

## Deferred From This Foundation

The following should stay out of the first hosted control-plane foundation:

- managed execution of loops from the SaaS product
- broad provider and enterprise connector coverage beyond the first workflow needs
- full secrets vault and complex provider brokering
- polished self-serve payments and subscription management
- advanced anomaly detection, custom alert builders, and deep forecasting
- cross-workspace portfolio analytics beyond basic organization rollups
- heavy transcript hosting requirements that exceed artifact references and metadata

## Decision

Treat the hosted dashboard as a real but thin control plane, built in parallel with the OSS runtime around a shared contract-first boundary. The runtime team should optimize for canonical event emission and delivery guarantees. The dashboard team should optimize for ingest, projection, tenancy, and ledger-backed reporting. Both tracks meet in `packages/contracts`, not through page-specific assumptions.
