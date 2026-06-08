# MartinLoop 0.3.3 Release Notes

`0.3.3` hardens first-run onboarding and closes packaged-surface trust gaps discovered after `0.3.2`.

## What Changed

- Added `martin-loop start` as the first-run guided command.
- Added `martin-loop tour` as a compatibility alias for `start`.
- Help output now surfaces onboarding commands directly (`start`, `demo`, `doctor`).
- Install-time onboarding prompt now shows a deterministic command path:
  - `npx -y martin-loop@latest start`
  - `npx -y martin-loop@latest demo`
- Public facade smoke validation now asserts that `--unsafe-allow-unguarded-run` does not regress into a local receipt-gate `policy_blocked` failure on packaged installs.
- Updated public docs and quickstart examples to deterministic `npx -y martin-loop@latest ...` command forms.

## Why This Matters

- New users get a clear path immediately after install, without guessing command order.
- Governed runs remain default behavior: MartinLoop still enforces doctor/session-start/preflight receipts before live spend.
- Release validation now catches packaged CLI regressions earlier, before publish.

## Quick Check

```sh
npx -y martin-loop@latest start
npx -y martin-loop@latest demo
cd martin-loop-demo
npm install
npx -y martin-loop@latest doctor
npx -y martin-loop@latest session-start
npx -y martin-loop@latest preflight "Summarize the demo workspace and prove tests still pass" --verify "npm test"
npx -y martin-loop@latest run "Summarize the demo workspace and prove tests still pass" --proof --verify "npm test"
npx -y martin-loop@latest share --latest --json
```
