# MartinLoop Demo Sandbox

This workspace is the safe public demo copied by `martin-loop demo`.
It is intentionally small enough to understand in one quick review pass.

It is intentionally small:

- `npm test` is green out of the box
- `martin.config.yaml` keeps the budget tiny
- the first suggested MartinLoop run can stay in no-spend proof mode with `--proof`

## Files

- `src/invoice-summary.js`: tiny module used by the demo task
- `test/invoice-summary.test.js`: Node test suite
- `TASKS.md`: suggested objectives for a proof-mode run or a live adapter run
- `martin.config.yaml`: low-risk governance defaults

## Suggested flow

```sh
npm install
npm test
```

Safe first run:

```sh
npx martin-loop run "Summarize the demo workspace and confirm the verifier is green" --proof --verify "npm test"
```

Review the run evidence afterward:

```sh
npx martin-loop dossier --latest
```

Optional live run:

```sh
npx martin-loop run "Add support for a discount percentage to summarizeInvoice and update the tests" --verify "npm test" --engine codex
```

## What to look for

The demo is a small way to see MartinLoop's larger execution-control model:

```text
Definition of Done -> Controlled Run -> Verified Handoff
```

A live governed run should make the budget, verifier, attempts, final outcome, and receipt evidence inspectable. `--proof` is intentionally different: it runs real verifier checks without claiming a governed coding-agent edit.

For the current product and agent-facing definitions see [`../../README.md`](../../README.md), [`../../llms.txt`](../../llms.txt), and [`../../docs/for-agents.md`](../../docs/for-agents.md).
