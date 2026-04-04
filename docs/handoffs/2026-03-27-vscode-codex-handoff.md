# Martin Loop VS Code Handoff

Date: 2026-03-27  
Prepared from: Codex desktop session in `C:\Users\Torram\OneDrive\Documents\Codex Main\Setup Stuff\martin-loop`

## 1. Root Path And Starting Files

Repo root:

`C:\Users\Torram\OneDrive\Documents\Codex Main\Setup Stuff\martin-loop`

Open these first:

- `C:\Users\Torram\OneDrive\Documents\Codex Main\Setup Stuff\martin-loop\OPEN-ME-FIRST.html`
- `C:\Users\Torram\OneDrive\Documents\Codex Main\Setup Stuff\martin-loop\docs\plans\2026-03-27-martin-v2a-trust-demo-implementation-plan.md`
- `C:\Users\Torram\OneDrive\Documents\Codex Main\Setup Stuff\martin-loop\docs\2026-03-27-v2-v3-product-spec.md`
- `C:\Users\Torram\OneDrive\Documents\Codex Main\Setup Stuff\martin-loop\docs\plans\2026-03-27-martin-master-roadmap.md`
- `C:\Users\Torram\OneDrive\Documents\Codex Main\Setup Stuff\martin-loop\docs\demo\mockups\index.html`

If you need the old zip reference, it is expected at:

`C:\Users\Torram\OneDrive\Documents\Codex Main\Setup Stuff\martin-loop-package.zip`

Important: that zip could be stale. The repo folder is the current source of truth.

## 2. Product Context

Martin Loop is being built to solve two core problems:

1. Ralph-style loops waste resources because they retry blindly and often fail to converge.
2. CTO and CFO AI budgets will get cut if AI/agent usage cannot show trustworthy ROI, governance, and measurable outcomes.

The current direction is dual-track:

- Track A: OSS runtime, CLI-first, coding-loop control
- Track B: hosted multi-tenant SaaS control plane for finance, governance, and operations visibility

The current execution slice is `V2A: Trust + Demo`.

## 3. What Was Built

### OSS / Runtime / CLI

- Governance contract added and exported:
  - `packages/contracts/src/governance.ts`
  - `packages/contracts/src/index.ts`
- Seeded demo contract added:
  - `demo/seeded-workspace/seeded-run.json`
  - `demo/seeded-workspace/ralph-vs-martin.json`
  - `demo/seeded-workspace/governance-policy.json`
- CLI guardrail resolution significantly improved:
  - `packages/cli/src/index.ts`
  - `packages/cli/tests/cli.test.ts`
  - `docs/guides/run-guardrails.md`
  - `martin.config.example.yaml`
  - `OPEN-ME-FIRST.html`

Key CLI behavior now implemented:

- `effectivePolicy` includes:
  - `configPath`
  - `policyProfile`
  - `destructiveActionPolicy`
  - `verifierRules`
  - `budget`
  - `telemetryDestination`
- If `--verify` is omitted, verifier rules now come from config
- The operator docs now explain where users set:
  - max cost
  - soft limit
  - max iterations
  - max tokens
  - telemetry destination
  - destructive action policy
  - verifier rules

### Hosted Control Plane

Hosted executive IA was rebuilt around:

- `Overview`
- `Operations`
- `Economics`
- `Governance`
- `Billing`
- `Admin`

Key files:

- `apps/control-plane/app/page.tsx`
- `apps/control-plane/app/operations/page.tsx`
- `apps/control-plane/app/economics/page.tsx`
- `apps/control-plane/app/governance/page.tsx`
- `apps/control-plane/app/billing/page.tsx`
- `apps/control-plane/app/settings/page.tsx`
- `apps/control-plane/components/control-plane-shell.tsx`
- `apps/control-plane/components/executive-context-bar.tsx`
- `apps/control-plane/components/overview-kpi-band.tsx`
- `apps/control-plane/components/trust-strip.tsx`
- `apps/control-plane/components/exception-panel.tsx`
- `apps/control-plane/components/primary-trend-panel.tsx`
- `apps/control-plane/lib/queries/control-plane-queries.ts`
- `apps/control-plane/lib/view-models/executive-overview.ts`
- `apps/control-plane/lib/view-models/operator-economics.ts`

Important note:

- The legacy hosted route directories may still physically exist as empty folders:
  - `apps/control-plane/app/loops`
  - `apps/control-plane/app/savings`
  - `apps/control-plane/app/policies`
  - `apps/control-plane/app/integrations`
