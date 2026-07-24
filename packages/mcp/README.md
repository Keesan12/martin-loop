# MartinLoop MCP

<div align="center">
  <img src="https://raw.githubusercontent.com/Keesan12/martin-loop/main/docs/assets/martinloop-logo.png" alt="MartinLoop" width="240">

  **Stop runaway loops, bad code, and token waste.**

  The governed MCP runtime for Claude Code, Codex, Gemini CLI, Cursor, and autonomous coding agents.

  [![npm version](https://img.shields.io/npm/v/@martinloop/mcp?style=flat-square&logo=npm&logoColor=white)](https://www.npmjs.com/package/@martinloop/mcp)
  [![npm downloads](https://img.shields.io/npm/dm/@martinloop/mcp?style=flat-square&label=downloads)](https://www.npmjs.com/package/@martinloop/mcp)
  [![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue?style=flat-square&logo=apache)](../../LICENSE)
  [![Node](https://img.shields.io/badge/node-%3E%3D20-3c873a?style=flat-square&logo=nodedotjs&logoColor=white)](#requirements)
  [![Glama score](https://glama.ai/mcp/servers/Keesan12/martin-loop/badges/score.svg)](https://glama.ai/mcp/servers/Keesan12/martin-loop)
</div>

AI coding agents can write code. MartinLoop decides whether they are allowed to keep spending, whether the result is actually verified, and what evidence must remain for review.

It wraps agent execution with:

- hard USD, token, iteration, time, command, and file-change limits
- verifier gates that must pass before completion
- allowed and denied path contracts
- preflight checks before any execution or spend
- durable pause, continue, and cancel receipts
- failure triage, run dossiers, evaluations, and PR-review evidence

## Connect in one command

| Host | Command |
| --- | --- |
| Claude Code | `claude mcp add martin-loop -- npx -y @martinloop/mcp` |
| Codex | `codex mcp add martin-loop -- npx -y @martinloop/mcp` |
| Gemini CLI | `gemini mcp add martin-loop -- npx -y @martinloop/mcp` |
| Any stdio MCP host | `npx -y @martinloop/mcp` |

Windows Claude Code:

```sh
claude mcp add --transport stdio --scope user martin-loop -- cmd /c npx -y @martinloop/mcp
```

No API key is required to start and inspect the server. Live execution requires a supported coding-agent CLI and its normal authentication.

## Why agents use MartinLoop

| Uncontrolled agent run | Governed MartinLoop run |
| --- | --- |
| The agent decides when it is done | Your verifier decides whether completion is valid |
| Retries continue until the user notices | Hard budgets and stop conditions prevent open-ended spend |
| Scope drifts across the repository | Allowed and denied paths constrain writes |
| The final answer hides failed attempts | The dossier preserves attempts, costs, verification, and artifacts |
| Process control is ephemeral | Pause, continue, and cancel actions leave durable receipts |
| “Probably fixed” becomes accepted | Missing, failed, contradicted, or unknown verification stays incomplete |

MartinLoop is not another coding agent. It is the enforcement and evidence layer around the agents you already use.

## Agent operating contract

Use this sequence for governed coding work:

```text
martin_doctor
  → martin_estimate
  → martin_plan
  → martin_preflight
  → martin_run
  → martin_dossier
  → martin_eval
```

### Rules for agents

1. Start with `martin_doctor` to inspect the environment and run store.
2. Call `martin_estimate` before spending.
3. Keep the same objective and compatible scope through estimate, plan, preflight, and run.
4. Prefer read-only tools until execution is explicitly authorized.
5. Treat failed, contradicted, missing, or unknown verification as incomplete.
6. Use `martin://agent/next-step` or `martin://guides/agent-start` when the next action is unclear.
7. Do not use `martin_create_pr` with `execute: true` unless the user has explicitly authorized a GitHub write.

`martin_run` intentionally hard-blocks until the required doctor, estimate, plan, and preflight receipts exist for the same task.

## What a governed run looks like

```text
User objective:
"Fix the auth regression. Budget: $3. Verify: npm test."

doctor       checks environment, CLI availability, and run storage
estimate     predicts route, spend, and pre-work burn without spending
plan         defines scope, verifier proposal, policy pack, and risk
preflight    validates the contract before execution
run          executes inside budget, scope, policy, and verifier gates
dossier      returns attempts, cost, verification, artifacts, and evidence paths
eval         grades completion, verifier health, risk, and reviewability
```

Every attempt is bounded by the run contract. A confident model answer does not override a failed verifier.

## Proof, not promises

This real governed run spent `$0.51` against a `$3.00` budget. The verifier passed and the receipt integrity was signed. MartinLoop still kept the result at `EVIDENCE_BOUNDARY` because rollback evidence had not been recorded.

<div align="center">
  <img src="https://raw.githubusercontent.com/Keesan12/martin-loop/main/docs/assets/proof-receipt-live-governed.png" alt="MartinLoop governed run receipt showing spend, budget, verifier result, integrity, and evidence boundary" width="720">
</div>

Inspect the example receipt:

- [Markdown receipt](https://github.com/Keesan12/martin-loop/blob/main/docs/examples/proof-receipts/live-governed-run-receipt.md)
- [JSON receipt](https://github.com/Keesan12/martin-loop/blob/main/docs/examples/proof-receipts/live-governed-run-receipt.json)

## Tool surface

### Governed workflow

- `martin_doctor` — inspect environment readiness; expected first call
- `martin_estimate` — estimate cost and route without spending
- `martin_plan` — produce scoped plan, verifier proposal, policy pack, and risk
- `martin_preflight` — validate readiness before execution
- `martin_run` — execute a governed coding task
- `martin_pause` — record a durable pause request
- `martin_continue` — record a durable resume request
- `martin_cancel` — record a durable cancellation request

### Inspection and review

- `martin_status`, `martin_logs`, `martin_inspect`
- `martin_list_runs`, `martin_triage_runs`
- `martin_get_run`, `martin_get_attempt`, `martin_get_verification_results`
- `martin_run_dossier`, `martin_dossier`, `martin_eval`
- `martin_pr_summary`, `martin_create_pr`, `martin_review_pr`

### Read-only resources

The server exposes run summaries, receipts, budget status, verifier evidence, policies, health, agent guidance, and repository-risk context through `martin://` resources, including:

```text
martin://runs/latest
martin://runs/latest/summary
martin://runs/latest/receipt
martin://runs/latest/budget-status
martin://runs/latest/verifier-evidence
martin://runs/recent
martin://server/health
martin://policies/current
martin://agent/next-step
martin://guides/agent-start
martin://repo/risk-map
```

Use resources when the agent needs context without side effects.

## Configuration profiles

Generate host config tuned to the minimum surface needed:

```sh
npx martin-loop mcp print-config --host claude --profile minimal
npx martin-loop mcp print-config --host claude --profile diagnostic
npx martin-loop mcp print-config --host claude --profile full-local
npx martin-loop mcp print-config --host claude --profile github-review
```

- `minimal` — core run and inspection path
- `diagnostic` — adds doctor and triage surfaces
- `full-local` — all local tools
- `github-review` — adds PR evidence and review workflow

## Trust boundaries

- Cost and token values include provenance: actual, estimated, or unavailable.
- A verifier proves only the commands you configured, not every product requirement.
- Receipt integrity must be verified before evidence is trusted externally.
- Unknown or missing evidence never passes silently.
- MartinLoop does not guarantee that an agent will produce correct code; it makes execution bounded, verification explicit, and failure reviewable.

## Requirements

- Node.js 20+
- One supported coding-agent CLI for live execution: Claude Code, Codex, Gemini CLI, or an OpenAI-compatible route
- Git repository for rollback-aware and changed-file workflows

## Links

- [Glama server page](https://glama.ai/mcp/servers/Keesan12/martin-loop)
- [npm: @martinloop/mcp](https://www.npmjs.com/package/@martinloop/mcp)
- [GitHub source and issues](https://github.com/Keesan12/martin-loop)
- [MCP setup guide](https://github.com/Keesan12/martin-loop/blob/main/docs/getting-started/mcp.md)
- [MCP tool reference](https://github.com/Keesan12/martin-loop/blob/main/docs/reference/mcp-tools.md)
- [martinloop.com](https://martinloop.com)

## License

Apache-2.0.
