# Swarm Hosted v1 Native Consumer Contract

## Status and boundary

This document is the conformance handoff for the Control Plane owner and the customer SaaS/dashboard owner. It defines what those product surfaces must consume; it does not claim that ingestion, rendering, deployment, or any live hosted surface exists.

The sole accepted source is the checked-in, production-exporter-derived fixture bundle. Consumers must validate against that bundle without copying Core authority or inventing a second event, receipt, verification, or parent-outcome authority.

```ini
SCHEMA=martin.swarm-hosted.v1
FIXTURE=packages/contracts/tests/fixtures/swarm-hosted-v1-cases.json
CHECKSUM_FILE=packages/contracts/tests/fixtures/swarm-hosted-v1-cases.sha256
CHECKSUM_SHA256=c66f4d68908e89d597a5e9854d03157b59c756a25a5b48ae9d74a0542d0446f1
SYNC_ROUTE=/api/swarms/sync
SYNC_ROUTE_OWNERSHIP=CLOSED_NATIVE_OWNER_ONLY
TENANT_BINDING=workspaceId+projectId
TRANSPORT_AUTH=distinct_hosted_transport_key+hmac-sha256
IDEMPOTENT_REPLAY=exact_canonical_body_same_envelopeId
COMPETING_EVIDENCE=409_CONFLICT
SANSA_DERIVATIONS=observed,deterministic_graph_derivation
PARENT_AUTHORITY=sealed_parent_receipt_only
CHILD_SUCCESS_CANNOT_VERIFY_PARENT=TRUE
HOSTED_CONSUMER_APPEND_LOCAL_EVENTS=PROHIBITED
HOSTED_CONSUMER_REWRITE_RECEIPTS=PROHIBITED
HOSTED_CONSUMER_AUTHORIZE_PARENT_OUTCOMES=PROHIBITED
NATIVE_ENDPOINT=UNKNOWN_DEFERRED
ATLAS_SANSA_INGESTION=UNKNOWN_DEFERRED
DASHBOARD_UI=UNKNOWN_DEFERRED
SUPABASE=UNKNOWN_DEFERRED
LOVABLE=UNKNOWN_DEFERRED
WEBSITE=UNKNOWN_DEFERRED
DEPLOYMENT=UNKNOWN_DEFERRED
PUBLIC_WRITES=UNKNOWN_DEFERRED
PROVIDER_RUNS=UNKNOWN_DEFERRED
PACKAGE_VERSION=UNKNOWN_DEFERRED
RELEASE=UNKNOWN_DEFERRED
```

## Consumer contract

Before use, verify the exact fixture bytes against the checksum file, parse only `martin.swarm-hosted.v1`, and run the strict hosted-envelope validator. Valid cases cover a verified 15-agent swarm, stopped and needs-review outcomes, failed global verification, and reassigned recovery. Marked tampered copies are rejection cases, never accepted evidence.

The envelope keeps child, global-verifier, and parent authority separate:

- `sourceIdentities` binds the authenticated parent receipt, evidence index, and event-chain head.
- `topology` preserves task, agent, child-run, and attempt identities and their planned/effective assignments.
- `events` contains allowlisted projections with exact persisted idempotency identity and ordered `eventId`/`sequence` evidence references; it never carries raw event payloads.
- `taskVerificationState`, `globalVerification.state`, `receiptIntegrityState`, and `parentOutcome.state` are independent claims and must remain independent in storage and UI.
- A verified parent is valid only when the sealed parent receipt says verified and the bound task, global-verifier, receipt-integrity, and final parent-event claims all agree.

Fifteen successful children are insufficient to infer `SWARM_VERIFIED`. Hosted consumers may display authenticated claims, but may not append local Core events, rewrite receipts, promote child state into parent state, or authorize a different parent outcome.

## Tenant and route ownership

`/api/swarms/sync` is a closed route owned by the native Control Plane surface. It is not a generic public JSON endpoint. Before persistence, the native owner must authenticate the caller and bind the authenticated tenant to both `swarm.workspaceId` and `swarm.projectId`. Missing or mismatched bindings reject before any mutation. The dashboard may read only records authorized for that same tenant binding.

The Core contract does not prescribe a database schema. The native owner must preserve the envelope, canonical-body identity, tenant binding, and replay/conflict decision without creating a second source of truth.

## Transport authentication and replay

The hosted transport signature uses `hmac-sha256` and a domain-separated hosted transport key identity. It is distinct from the local receipt-integrity signature and exposes only the hosted key ID and locator hash, never secret material. Native ingestion must authenticate the exact canonical transport body before accepting it.

An exact canonical-body replay with the same `envelopeId` is idempotent and returns the existing accepted result. A different canonical body, source identity, signature, or evidence set competing for the same governed swarm identity is a conflict and returns `409`; it must not overwrite, merge, or reinterpret the existing record.

## Atlas, SANSA, and dashboard projections

Atlas, SANSA, and dashboard consumers derive from the same validated envelope. They do not read local Core files or independently reconstruct authority.

SANSA supports only the frozen derivation kinds:

- `observed`: a fact directly bound to exact hosted event evidence.
- `deterministic_graph_derivation`: a fact derived from the validated task/agent/child graph and exact ordered evidence references.

Every fact keeps its `eventId` and `sequence` evidence. Generic retries, inferred recovery, invented failure links, and unbound graph edges remain absent. Blocking dependencies and failure-to-reassignment-to-new-attempt-to-recovery paths must reproduce the frozen projections byte-for-byte.

## Explicitly deferred capabilities

All live behavior remains `UNKNOWN_DEFERRED` until the owning product surface implements the contract and proves it against the frozen cases. This includes the native endpoint, Control Plane ingestion, Atlas/SANSA ingestion, dashboard UI, Supabase, Lovable, website behavior, deployment, public writes, provider runs, package/version changes, and release work.

No item in this handoff authorizes application-code copying, endpoint creation in Core, network calls, provider spend, public repository changes, package publication, deployment, or release activity. Each capability requires its own scoped authorization and live verification.