- Their `page.tsx` files were removed, and the query exports were retired.
- Deleting the empty directories was blocked by shell policy in the desktop session.
- In VS Code / PowerShell, delete those empty directories if they still exist.

### Hosted API Hardening

Security hardening added for the hosted control-plane API:

- `apps/control-plane/lib/server/http.ts`
- `apps/control-plane/lib/server/validation.ts`
- `apps/control-plane/lib/server/auth.ts`
- `apps/control-plane/app/api/telemetry/route.ts`
- `apps/control-plane/app/api/workspaces/route.ts`
- `apps/control-plane/app/api/policies/route.ts`
- `apps/control-plane/app/api/billing/route.ts`

Security behavior now intended:

- JSON responses set safer defaults like `no-store` and `nosniff`
- Hosted API validates payload structure more strictly
- Hosted API requires `x-martin-api-key`
- Workspace-scoped requests must match the authenticated workspace
- Production should fail closed if required hosted API key env vars are missing
- Non-production local review flow may use demo keys

Hosted auth-related tests added:

- `apps/control-plane/tests/control-plane-auth.test.ts`
- `apps/control-plane/tests/control-plane-api-security.test.ts`
- `apps/control-plane/tests/control-plane-routes.test.ts`

### Local Operator Dashboard

The no-install local dashboard was reshaped into an operator console:

- `apps/local-dashboard/index.html`
- `apps/local-dashboard/styles.css`
- `apps/local-dashboard/app.js`
- `apps/local-dashboard/data/demo-data.js`
- `apps/local-dashboard/README.md`
- `apps/local-dashboard/tests/local-dashboard-data.test.ts`

It is designed to be opened directly via `file://`.

### Visual / Demo / Story Assets

Added:

- `docs/demo/mockups/index.html`
- `docs/demo/mockups/control-plane-overview.svg`
- `docs/demo/mockups/control-plane-economics.svg`
- `docs/demo/mockups/local-operator-console.svg`
- `docs/demo/mockups/ralph-vs-martin-board.svg`
- `docs/demo/mockups/README.md`
- `docs/demo/martin-demo-script.md`
- `docs/demo/visual-asset-checklist.md`
- `docs/demo/diagrams/runtime-lifecycle.mmd`
- `docs/demo/diagrams/telemetry-flow.mmd`
- `docs/demo/diagrams/savings-methodology.mmd`
- `docs/demo/diagrams/governance-input-flow.mmd`
- `docs/demo/screenshots/README.md`
- `docs/demo/screenshots/manifest.json`

### Planning / Docs

Main planning docs:

- `docs/2026-03-27-v2-v3-product-spec.md`
- `docs/plans/2026-03-27-martin-master-roadmap.md`
- `docs/plans/2026-03-27-martin-v2a-trust-demo-implementation-plan.md`

Testing / deployment docs updated:

- `docs/testing/non-technical-testing-guide.md`
- `docs/testing/non-technical-testing-guide.html`
- `deploy/DEPLOYMENT-GUIDE.md`

## 4. What Could Not Be Verified In The Desktop Session

The desktop Codex shell could not launch `node.exe`, `pnpm`, `vitest`, `next`, or similar executables.

That means:

- no real `pnpm install`
- no real `pnpm test`
- no real `pnpm build`
- no live `next dev`
- no real browser screenshot automation

So this repo has been statically reviewed and iterated heavily, but it still needs a real VS Code / PowerShell execution pass.

## 5. What Still Needs To Be Done In VS Code / PowerShell

### Mandatory Execution Pass

Run the full repo through:

1. dependency install
2. lint / typecheck
3. test suite
4. build
5. hosted app local run
6. CLI benchmark and run smoke tests
7. local dashboard open-check
8. optional zip refresh

### Likely Remaining Fixes

Expect the next Codex instance to find and fix at least some real issues once TypeScript and Vitest actually run. The most likely areas:

- mismatched prop shapes in React components
- stale doc snippets that reference older shapes
- test failures around auth behavior or route signatures
- any import-path or type drift introduced during the multi-pass refactor
- any `file://` local-dashboard edge case

### Cleanup Tasks

- delete empty legacy hosted route directories if they still exist
- refresh `martin-loop-package.zip`
- if tests require it, update docs to reflect final executable behavior

## 6. Exact Commands To Run

Run from:

`C:\Users\Torram\OneDrive\Documents\Codex Main\Setup Stuff\martin-loop`

### Install

```powershell
cd "C:\Users\Torram\OneDrive\Documents\Codex Main\Setup Stuff\martin-loop"
pnpm install
```

### Repo-Wide Checks

```powershell
pnpm lint
pnpm test
pnpm build
```

