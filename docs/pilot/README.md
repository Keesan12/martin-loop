# Phase 13 Pilot Prep Package

Phase 14 has not started. This package is preparation only.

Use this directory to prepare the staged pilot without accidentally turning prep work into launch work.

## Package Contents

- [PILOT-DEFAULTS.md](./PILOT-DEFAULTS.md)
- [ARTIFACT-REVIEW-TEMPLATE.md](./ARTIFACT-REVIEW-TEMPLATE.md)
- [STAGING-CHECKLIST.md](./STAGING-CHECKLIST.md)
- [SUCCESS-FAILURE-SCORECARD.md](./SUCCESS-FAILURE-SCORECARD.md)
- [../ops/OPERATOR-RUNBOOK.md](../ops/OPERATOR-RUNBOOK.md)
- [../ops/INCIDENT-AND-ROLLBACK-RUNBOOK.md](../ops/INCIDENT-AND-ROLLBACK-RUNBOOK.md)

## Entry Criteria Before Pilot Start

Pilot start is still blocked until all of the following are true:

- Windows evidence is green and attached
- macOS evidence is green and attached
- Linux evidence is green and attached
- `pnpm rc:validate` is green on the accepted RC baseline
- the operator and incident runbooks are reviewed and accepted
- the pilot defaults, artifact review template, staging checklist, and scorecard are finalized

## What This Package Does

- freezes the recommended pilot defaults
- standardizes how operators review artifacts
- makes the staging checklist explicit
- defines the success and failure signals for pilot review

## What This Package Does Not Do

- start Phase 14
- widen access
- relax trust profiles
- replace runtime artifacts with prose summaries
