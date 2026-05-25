# @martinloop/mcp v0.2.0

`0.2.0` is the cockpit expansion release for the Martin Loop MCP server. It turns the governed execution lane into a small local cockpit for reviewing governed agent runs.

`0.1.4` introduced the safe operator foundation: check the environment, preflight a contract, run a governed coding task, and inspect saved results. `0.2.0` keeps that contract intact and adds read-only review surfaces so MCP hosts can show what happened after a run: recent runs, one-run dossiers, individual attempts, verifier results, and guided review prompts.

The important safety boundary is unchanged: `martin_run` is still the only tool that can execute work. The new `0.2.0` additions are read-only inspection and review helpers.

## What Changed From `0.1.4`

| Area | `0.1.4` | `0.2.0` |
| --- | --- | --- |
| Environment checks | `martin_doctor` | unchanged |
| Run preflight | `martin_preflight` | unchanged |
| Governed execution | `martin_run` | unchanged write boundary |
| Basic run inspection | `martin_inspect`, `martin_status` | unchanged |
| Review cockpit | not included | run lists, dossiers, attempts, verifier results |
| MCP discovery | tools | tools, resources, resource templates, prompts |

## Tools

Existing tools:

- `martin_doctor`
- `martin_preflight`
- `martin_run`
- `martin_inspect`
- `martin_status`

New read-only cockpit tools:

- `martin_list_runs` lists recent governed run summaries from the local run store.
- `martin_get_run` returns a run dossier by `loopId` or `latest`.
- `martin_get_attempt` returns one attempt record by `loopId` and `attemptIndex`.
- `martin_get_verification_results` extracts verifier completion events.
- `martin_run_dossier` assembles summary, task, budget, attempts, and verification evidence for review.

## Resources

- `martin://runs/summary`
- `martin://runs/latest`

## Resource Templates

- `martin://runs/{loopId}`
- `martin://runs/{loopId}/attempts/{attemptIndex}`
- `martin://runs/{loopId}/verification`

## Prompts

- `martin_review_run`
- `martin_triage_failures`

## Upgrade Notes

- Existing `0.1.4` tool callers do not need to change their current calls.
- Hosts can opt into the new cockpit surface by listing tools, resources, resource templates, and prompts through normal MCP discovery.
- The npm package remains `@martinloop/mcp`.
- The MCP server name remains `io.github.Keesan12/martin-loop`.

## Verification

The published package was verified from npm after release. The published smoke test confirmed:

- package version `@martinloop/mcp@0.2.0`
- all 10 tools are discoverable
- both resources are discoverable
- all 3 resource templates are discoverable
- both prompts are discoverable
- local run inspection, status, run listing, dossier generation, and governed stub execution work from the installed npm artifact
