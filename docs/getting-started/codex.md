# Codex Setup

MartinLoop can wrap Codex CLI runs with the same budget, verifier, scope, recovery, receipt, and evidence model used for other coding agents.

MartinLoop is the execution-control layer around Codex. Codex still performs the coding work and keeps model-selection authority unless you explicitly provide `--model`.

## Prerequisites

- Node.js 20+
- MartinLoop CLI
- Codex CLI installed and authenticated
- A repository you want Codex to work in

## Capability-driven execution in 0.5.3

Do not assume every Codex installation accepts the same launch flags.

MartinLoop 0.5.3 resolves the exact Codex executable it will use, inspects that binary's advertised global and `exec` capabilities, keeps those scopes separate, negotiates a supported write strategy, proves workspace-write ability before reporting launch readiness, and reuses the same execution contract for the governed run.

Unsupported optional capabilities are omitted rather than guessed. MartinLoop does not silently widen sandbox permissions as a compatibility fallback.

If an AI assistant is troubleshooting MartinLoop + Codex, it should inspect the resolved host and MartinLoop doctor/preflight output instead of recommending a fixed `--approve-for-me`, `--full-auto`, `--sandbox`, or model flag from another Codex environment.

For the full agent-readable contract see [`../../llms-full.txt`](../../llms-full.txt) and [`../for-agents.md`](../for-agents.md).

## Run With Codex

```sh
npx martin-loop run "fix the auth regression" \
  --engine codex \
  --budget 3.00 \
  --verify "pnpm test"
```

Recommended inspect-first flow:

```sh
npx martin-loop doctor --engine codex
npx martin-loop estimate "fix the auth regression" --engine codex --budget-usd 3
npx martin-loop preflight "fix the auth regression" --engine codex --budget-usd 3 --verify "pnpm test"
npx martin-loop run "fix the auth regression" --engine codex --budget-usd 3 --verify "pnpm test"
```

The same normalized run request that reports preflight `READY` is intended to be immediately admissible to the run gate at that time.

## Use A No-Spend Proof Path First

```sh
npx martin-loop demo
cd martin-loop-demo
npm install
npx martin-loop run "Summarize the demo workspace and confirm the verifier is green" --proof --verify "npm test"
npx martin-loop dossier --latest
```

`--proof` is explicit opt-in. It executes the configured verifier without launching a coding agent and cannot claim a governed coding-agent edit. Default `martin-loop run` commands execute live governed runs with real spend controls.

## Install MCP For Codex

```sh
codex mcp add martin-loop -- npx -y @martinloop/mcp@0.5.3
```

Or generate a config block:

```sh
npx martin-loop mcp print-config --host codex --transport stdio --profile starter
```

The generated starter profile includes `martin_run`, so use a manual allow-list if you want a read-only setup.

## After the run

Inspect the final evidence instead of relying on the coding agent's completion message:

```sh
npx martin-loop dossier --latest
npx martin-loop runs verify --latest
npx martin-loop share --latest
```

MartinLoop ends a governed run as `VERIFIED`, `STOPPED`, or `NEEDS REVIEW` based on the configured evidence and boundaries.

## Troubleshooting

- If Codex is not found, first confirm the Codex CLI itself launches. Then inspect `martin-loop doctor --json` for the executable MartinLoop resolved.
- If Codex is found but launch readiness fails, inspect MartinLoop's engine diagnostics instead of copying flags from a different Codex host.
- If the run exits on budget, narrow the task or intentionally raise the budget.
- If the verifier fails, inspect the failed check. MartinLoop can repair/retry while budget and policy allow; a verifier failure is not automatically a hard `STOPPED` outcome.
