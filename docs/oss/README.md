# Martin OSS Core

Martin Loop is a governed AI coding-loop runtime. The core runtime is real and verified through the Phase 12 certification gate; the repo is now in Phase 13 release-candidate engineering, which means the focus is reproducibility, OSS boundary cleanup, and pilot readiness rather than new feature invention.

## What the OSS core includes today

- `@martin/contracts`: shared loop, policy, grounding, leash, budget, and rollback types
- `@martin/core`: the runtime controller, persistence layer, grounding scanner, leash engine, patch-truth scoring, and rollback restoration logic
- `@martin/adapters`: normalized Claude CLI, Codex CLI, and direct-provider or stub adapter surfaces
- `@martin/cli`: the local operator CLI for `run`, `inspect`, and `resume`
- `@martin/mcp`: the MCP server surface for `martin_run`, `martin_inspect`, and `martin_status`

## What is still outside the initial OSS promise

- The root workspace now exposes the `martin-loop` public package facade, but registry publication is still a later release step.
- `@martin/contracts`, `@martin/core`, and `@martin/adapters` are still marked `private` in their package manifests.
- The hosted control-plane and local dashboard remain in the repo, but they are not yet the finalized public OSS boundary.
- The benchmark harness remains a workspace-only RC surface under `benchmarks/` and is not part of the publishable CLI boundary yet.
- Final licensing, public package publishing, and managed-product packaging are still gated behind later Phase 13 to Phase 15 work.

That means this repo is ready for grounded engineering review and RC validation, but it is not yet claiming a finished public OSS release.

## Runtime truth the current core enforces

- Explicit policy phases: `GATHER`, `ADMIT`, `PATCH`, `VERIFY`, `RECOVER`, `ESCALATE`, `ABORT`, `HANDOFF`
- Grounding scans against repo anatomy before success is accepted
- Blocking leash behavior for unsafe verifier commands, file-scope violations, approval-boundary changes, and secret handling
- Provenance-aware accounting using `actual`, `estimated`, and `unavailable`
- Persisted attempt artifacts under `~/.martin/runs/<runId>/artifacts/attempt-XXX/`
- Patch-truth scoring plus rollback boundary and restore outcome artifacts for discarded or blocked repo-backed attempts

## Trust profiles

Martin currently exposes these execution profiles:

- `strict_local`: safest default for local repo work
- `ci_safe`: tighter CI-oriented behavior
- `staging_controlled`: controlled outbound or network allowances with approvals
- `research_untrusted`: looser network posture for research-oriented runs while still enforcing approval boundaries

## Accounting labels

Martin keeps cost provenance explicit:

- `actual`: reported directly by the provider or adapter settlement
- `estimated`: derived from pricing logic or modeled usage
- `unavailable`: the adapter could not produce a trustworthy number

Do not collapse those labels when building dashboards, docs, or public claims.

## Frozen public launch target

The current engineering memo freezes these public-launch targets for release planning:

- install target: `npm install martin-loop`
- CLI target: `npx martin-loop ...`
- SDK target: `import { MartinLoop } from "martin-loop"`

Those targets are now implemented in the root package facade and verified through a clean-install smoke test. During the current RC phase, the honest operator path still includes the repo-local workflow documented below and in the quickstart, because public registry publication and broader release packaging remain later steps.

## Reproducibility

From the repo root:

```bash
pnpm install
pnpm build
pnpm rc:validate
```

`pnpm rc:validate` runs the current RC matrix in an isolated temp home so fresh-home behavior is checked instead of depending on warmed `~/.martin` state. Use `pnpm rc:validate:install` when you also want the RC run to perform a clean `pnpm install --frozen-lockfile` first.

## RC gate commands

The current release-candidate gate is:

- `pnpm oss:validate`
- `pnpm public:smoke`
- `pnpm repo:smoke`
- `pnpm rc:validate`
- `pnpm pilot:prep:validate`
- `pnpm release:matrix:local`

`pnpm rc:validate` now includes the machine-checked release-surface audit in addition to the existing build, test, benchmark, provider-path, OSS-boundary, and control-plane checks.

## Where to go next

- [`docs/oss/QUICKSTART.md`](./QUICKSTART.md) for clone-to-first-run setup
- [`docs/oss/EXAMPLES.md`](./EXAMPLES.md) for grounded CLI and MCP examples
- [`docs/oss/OSS-BOUNDARY-REPORT.md`](./OSS-BOUNDARY-REPORT.md) for the current machine-checked OSS boundary and public-surface status
- [`docs/oss/RELEASE-SURFACE-REPORT.md`](./RELEASE-SURFACE-REPORT.md) for the current machine-checked release-surface audit
- [`docs/pilot/README.md`](../pilot/README.md) for the pilot-prep package that remains explicitly gated behind Phase 13 completion
- [`../../README.md`](../../README.md) for the repo-level RC status and workspace map
