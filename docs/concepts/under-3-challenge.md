# Can Your AI Coding Agent Finish This Task Under $3?

MartinLoop uses a simple public comparison to explain why governed runs matter:

Can an AI coding agent complete a task under a fixed budget, with verifier-passed completion and an inspectable run record?

## Demo Comparison

Same task, same starting state:

- governed MartinLoop run: `$2.30`
- uncontrolled retry loop: `$5.20`
- governed outcome: completed and verifier-passed with an inspectable record
- uncontrolled outcome: failed after repeated retries with no comparable audit trail

These figures are a demo comparison, not a universal cost guarantee.

## Why It Matters

The claim is not that every governed run is always cheaper. The claim is that the run becomes inspectable and enforceable:

- budget policy is explicit
- verifier success is explicit
- stop reasons are explicit
- artifacts are inspectable after the run

That makes a coding-agent result easier to trust, replay, compare, and audit.

## Try The Demo

```sh
npx martin-loop demo
cd martin-loop-demo
npm install
MARTIN_LIVE=false npx martin-loop run "Summarize the demo workspace and confirm the verifier is green" --verify "npm test"
npx martin-loop dossier --latest
```
