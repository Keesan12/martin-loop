# Martin Loop Master Roadmap

## Why This Roadmap Exists

Martin Loop has to solve two visible business problems and one hidden adoption problem at the same time:

1. Ralph-style loops waste tokens, time, and engineer attention because they often keep retrying without converging on a verified answer.
2. CTOs and CFOs need measurable ROI, or AI budgets will get cut before agentic workflows mature.
3. Teams will not trust autonomous loops without governance, security, and explainability.

This roadmap turns those requirements into a phased product plan that keeps the runtime, the local operator experience, and the hosted SaaS control plane aligned.

## Council Summary

### Executive / CFO signal

- Lead with actual spend, forecast, and confidence before any savings headline.
- Treat avoided spend and ROI as modeled values with explicit methodology and confidence.
- Show exceptions, approvals, and policy compliance above the fold.

### CTO / platform signal

- Prove Martin wins on verified solve-rate under budget.
- Separate runtime truth from dashboard polish.
- Add persistence, verifier boundaries, auditability, and signed telemetry early.

### Operator / engineer signal

- Show current attempt state, verifier output, burn rate, intervention choice, and exit reasoning.
- Make governance inputs visible before launch and preserved after the run.
- Keep local monitoring separate from executive reporting.

### Design / storytelling signal

- Tell the story in this order: waste, guardrails, intervention, comparison, economics.
- Keep visuals honest: label seeded, simulated, and modeled data.
- Make the product feel like a finance-and-governance control room, not a generic AI metrics board.

## Product Surfaces

Martin should continue to evolve as three connected surfaces:

### 1. Runtime

The CLI-first, provider-agnostic loop engine that governs coding work.

### 2. Local Operator Dashboard

The engineer-facing view for launching, monitoring, investigating, replaying, and exporting runs.

### 3. Hosted Control Plane

The executive and platform view for economics, governance, alerts, billing, and cross-team visibility.

## Phase Plan

### V2A: Trust, Demoability, and Product Clarity

**Goal:** Make Martin understandable, inspectable, and presentation-ready without faking runtime truth.

**Primary outcomes**

- Hosted dashboard redesign with executive-first IA:
  - `Overview`
  - `Operations`
  - `Economics`
  - `Governance`
  - `Billing`
  - `Admin`
- Local operator dashboard redesign with run-centric IA:
  - `Current Run`
  - `Timeline`
  - `Budget`
  - `Verifier`
  - `Interventions`
  - `Artifacts`
  - `Replay / Resume`
  - `Benchmark Lab`
- Governance input model made explicit in CLI, config, and UI mock surfaces.
- Shared seeded demo scenario used across local dashboard, hosted dashboard, benchmark story, and screenshots.
- Visual demo pack for non-technical reviews, GitHub, and investor/product storytelling.
- Public-repo cleanup for a Ralphy-style OSS presentation.

**Exit criteria**

- Both dashboards tell the same seeded story with honest labels.
- The local dashboard shows effective policy, current attempt state, and verifier output.
- The hosted dashboard distinguishes actual, forecast, and modeled values.
- The repo includes screenshots, diagrams, and a clean demo script.

### V2B: Runtime Hardening

**Goal:** Make Martin measurably better than Ralph-style looping on real coding tasks.

**Primary outcomes**

- Real adapter execution path for at least one direct-provider path and one agent-CLI path.
- Real verifier pipeline with build, test, lint, and review gates.
- Persistent run state, replay, and resumability.
- Predictive budget governor using current burn rate and likely next-attempt cost.
- Better intervention policy:
  - compress context
  - swap model
  - tighten scope
  - request approval
  - stop early
- Benchmark harness upgraded from seeded demo to reproducible task execution.
- Monte Carlo-style simulation suite for budget pressure, verifier failure, routing drift, and repeated non-convergence.

**Exit criteria**

- Martin can complete and stop runs using real verifier outcomes.
- Benchmarks compare Martin and Ralph baselines under the same caps.
- Simulation suite exposes failure and cost edge cases before release.

