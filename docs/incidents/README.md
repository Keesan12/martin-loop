# MartinLoop incident-report standard

This directory is the durable evidence ledger for product, release, integration, and process incidents.

## Canonical incident fields

Every incident must contain the existing release bug-ledger fields:

```text
BUG_ID=
SURFACE=
SEVERITY=P0/P1/P2/P3
REPRO_STEPS=
EXPECTED=
ACTUAL=
SOURCE_REPO=
LIKELY_OWNER=
USER_IMPACT=
EVIDENCE=
FIX_STATUS=
REGRESSION_PROOF=
```

For learning and prevention, incident reports should also include:

```text
FIRST_OBSERVED=
AFFECTED_RELEASES=
CATEGORY=PRODUCT/RELEASE/HARNESS/PROCESS/INTEGRATION/SECURITY
ROOT_CAUSE=
CONTRIBUTING_FACTORS=
CORRECTIVE_ACTION=
PREVENTIVE_CONTROL=
STATUS=CONFIRMED/OBSERVED/RESOLVED/WATCH
```

## Severity

- **P0** — trust/safety contract broken, auth or tenant boundary failure, false verified success, destructive behavior, published primary package unusable.
- **P1** — release blocker: normal first governed run broken, hidden provider default, unusable advertised MCP contract, materially broken install/run path, hosted sync/read model materially wrong.
- **P2** — important but not independently release-critical: harness defects, copy drift, recoverable workflow/process defects, test-environment contamination, stale planning state.
- **P3** — cosmetic/low impact.

## Evidence discipline

Use observable evidence. Where available, record exact repo, SHA, PR, package version, command, exit category, run/loop ID, expected/actual result, and independent ground truth. Do not call a timeout, blocked runner, or unexecuted check a PASS.

MartinLoop's own receipts are evidence artifacts, not sole acceptance authority when receipt truth, verifier truth, workspace binding, or persistence are under audit. Pair them with independent evidence such as `git diff`, filesystem state, child-process exit, verifier command, process list, and raw stdout/stderr.

## Ownership rule

- Core CLI, MCP, packaging, public promotion, release process -> `private OSS staging repository`.
- Atlas/SANSA/Trace Engine behavior and Engine planning authority -> `private engine repository`.
- Hosted auth, ingest, receipt verification, tenant/read-model behavior -> `private hosted control-plane repository`.
- Public repository is an output; corrective source work belongs upstream in the owning internal repository.
