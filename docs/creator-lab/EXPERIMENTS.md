# Creator Experiments

These experiments are designed to produce useful content even when the agent fails. The creator should publish the actual receipt and retain all evidence boundaries.

## Experiment 1 — Under-$3 Governed Agent Challenge

### Question

Can one coding agent complete a clearly scoped task, pass a real verifier, and stay inside a hard `$3.00` budget?

### Best audience

Claude Code, Codex, Cursor, Gemini, MCP, developer productivity, and AI engineering audiences.

### Setup lane

```sh
npx -y martin-loop@latest start
npx -y martin-loop@latest demo
cd martin-loop-demo
npm install
```

Confirm adapter readiness:

```sh
npx -y martin-loop@latest doctor
```

### Demo contract

```sh
npx -y martin-loop@latest run \
  "Summarize the demo workspace and prove tests still pass" \
  --verify "npm test" \
  --budget-usd 3 \
  --max-iterations 1
```

For stronger creator content, use a disposable branch or test repository and replace the objective with one real, bounded code change. Keep the same budget and a verifier that genuinely tests the requested behavior.

### Evidence export

```sh
npx -y martin-loop@latest dossier --latest
npx -y martin-loop@latest runs verify --latest
npx -y martin-loop@latest share --latest --with-proof-card --proof-card-format both
```

### Publish

Show:

- objective
- selected agent and model
- budget and maximum attempts
- verifier command
- final spend
- attempts
- stop reason
- verifier result
- changed files or diff
- receipt integrity
- rollback evidence status
- evidence boundary, if any

### Verdict categories

- **Verified inside budget** — verifier passed and the receipt supports the claim.
- **Stopped safely** — the run did not finish, but policy prevented further spend or unsafe continuation.
- **Outcome unclear** — the agent appears finished but evidence is insufficient.
- **Invalid experiment** — task, verifier, environment, or receipt cannot support the conclusion.

## Experiment 2 — Same Task, Same Budget, Different Agent

### Question

Which agent produces the best reviewable outcome under the same constraints?

### Rules

- use the same clean repository state for every agent
- use the same objective
- use the same verifier
- use the same `$3.00` budget
- use the same maximum attempts
- do not reuse one agent's modified workspace for another agent
- publish all receipts, including failed runs

### Example commands

```sh
npx -y martin-loop@latest run \
  "<bounded objective>" \
  --engine claude \
  --verify "npm test" \
  --budget-usd 3 \
  --max-iterations 2
```

```sh
npx -y martin-loop@latest run \
  "<bounded objective>" \
  --engine codex \
  --verify "npm test" \
  --budget-usd 3 \
  --max-iterations 2
```

Only include an engine that `doctor` confirms is available in the creator's environment.

### Comparison table

| Field | Agent A | Agent B |
| --- | ---: | ---: |
| Spend |  |  |
| Attempts |  |  |
| Verifier |  |  |
| Stop reason |  |  |
| Receipt integrity |  |  |
| Rollback evidence |  |  |
| Changed files |  |  |
| Human review verdict |  |  |

Do not rank agents only by spend. A cheaper failed run is not automatically better than a more expensive verified result.

## Experiment 3 — Govern Your Worst Run

### Question

What policy would have bounded a real painful agent run?

### Input

Ask the creator or audience member for:

- the original task
- agent and model
- approximate spend or quota impact
- number of retries or attempts
- verifier, if one existed
- what went wrong
- sanitized logs, receipt, or screenshots

### Reproduction method

1. Remove secrets and proprietary code.
2. Reduce the incident to a small public reproduction or seeded repository.
3. Define an explicit verifier.
4. Set a budget lower than the original painful run.
5. Set a maximum attempt count.
6. Run the reproduced task through MartinLoop.
7. Publish the new receipt alongside the original failure narrative.

### Safe framing

Use:

> This is a controlled reproduction of the failure pattern, not proof that MartinLoop would have produced the same outcome in the original private environment.

Do not claim exact savings unless the original and governed runs are genuinely comparable.

## Experiment 4 — Fixed-Price Client Work

### Question

Can an agency keep an AI-assisted coding task inside a fixed internal cost envelope?

### Best audience

AI automation agencies, consultants, freelancers, and founder-builders.

### Contract

Before the run, state:

- client-style deliverable
- internal maximum spend
- test or acceptance verifier
- allowed files or directories
- maximum attempts
- review requirement before merge or deployment

### Story angle

The creator is not selling lower token cost alone. The creator is showing that a fixed-price deliverable needs a bounded execution contract, otherwise agent retries turn margin into an unknown variable.

## Experiment 5 — Evidence Boundary Review

### Question

Does a passing test prove that the entire agent run is trustworthy?

Use the public live receipt:

- spend: `$0.51`
- budget: `$3.00`
- attempts: `1`
- verifier: passed
- integrity: signed
- rollback evidence: not recorded
- proof state: `EVIDENCE_BOUNDARY`

The creator should explain why a green verifier is useful but does not create rollback evidence that was never recorded.

This experiment works especially well for security, DevOps, platform engineering, and AI governance audiences.

## Troubleshooting

### No coding adapter available

Run:

```sh
npx -y martin-loop@latest doctor
```

Install or configure a supported adapter. Do not switch to `--proof` and present the result as a live agent run.

### Verifier fails before the agent starts

Fix the repository baseline first. A comparison is invalid when the clean starting state already fails.

### Run finishes too quickly for Arcade mode

Arcade mode is optional entertainment for longer interactive runs. It is not required and should not be used as evidence.

### Receipt has an evidence boundary

Show it. The boundary is part of the result, not a defect to edit out of the content.

### Sensitive data appears in output

Do not publish the bundle until the creator has reviewed the Markdown, JSON, proof card, terminal capture, and diff for sensitive information.
