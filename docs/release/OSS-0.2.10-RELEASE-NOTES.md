# martin-loop 0.2.10

MartinLoop `0.2.10` is the public trust hotfix for the root package. It closes the two audit findings that made receipts and operator guidance look dishonest: verifier receipt integrity and `--runs-dir` drift across the guarded flow.

## What changed

- `verification.completed` now reflects the MartinLoop-launched verifier only.
- Verification evidence now persists per-step launch state, exit code, timeout state, and concise command detail.
- If adapter output says a tool or verifier failed before execution but MartinLoop’s own verifier passed, MartinLoop now records that contradiction as a warning instead of presenting a silent clean pass.
- `doctor`, `session-start`, `preflight`, `run`, `dossier`, and `badge` now honor the same explicit `--runs-dir` target.
- `run --help` and `preflight --help` now exit cleanly before governed-flow checks.
- Public help/version output now reports the published root `martin-loop` version, and `bench` is not part of the public `0.2.10` CLI surface while the portable harness is being prepared.
- `--unsafe-allow-unguarded-run` remains available as an explicit local override when an operator intentionally needs to bypass the guarded flow for one run.
- The public root tarball still excludes the vendored CLI bin manifest, and the same `root-release-guard` remains in the release gate.

## Operator impact

- Use `runs verify`, `dossier`, or the MCP verification views when you need the full verifier story. They now show warnings plus step-level evidence instead of a single pass/fail sentence.
- Use `--runs-dir <path>` when you want one explicit Martin store across the guided flow, persisted evidence views, and badge generation.
- The public no-spend path is still `npx martin-loop run ... --proof`.

## Start here

```sh
npx martin-loop demo
cd martin-loop-demo
npx martin-loop doctor --runs-dir ~/.martin/runs
npx martin-loop session-start
npx martin-loop preflight "Summarize the demo workspace and confirm the verifier is green" --verify "npm test" --runs-dir ~/.martin/runs
npx martin-loop run "Summarize the demo workspace and confirm the verifier is green" --proof --verify "npm test" --runs-dir ~/.martin/runs
npx martin-loop runs verify --latest --runs-dir ~/.martin/runs
npx martin-loop dossier --latest --runs-dir ~/.martin/runs
```

## Validation

`0.2.10` is intended to ship through the same public root release gate the GitHub Actions release workflow runs:

- `pnpm lint`
- `pnpm test`
- `pnpm build`
- `pnpm public:copy-scan`
- `pnpm public:git-surface`
- `pnpm oss:validate`
- `pnpm public:smoke`
- `pnpm release:validate-local`
- `pnpm release:validate-local:install`
- `pnpm release:validate:platforms`
- `pnpm audit --prod --json`
