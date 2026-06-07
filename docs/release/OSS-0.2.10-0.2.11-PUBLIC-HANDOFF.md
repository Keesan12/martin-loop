# Public Root Release Handoff: `martin-loop@0.2.10` -> `martin-loop@0.2.11`

## Scope

This note captures the public root-package recovery lane that started with the verifier-trust hotfix and ended with the selector-parity follow-up. It is intentionally limited to the public `martin-loop` root package. The standalone `@martinloop/mcp` line stayed separate throughout this work.

## Public release truth

### `martin-loop@0.2.10`

- Public PR: `Keesan12/martin-loop#82`
- Merge commit on public `main`: `f821fb01405c9d31172cfcb52e7a69ecce5b02f2`
- Git tag / GitHub release: `v0.2.10`
- Release workflow: `https://github.com/Keesan12/martin-loop/actions/runs/27077494566`
- npm truth after publish: `martin-loop@0.2.10`

What `0.2.10` fixed:

- verifier receipts now fail closed on MartinLoop's own launched verifier instead of trusting adapter summaries
- verification warnings and step evidence persist through CLI and MCP views
- `--runs-dir` handling is consistent through the guarded flow
- public help/version surfaces were cleaned so the root package reports the shipped version honestly

### `martin-loop@0.2.11`

- Public PR: `Keesan12/martin-loop#83`
- Merge commit on public `main`: `993003709fce5afeade4266cabf73cafc1bfef19`
- Git tag / GitHub release: `v0.2.11`
- Release workflow: `https://github.com/Keesan12/martin-loop/actions/runs/27078739109`
- npm truth after publish: `martin-loop@0.2.11`

What `0.2.11` fixed:

- `martin-loop runs verify --latest` now works on the packaged public CLI
- root README, MCP README, changelog, and release notes now point at the current root release line
- the public docs test harness now validates clean, runnable patch-release notes instead of dragging forward stale release-note assumptions that no longer fit a narrow patch

## Public files changed in the `0.2.11` lane

- `README.md`
- `CHANGELOG.md`
- `package.json`
- `docs/release/OSS-0.2.11-RELEASE-NOTES.md`
- `packages/cli/src/index.ts`
- `packages/cli/tests/cli.test.ts`
- `packages/cli/tests/operator-commands.test.ts`
- `packages/mcp/README.md`
- `scripts/tests/mcp-release-docs.test.mjs`

## Verification performed for `0.2.11`

Focused verification:

- `pnpm --filter @martin/cli exec vitest run tests/operator-commands.test.ts tests/cli.test.ts`
- `node --test scripts/tests/mcp-release-docs.test.mjs scripts/tests/readme-public-surface.test.mjs`

Full public release gate:

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

Gate outcome:

- all commands above passed on the exact `0.2.11` candidate commit
- production dependency audit reported `0` known vulnerabilities
- public copy scan and public git-surface checks passed

## Key evidence artifacts

`0.2.10` release evidence:

- release handoff: `C:\Users\Torram\AppData\Local\Temp\martin-loop-handoffs\public-0.2.10-release-handoff-2026-06-06.md`
- full RC gate logs: `C:\Users\Torram\AppData\Local\Temp\martin-0.2.10-rc-gate-r3-20260606-192823`
- pre-publish Windows trust repro: `C:\Users\Torram\AppData\Local\Temp\martin-live-codex-0.2.10-final-42600176483148289c31650c774ad39f\evidence\live-codex-summary.json`
- post-publish packaged-artifact repro: `C:\Users\Torram\AppData\Local\Temp\martin-live-codex-0.2.10-postpublish-e930a1974cbd4b8e90582ff04f082c21\evidence\live-codex-summary.json`

`0.2.11` release evidence:

- full RC gate logs: `C:\Users\Torram\AppData\Local\Temp\martin-0.2.11-rc-gate-20260606-203748`
- packaged selector-parity repro: `C:\Users\Torram\AppData\Local\Temp\martin-0.2.11-selector-repro-1f97b0096d054faba00ad5b5e1a2b031\app\evidence\selector-parity-summary.json`

What the packaged `0.2.11` repro proves:

- the installed tarball honors an explicit `--runs-dir`
- `runs verify --latest` resolves to the same loop as `runs verify --loop-id <id>`
- `dossier --latest` resolves to that same loop and shows the same verification steps

## Public hygiene / contamination outcome

- public root release docs and README surfaces were updated to `0.2.11`
- public copy scan passed after the final release-note/readme alignment
- no new public release copy was shipped with internal repo names or local machine paths

## What stayed intentionally out of scope

- no standalone `@martinloop/mcp` publish work was folded into this lane
- no broader `0.2.11` stabilization work was pulled into the root patch beyond selector parity and release-surface truth
- no internal mirror cleanup or branch pruning is included in this note

## Remaining follow-on work for the next engineer

Carry these into the next public root lane rather than reopening `0.2.11`:

1. Broader Codex host/platform diagnostics for Windows, Linux, and WSL, especially clearer `environment_mismatch` guidance.
2. Additional counterswarm-driven retesting on live Windows Codex complaint paths against `martin-loop@0.2.11`.
3. Public `bench` implementation using a portable bundled harness only, not workspace-only dependencies.
4. Any remaining docs/help parity work that is broader than the narrow selector fix already shipped here.

## Suggested next-session skills

- `handoff`
- `gh-fix-ci`
- `security-best-practices`
- `superpowers:verification-before-completion`
