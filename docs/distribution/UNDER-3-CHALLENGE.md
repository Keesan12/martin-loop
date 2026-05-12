# Can your AI coding agent finish this task under $3?

MartinLoop is testing a simple question:

Can an AI coding agent complete a task under a fixed budget, with verifier-passed completion and an inspectable run record?

## Current repo-backed comparison

Same task, same starting state:

- governed MartinLoop run: `$2.30`
- uncontrolled retry loop: `$5.20`
- governed outcome: `completed` and verifier-passed with an inspectable record
- uncontrolled outcome: failed after repeated retries with no comparable audit trail

These numbers match the current public benchmark story shown in the repo README and visualized in [`docs/assets/side-by-side.svg`](../assets/side-by-side.svg).

## Why this matters

The claim is not that every governed run is always cheaper. The claim is that the run becomes inspectable and enforceable:

- budget policy is explicit
- verifier success is explicit
- stop reasons are explicit
- artifacts are inspectable after the run

That makes a coding-agent result easier to trust, replay, compare, and audit.

## Reproduce it

From the repo root:

```bash
pnpm --filter @martin/benchmarks test
pnpm --filter @martin/benchmarks eval
pnpm --filter @martin/benchmarks eval:phase12
```

## What to share back

If you run a similar challenge with Claude Code, Codex CLI, Cursor, Aider, Cline, Continue, OpenHands, SWE-agent, Goose, or an internal coding agent, share:

- total budget used
- number of attempts
- verifier result
- whether the final run was auditable
- whether rollback evidence was available

## Try MartinLoop without risking your repo

You can copy the public demo sandbox first:

```bash
npx martin-loop demo
```

Then run the sandbox locally with the printed next steps.

## Claim boundary

This page intentionally stays inside the current public evidence boundary:

- the `$2.30` and `$5.20` figures are the current repo-backed benchmark story used in the public README
- the reproduction commands above are real commands from this repository
- the benchmark harness remains a workspace-level surface, so challenge claims should stay tied to repo-backed outputs rather than generic marketing numbers
