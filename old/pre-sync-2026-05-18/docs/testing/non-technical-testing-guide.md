# Martin Loop Testing Guide

## The super simple version

If you only want to validate something fast:

1. Extract the zip.
2. Open `OPEN-ME-FIRST.html`.
3. Click **Open Local Dashboard**.
4. Click **Open Visual Gallery** if you want the executive mockups and comparison boards first.
5. Review the Current Run, Effective Policy, Budget, and Verifier sections in the local dashboard.
6. Look at the Ralph-vs-Martin benchmark section after that.
5. If you want the real automated tests, follow the terminal steps below on a normal Windows terminal.

## What you are testing

There are really three things to test:

1. The **local operator dashboard** opens and shows the seeded run and policy data.
2. The **automated code tests** pass.
3. The **demo benchmark** runs and shows Martin behaving better than a Ralph-style retry loop.
4. The **hosted control plane** renders the executive information architecture.
5. The **visual gallery** opens directly and shows the stakeholder-facing mockups without needing to run the app.

## Important labels

When you validate Martin, use these labels strictly:

- `Seeded Demo Data`: prepared repo fixtures
- `Simulated Scenario`: the seeded benchmark story label used in the dashboard; in this validation pass, the underlying benchmark also ran live from this Codex shell
- `Modeled`: projected or estimated economics
- `Actual`: measured spend or verifier-backed truth

## Step by step automated testing

### Part 1: Install what you need

1. Make sure Node.js is installed on your computer.
2. Open a normal terminal, PowerShell, or VS Code terminal.
3. Go to the `martin-loop` folder you extracted.

### Part 2: Install the repo packages

Run:

```powershell
pnpm install
```

If `pnpm` is not installed, run:

```powershell
npm install -g pnpm
pnpm install
```

### Part 3: Run the full automated test suite

Run:

```powershell
pnpm test
```

What “good” looks like:

- contract tests pass
- runtime tests pass
- CLI tests pass
- benchmark tests pass
- control-plane tests pass

### Part 4: Run the hosted SaaS dashboard locally

Run:

```powershell
pnpm dev:control-plane
```

Then open the local web address shown in the terminal, usually:

`http://localhost:3000`

Check these pages specifically:

- `/`
- `/operations`
- `/economics`
- `/governance`

### Part 5: Run the local no-install dashboard

You do not need the terminal for this.

Just open:

`apps/local-dashboard/index.html`

What you should see above the fold:

- Current Run header
- Effective Policy with provenance
- Budget strip
- Attempt State
- Verifier State
- Exit / Replay orientation

### Part 6: Run the benchmark demo

Run:

```powershell
pnpm --filter @martin/cli dev -- bench --suite ralphy-smoke
```

This should print JSON with benchmark results.

### Part 7: Run a Martin loop demo

Run:

```powershell
pnpm --filter @martin/cli dev -- run --workspace ws_demo --project proj_demo --objective "Repair the flaky CI gate" --verify "pnpm test" --budget-usd 8 --soft-limit-usd 4 --max-iterations 3 --max-tokens 20000
```

What you should see:

- Martin creates a run
- Martin records attempts
- Martin exits with a decision
- the JSON output includes the loop record and exit decision

## Ralph vs Martin demo use case

Use the flaky-CI demo because it shows the problem clearly:

- Ralph-style behavior: keep retrying until money and attempts are mostly gone
- Martin behavior: classify failure, watch budget pressure, and exit with verification or an early budget stop

The seeded local dashboard shows that comparison visually, and the live runtime proof has now been verified with the commands and results below.

## What I could and could not verify here

Verified here:

- `pnpm lint` PASS
- `pnpm test` PASS
- `pnpm build` PASS
- `pnpm --filter @martin/cli dev -- bench --suite ralphy-smoke` PASS
- `node packages/cli/dist/bin/martin.js bench --suite ralphy-smoke` PASS
- `node packages/cli/dist/bin/martin.js run --objective "Repair flaky CI gate" --config .\martin.config.example.yaml` PASS
- `pnpm --filter @martin/cli dev -- run --objective "Repair flaky CI gate" --config .\martin.config.example.yaml` PASS
- `node packages/cli/dist/bin/martin.js run --workspace ws_demo --project proj_demo --objective "Repair the flaky CI gate" --verify "pnpm test" --budget-usd 8 --soft-limit-usd 4 --max-iterations 3 --max-tokens 20000 --policy balanced --telemetry control-plane` PASS

The earlier limitation note no longer applies to this pass.
