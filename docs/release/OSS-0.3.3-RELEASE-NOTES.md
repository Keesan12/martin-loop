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
- Public facade smoke validation now proves packaged `start` plus a healthy governed `run` from a clean temp install.
- Updated public docs and quickstart examples to deterministic `npx -y martin-loop@latest ...` command forms.
- `run` now auto-bootstraps doctor/session-start/preflight checks before enforcing the gate, so execution-ready environments proceed without manual setup churn.
- `phase session-start` now works as the documented compatibility alias for the command-center flow.

## Why This Matters

- New users get a clear path immediately after install, without guessing command order.
- Governed runs remain default behavior, but the default path is now execution-first: `run` auto-checks the governed prerequisites and only stops when preflight finds a real blocker.
- Execution-first behavior: if the environment is healthy, MartinLoop executes after auto-checks instead of stopping on missing local workflow-state markers.
- Release validation now catches packaged CLI regressions earlier, before publish.

## Quick Check

```sh
npx -y martin-loop@latest start
npx -y martin-loop@latest demo
cd martin-loop-demo
npm install
npx -y martin-loop@latest run "Summarize the demo workspace and prove tests still pass" --proof --verify "npm test"
npx -y martin-loop@latest share --latest --json
```
