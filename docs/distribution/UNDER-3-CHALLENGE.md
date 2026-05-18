# Can your AI coding agent finish this task under $3?

MartinLoop is testing a simple question:

Can an AI coding agent complete a task under a fixed budget, with verifier-passed completion and an inspectable run record?

## Current public comparison

Same task, same starting state:

- governed MartinLoop run: `$2.30`
- uncontrolled retry loop: `$5.20`
- governed outcome: `completed` and verifier-passed with an inspectable record
- uncontrolled outcome: failed after repeated retries with no comparable audit trail

These numbers match the current public comparison story shown in the repo README and visualized in [`docs/assets/side-by-side.svg`](../assets/side-by-side.svg).

## Why this matters

The claim is not that every governed run is always cheaper. The claim is that the run becomes inspectable and enforceable:

- budget policy is explicit
- verifier success is explicit
- stop reasons are explicit
- artifacts are inspectable after the run

That makes a coding-agent result easier to trust, replay, compare, and audit.

## Try MartinLoop without risking your repo

You can copy the public demo sandbox first:

```bash
npx martin-loop demo
```

Then run the sandbox locally with the printed next steps.

## Claim boundary

This page intentionally stays inside the current public evidence boundary:

- the `$2.30` and `$5.20` figures are the current public comparison story used in the repo README
- the comparison asset is public and inspectable in this repository
- the challenge claim is about governed vs ungoverned coding-loop behavior, not about reproducing a hidden scoring harness