### V2C: SaaS Data Foundation

**Goal:** Turn the hosted dashboard from a seeded shell into a defensible control plane.

**Primary outcomes**

- Signed telemetry ingestion endpoint with idempotency and key rotation.
- Workspace, project, and run scoping with RBAC.
- Immutable usage ledger and reconciliation model.
- Rollup/projector pipeline for Overview, Operations, Economics, and Governance views.
- Alerts, approvals, and audit history.
- Billing and subscription state connected to real usage accounting.

**Exit criteria**

- Hosted views are driven by persisted tenant data instead of static fixtures.
- Governance and approval flows are queryable and auditable.
- Finance-facing numbers have provenance and freshness metadata.

### V3: Enterprise Intelligence and Policy Systems

**Goal:** Make Martin a system of record for AI operational control.

**Primary outcomes**

- Showback and chargeback by team, project, and workspace.
- Forecasting and anomaly detection for spend, solve-rate, and policy drift.
- Savings-confidence methodology with benchmark-backed attribution.
- Policy simulation and policy-as-code workflow.
- Enterprise controls:
  - SSO / SCIM
  - longer audit retention
  - artifact access control
  - SIEM / warehouse exports
- Portfolio memory and dynamic model routing across repeated task classes.
- Updated business collateral:
  - one-pager
  - deck
  - financial model
  - GTM messaging

**Exit criteria**

- Martin can justify AI spend at the team and portfolio level.
- Executives can compare actual spend, forecast, modeled avoidance, and confidence by org slice.
- Platform teams can evolve policy safely with simulations and audit trails.

## Cross-Cutting Tracks

### Security and Governance

This track begins in V2A and deepens in every phase.

- V2A:
  - label modeled values clearly
  - show policy provenance
  - surface signed-ingest, audit, and key-rotation status as UI concepts
- V2B:
  - add runtime allowlists, approval hooks, and verifier separation
- V2C:
  - add tenancy, RBAC, rotation, immutable ledger, retention controls
- V3:
  - add enterprise identity, export controls, simulation-backed governance

### Visual and Demo Assets

- V2A:
  - screenshots
  - governance setup view
  - Ralph vs Martin comparison board
  - runtime and telemetry diagrams
  - Product Hunt / GitHub montage
- V2B:
  - live benchmark output visuals
  - operator replay and investigation demos
- V2C:
  - real control-plane walkthrough visuals
- V3:
  - updated deck, one-pager, and CFO-ready reporting visuals

### Public Repo and Adoption

- Keep the repo simple, inspectable, and easy for models to ingest.
- Separate seeded demo assets from runtime truth.
- Preserve a local-first path so users can validate Martin without cloud dependency.
- Align the repo presentation with a Ralphy-like developer experience:
  - quickstart
  - why Martin exists
  - benchmark story
  - screenshots
  - clean CLI examples

## Metrics That Matter

### Runtime truth metrics

- verified solve-rate
- actual spend
- actual tokens
- iteration count
- verifier failure rate
- early-stop rate
- approval-trigger rate

### Executive interpretation metrics

- forecast spend
- budget variance
- policy compliance
- telemetry coverage
- modeled avoided spend
- modeled ROI multiple
- confidence bands

## Execution Order

1. Execute V2A first because it clarifies the story, reduces product ambiguity, and creates honest demo assets.
2. Execute V2B next because Martin has to win on actual task outcomes, not just interface clarity.
3. Execute V2C after the runtime and seeded story stabilize, so the SaaS data model reflects real product truth.
4. Execute V3 after the system can already prove runtime value and data credibility.

## Plan Decomposition

This roadmap should drive separate implementation plans:

1. `2026-03-27-martin-v2a-trust-demo-implementation-plan.md`
2. `2026-03-27-martin-v2b-runtime-hardening-plan.md`
3. `2026-03-27-martin-v2c-control-plane-data-foundation-plan.md`
4. `2026-03-27-martin-v3-enterprise-intelligence-plan.md`

Only V2A should be executed first in the next implementation session.
