# @martinloop/mcp

You give an AI agent a coding task. It runs. You get a bill.

But did it actually work? Did it pass your tests? How much did it spend? What files did it touch? Did it loop 47 times trying the same broken approach?

You don't know. And that's the problem.

## One system around the coding agent

MartinLoop is the execution-control system around coding agents. The coding agent still performs the software work. MartinLoop connects the run from Definition of Done through preflight, control, verification, recovery evidence, receipts, and post-run analysis.

```text
DEFINE -> PREFLIGHT -> CONTROL -> VERIFY -> RECOVER -> PROVE -> ANALYZE
```

The product-level flow is **Definition of Done -> Controlled Run -> Verified Handoff**.

Through MCP, compatible hosts can use the same MartinLoop lifecycle without giving up the host's own model selection. MartinLoop does not inject a hidden fallback model.

For agent-readable product context see [`../../llms.txt`](../../llms.txt), [`../../llms-full.txt`](../../llms-full.txt), and [`../../docs/for-agents.md`](../../docs/for-agents.md).

## What This Does

MartinLoop governs AI coding-agent execution. You define what the run needs to accomplish, set execution boundaries such as budget and verifier checks, and let the configured coding agent do the work inside that contract.

When it's done, you get a receipt — not a vague summary, but a structured record: dollars spent when available, attempts made, verification results, files changed, recovery state, and what the available evidence established.

The final governed outcome is one of:

- `VERIFIED` when the configured evidence supports the Definition of Done
- `STOPPED` when a configured hard boundary ends the run
- `NEEDS REVIEW` when completion cannot be established from the available evidence

**One line to connect it:**

```sh
claude mcp add martin-loop -- npx -y @martinloop/mcp
```

That's it. Your host can now use MartinLoop's governed run and evidence surfaces.

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
claude mcp add martin-loop -- npx -y @martinloop/mcp@0.5.5
```

Windows:
```sh
claude mcp add --transport stdio --scope user martin-loop -- cmd /c npx -y @martinloop/mcp@0.5.5
```

### Codex
```sh
codex mcp add martin-loop -- npx -y @martinloop/mcp@0.5.5
```

### Gemini CLI
```sh
gemini mcp add martin-loop -- npx -y @martinloop/mcp@0.5.5
```

### Any MCP Host
```sh
npx -y @martinloop/mcp@0.5.5
```

## How a Governed Run Works

```
You: "Fix the auth bug. Budget $3. Verify: npm test"

  martin_doctor     →  checks CLI, auth, environment
  martin_plan       →  scopes the task, sets constraints
  martin_preflight  →  validates before any spend
  martin_run        →  agent works inside budget + verifier gates
  martin_dossier    →  receipt: spend, attempts, verifier evidence, final outcome
```

Every attempt can be checked by your configured verifier. Budget and policy controls stay attached to the run. If the agent drifts off-task, the scope contract can block the change. If a hard spend boundary is reached, the run stops according to policy instead of silently retrying forever.

## What Your Agent Gets

### MCP Tools

The exact tool set is discoverable from the running MCP server with `tools/list`; do not rely on a hard-coded count in documentation.

**Run the loop:**
`martin_doctor` `martin_plan` `martin_preflight` `martin_run` `martin_pause` `martin_continue` `martin_cancel`

**Inspect results:**
`martin_status` `martin_logs` `martin_dossier` `martin_eval` `martin_inspect` `martin_list_runs` `martin_get_run` `martin_get_attempt` `martin_get_verification_results` `martin_triage_runs`

**Ship the work:**
`martin_pr_summary` `martin_create_pr` `martin_review_pr`

### Read-Only Resources

The exact resource set is discoverable from the running MCP server; this documentation names the primary public resources without treating a count as a release invariant.

Your agent can pull context without side effects:

`martin://runs/latest` · `martin://runs/latest/proof-card` · `martin://runs/latest/budget-status` · `martin://runs/latest/verifier-evidence` · `martin://runs/recent` · `martin://server/health` · `martin://policies/current` · `martin://agent/next-step` · `martin://guides/mcp-usage` · `martin://guides/agent-start` · `martin://repo/risk-map`

### Configuration Profiles

Generate host config tuned to your workflow:

```sh
npx martin-loop mcp print-config --host claude --profile minimal        # run + inspect
npx martin-loop mcp print-config --host claude --profile diagnostic     # + doctor + triage
npx martin-loop mcp print-config --host claude --profile full-local     # all local tools
npx martin-loop mcp print-config --host claude --profile github-review  # + PR workflow
```

## What Happens When Things Go Wrong

MartinLoop does not round failure into success. It preserves the evidence and follows the configured recovery path while budget and policy still allow useful work.

| Failure | Old behavior | Now |
|---|---|---|
| CLI not on PATH | Error message, dead stop | Searches npm global, homebrew, nvm, scoop — uses what it finds |
| Verifier says "command not found" | Generic "verification failed" | Carries specific failure context into the next allowed attempt |
| `git restore` fails mid-rollback | Throws, leaves dirty state | Retries once, falls back to `git checkout`, cleans up |
| Invalid `--profile` flag | Crashes | Warns, falls back to `minimal`, keeps running |

## Codex compatibility in 0.5.5

MartinLoop no longer assumes one Codex host or one fixed Codex flag set. The CLI resolves the exact Codex executable, reads its advertised capabilities, negotiates a supported write strategy, proves that strategy before reporting launch readiness, and reuses the same contract for the governed run.

That means MCP hosts can point MartinLoop at different Codex installations without requiring a documentation-specific approval or sandbox flag to exist everywhere.

## Presentation and evidence

MCP responses are Markdown-first for humans while retaining structured content for agents and automation. The presentation layer does not rewrite governed truth.

MartinLoop Arcade is a terminal-only experience. It does not run inside MCP and cannot influence MCP evidence, budgets, verification, or final outcomes.

## Who Uses This

- **Engineers running overnight agent loops** — you need a kill switch that actually works, and a receipt in the morning
- **Teams with shared API budgets** — you need per-task spend caps, not org-wide prayer
- **Anyone reviewing agent-generated PRs** — the dossier shows what the agent tried, what passed, and what didn't
- **Teams tired of stitching together point tools** — you want one execution-control lifecycle around coding-agent work from preflight through post-run analysis

## Requirements

- Node.js 20+
- One AI coding CLI: [Claude Code](https://docs.anthropic.com/claude-code), [Codex](https://github.com/openai/codex), or [Gemini CLI](https://github.com/google/gemini-cli)

## Links

- [martin-loop](https://www.npmjs.com/package/martin-loop) — the standalone CLI
- [MartinLoop for AI Agents](../../docs/for-agents.md)
- [GitHub](https://github.com/Keesan12/martin-loop) — source and issues
- [martinloop.com](https://martinloop.com)

## License

Apache-2.0
