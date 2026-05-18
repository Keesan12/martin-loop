# Staging Checklist

This checklist is for pilot-prep only. It does not authorize Phase 14 start by itself.

## RC Gate

- [ ] `pnpm rc:validate` is green on the accepted RC baseline
- [ ] `pnpm release:matrix:local` is green on the operator machine
- [ ] `pnpm pilot:prep:validate` is green

## Cross-Platform Evidence

- [ ] Windows evidence attached
- [ ] macOS evidence attached
- [ ] Linux evidence attached

## Pilot Safety Envelope

- [ ] default trust profile remains `strict_local`
- [ ] pilot task selection is low-risk and repo-scoped
- [ ] budgets are still hard-capped
- [ ] escalation path is agreed
- [ ] stop-using criteria are agreed

## Operator Materials

- [ ] operator runbook reviewed
- [ ] incident and rollback runbook reviewed
- [ ] artifact review template accepted
- [ ] success and failure scorecard accepted
