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
