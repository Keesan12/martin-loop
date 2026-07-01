# @martinloop/mcp

You give an AI agent a coding task. It runs. You get a bill.

But did it actually work? Did it pass your tests? How much did it spend? What files did it touch? Did it loop 47 times trying the same broken approach?

You don't know. And that's the problem.

## What This Does

MartinLoop is a governed loop for AI coding agents. You tell it what to do, set a budget, and point it at your test suite. It runs the agent, checks your tests after every attempt, and stops when either the tests pass or the money runs out.

When it's done, you get a receipt — not a vague summary, but a structured record: dollars spent, attempts made, verification results, files changed, and whether you got what you asked for.

**One line to connect it:**

```sh
claude mcp add martin-loop -- npx -y @martinloop/mcp
```

That's it. Your agent now runs governed.

## Real Numbers From Real Runs

We tested this against live repos with real API spend:

| What happened | Without MartinLoop | With MartinLoop |
|---|---|---|
| Budget: $1.50 task | Agent spent **$28.42** | Agent stopped at **$1.20** |
| Failing verifier | Retried indefinitely | Stopped after 3 attempts with diagnosis |
| CLI not on PATH | "not available on PATH" (dead stop) | Auto-discovered in AppData, kept running |
| `bun run lint && bun run test` | Passed `&&` as a literal arg (always fails) | Routed through shell, worked |

These aren't hypotheticals. The $28 overshoot happened in production testing. We fixed the circuit breaker in `0.3.8`.

## Install

### Claude Code
```sh
claude mcp add martin-loop -- npx -y @martinloop/mcp
```

Windows:
```sh
claude mcp add --transport stdio --scope user martin-loop -- cmd /c npx -y @martinloop/mcp
```

### Codex
```sh
codex mcp add martin-loop -- npx -y @martinloop/mcp
```

### Gemini CLI
```sh
gemini mcp add martin-loop -- npx -y @martinloop/mcp
```

### Any MCP Host
```sh
npx -y @martinloop/mcp
```

## How a Governed Run Works

```
You: "Fix the auth bug. Budget $3. Verify: npm test"

  martin_doctor     →  checks CLI, auth, environment
  martin_plan       →  scopes the task, sets constraints
  martin_preflight  →  validates before any spend
  martin_run        →  agent works inside budget + verifier gates
  martin_dossier    →  receipt: $1.40 spent, 2 attempts, tests pass
```

Every attempt runs your verifier. Every dollar is tracked. If the agent drifts off-task, the scope contract catches it. If it blows the budget, the circuit breaker kills the subprocess mid-stream — not after the bill arrives.

## What Your Agent Gets

### 21 Tools

**Run the loop:**
`martin_doctor` `martin_plan` `martin_preflight` `martin_run` `martin_pause` `martin_continue` `martin_cancel`

**Inspect results:**
`martin_status` `martin_logs` `martin_dossier` `martin_eval` `martin_inspect` `martin_list_runs` `martin_get_run` `martin_get_attempt` `martin_get_verification_results` `martin_triage_runs`

**Ship the work:**
`martin_pr_summary` `martin_create_pr` `martin_review_pr`

### 11 Read-Only Resources

Your agent can pull context without side effects:

`martin://runs/latest` · `martin://runs/latest/summary` · `martin://runs/latest/receipt` · `martin://runs/latest/proof-card` · `martin://runs/latest/budget-status` · `martin://runs/latest/verifier-evidence` · `martin://runs/recent` · `martin://server/health` · `martin://policies/current` · `martin://agent/next-step` · `martin://guides/mcp-usage` · `martin://guides/agent-start` · `martin://repo/risk-map`

### Configuration Profiles

Generate host config tuned to your workflow:

```sh
npx martin-loop mcp print-config --host claude --profile minimal        # run + inspect
npx martin-loop mcp print-config --host claude --profile diagnostic     # + doctor + triage
npx martin-loop mcp print-config --host claude --profile full-local     # all local tools
npx martin-loop mcp print-config --host claude --profile github-review  # + PR workflow
```

## What Happens When Things Go Wrong

MartinLoop doesn't just report failures — it tries to fix them:

| Failure | Old behavior | Now |
|---|---|---|
| CLI not on PATH | Error message, dead stop | Searches npm global, homebrew, nvm, scoop — uses what it finds |
| Verifier says "command not found" | Generic "verification failed" | Tells the next attempt: "bun is missing, install with `npm i -g bun`" |
| `git restore` fails mid-rollback | Throws, leaves dirty state | Retries once, falls back to `git checkout`, cleans up |
| Invalid `--profile` flag | Crashes | Warns, falls back to `minimal`, keeps running |

## Who Uses This

- **Engineers running overnight agent loops** — you need a kill switch that actually works, and a receipt in the morning
- **Teams with shared API budgets** — you need per-task spend caps, not org-wide prayer
- **Anyone reviewing agent-generated PRs** — the dossier shows what the agent tried, what passed, and what didn't

## Requirements

- Node.js 20+
- One AI coding CLI: [Claude Code](https://docs.anthropic.com/claude-code), [Codex](https://github.com/openai/codex), or [Gemini CLI](https://github.com/google/gemini-cli)

## Links

- [martin-loop](https://www.npmjs.com/package/martin-loop) — the standalone CLI
- [GitHub](https://github.com/Keesan12/martin-loop) — source and issues
- [martinloop.com](https://martinloop.com)

## License

Apache-2.0