If repo-wide commands fail, also run package-specific checks:

```powershell
pnpm --filter @martin/control-plane lint
pnpm --filter @martin/control-plane test
pnpm --filter @martin/control-plane build

pnpm --filter @martin/cli lint
pnpm --filter @martin/cli test
pnpm --filter @martin/cli build
```

### Hosted Control Plane Local Run

Set env vars first:

```powershell
$env:MARTIN_CONTROL_PLANE_ADMIN_API_KEY="replace-with-dev-admin-key"
$env:MARTIN_CONTROL_PLANE_WORKSPACE_API_KEY="replace-with-dev-workspace-key"
pnpm dev:control-plane
```

Check these routes:

- `/`
- `/operations`
- `/economics`
- `/governance`
- `/billing`
- `/settings`

Also verify that old hosted IA routes do not work anymore, or at minimum no longer render an active page:

- `/loops`
- `/savings`
- `/policies`
- `/integrations`

### CLI / Runtime Smoke Tests

Run the benchmark:

```powershell
pnpm --filter @martin/cli dev -- bench --suite ralphy-smoke
```

Run a config-driven loop:

```powershell
pnpm --filter @martin/cli dev -- run --objective "Repair flaky CI gate" --config .\martin.config.example.yaml
```

Run an override-driven loop:

```powershell
pnpm --filter @martin/cli dev -- run --workspace ws_demo --project proj_demo --objective "Repair the flaky CI gate" --verify "pnpm test" --budget-usd 8 --soft-limit-usd 4 --max-iterations 3 --max-tokens 20000 --policy balanced --telemetry control-plane
```

What to inspect from CLI output:

- `effectivePolicy`
- `loop.budget`
- `loop.task.verificationPlan`
- `decision`
- any config-path or verifier-rule mismatch

### Local Dashboard Checks

Open directly:

`C:\Users\Torram\OneDrive\Documents\Codex Main\Setup Stuff\martin-loop\apps\local-dashboard\index.html`

Verify:

- Current Run loads
- Effective Policy renders
- Budget and Verifier sections render
- Benchmark Lab renders
- no console errors in browser devtools

### Visual Checks

Open directly:

`C:\Users\Torram\OneDrive\Documents\Codex Main\Setup Stuff\martin-loop\docs\demo\mockups\index.html`

Verify:

- all four visuals render
- no broken image references
- labels still align with the current product story

## 7. Specific Tests That Matter Most

These files deserve special attention:

- `apps/control-plane/tests/control-plane-queries.test.ts`
- `apps/control-plane/tests/control-plane-routes.test.ts`
- `apps/control-plane/tests/control-plane-api-security.test.ts`
- `apps/control-plane/tests/control-plane-auth.test.ts`
- `packages/cli/tests/cli.test.ts`
- `packages/contracts/tests/governance.test.ts`
- `apps/local-dashboard/tests/local-dashboard-data.test.ts`

## 8. What Good Results Look Like

### Minimum acceptable completion

- `pnpm install` succeeds
- `pnpm lint` succeeds
- `pnpm test` succeeds
- `pnpm build` succeeds
- hosted control plane runs locally
- CLI benchmark command runs
- CLI run command emits correct `effectivePolicy`
- local dashboard opens without errors

### Strong completion

Everything above, plus:

- screenshots saved for hosted routes
- screenshots saved for local dashboard
- empty legacy route folders removed
- zip refreshed
- any doc drift fixed after real execution

## 9. Exact Result Format Wanted Back

Please ask the next Codex instance to produce a file like:

`docs/handoffs/2026-03-27-vscode-validation-results.md`

Use this structure:

```md
# Martin Loop VS Code Validation Results

## Environment
- OS:
- Node version:
- pnpm version:

## Commands Run
- `pnpm install`:
- `pnpm lint`:
- `pnpm test`:
- `pnpm build`:
- `pnpm --filter @martin/control-plane test`:
- `pnpm --filter @martin/cli test`:

## Hosted Control Plane
- Routes checked:
- Auth env vars used:
- Result:
- Screenshot paths:

## CLI / Runtime
- Benchmark result:
- Run result:
- Effective policy observations:

## Local Dashboard
- Result:
- Console errors:
- Screenshot paths:

## Files Changed
- list exact files

## Remaining Issues
- list anything still failing or risky

## Final Recommendation
- ready for another desktop review / not ready yet
```

## 10. Ready-To-Paste Prompt For The Next Codex

See:

`C:\Users\Torram\OneDrive\Documents\Codex Main\Setup Stuff\martin-loop\docs\handoffs\2026-03-27-vscode-codex-prompt.txt`

