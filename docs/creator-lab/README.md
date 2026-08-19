# MartinLoop Creator Lab

The MartinLoop Creator Lab gives technical creators a complete, reproducible content package for testing governed AI coding work.

The goal is not a scripted endorsement. The creator chooses the agent and task, runs the experiment, and publishes the actual result — including failures, evidence boundaries, and cost.

## The flagship experiment

### The Under-$3 Governed Agent Challenge

Give a coding agent one real software task and ask:

> Can the agent complete useful work, pass the verifier, and stay inside a hard `$3.00` budget?

The resulting content has a natural story:

1. Show the task and repository.
2. Set the budget, verifier, and maximum attempts.
3. Run the creator's preferred coding agent through MartinLoop.
4. Reveal the spend, attempts, verifier result, stop reason, changed files, and receipt integrity.
5. Explain what the receipt proves — and what it does not prove.
6. Give viewers the exact command and task so they can reproduce it.

## What MartinLoop is

MartinLoop is an open-source independent control layer for coding agents. It makes each run bounded, verified, reversible where evidence exists, priced, and provable.

It works across Claude, Codex, Gemini, Cursor-connected workflows, and internal agent systems through the supported CLI and MCP surfaces.

MartinLoop is not another coding agent. It governs the agents creators and developers already use.

The current public narrative is end to end:

```text
DEFINE -> PREFLIGHT -> CONTROL -> VERIFY -> RECOVER -> PROVE -> ANALYZE
```

Creators should show that full lifecycle when the experiment supports it. The useful contrast is not "another AI coding tool." It is one execution-control system around the coding agent instead of separate scripts and point tools for budgets, retries, stopping, verification, recovery, receipts, history, and analysis.

For agent-readable context see [`../../llms.txt`](../../llms.txt), [`../../llms-full.txt`](../../llms-full.txt), and [`../for-agents.md`](../for-agents.md).

## One-command starting point

```sh
npx -y martin-loop@latest start
npx -y martin-loop@latest demo
```

For a live governed run:

```sh
cd martin-loop-demo
npm install
npx -y martin-loop@latest run \
  "Summarize the demo workspace and prove tests still pass" \
  --verify "npm test" \
  --budget-usd 3 \
  --max-iterations 1
```

Export the result:

```sh
npx -y martin-loop@latest dossier --latest
npx -y martin-loop@latest runs verify --latest
npx -y martin-loop@latest share --latest --with-proof-card --proof-card-format both
```

## Creator package

Every Creator Lab package should include:

- this program brief
- one creator-specific experiment idea tied to the creator's recent content
- a pre-tested setup lane
- three title options
- three thumbnail concepts
- a long-form video outline
- a short-form script
- screen-recording and B-roll checklist
- sample Markdown and JSON receipts
- sample proof-card image
- claim and disclosure rules
- installation and troubleshooting notes
- video-description and pinned-comment copy
- a unique campaign link and creator code

## Content formats

### Technical walkthrough

**Best for:** Claude Code, Codex, Cursor, MCP, and developer-tool audiences.

**Hook:**

> Everyone benchmarks whether an agent can finish the task. Almost nobody benchmarks whether it can finish inside a budget with evidence.

### Agent comparison

**Best for:** review and comparison channels.

**Hook:**

> Same repository. Same task. Same verifier. Same `$3.00` budget. Different agent.

### Cost-control story

**Best for:** automation, agency, and founder audiences.

**Hook:**

> A fixed-price client project stops being fixed-price when the agent can retry without limits.

### Govern Your Worst Run

**Best for:** livestreams, communities, and audience-participation content.

**Hook:**

> Send me the agent run that cost too much or failed too many times. We will rerun the pattern with a budget, verifier, and receipt.

## Suggested titles

- I Gave Claude Code a Hard `$3` Budget
- Claude vs Codex: Verified Work Per Dollar
- This Stops AI Coding Agents From Looping Forever
- I Made an AI Coding Agent Produce a Receipt
- The Missing Safety Layer Around Claude Code
- Can an AI Agent Fix This Before the Budget Runs Out?
- Your Coding Agent Has No Brakes
- The Real Cost of an Autonomous Coding Run
- I Tested an AI Agent With a Budget and a Verifier
- What Actually Happened During This Agent Run?

## Suggested thumbnail directions

1. **Budget countdown:** agent logo, `$3.00`, red stop line, receipt.
2. **Agent versus receipt:** agent terminal on the left, signed proof card on the right.
3. **Same task comparison:** two agent logos, identical task, cost and verifier score beneath each.
4. **Runaway loop:** retry counter rising until MartinLoop stops the next attempt.
5. **Evidence boundary:** green verifier plus a visible warning that rollback proof was not recorded.

## Long-form video outline

### 0:00 — The uncontrolled-run problem

Show a real example of retries, surprise cost, uncertain completion, or an unreviewable diff.

### 0:30 — The experiment contract

State the objective, allowed repository, verifier command, budget, and maximum attempts.

### 1:15 — Setup

Install MartinLoop and show the selected coding adapter.

### 2:00 — Run

Start the governed task. Keep the terminal visible. Arcade mode may be used during a longer interactive run, but it is not the proof.

### 4:00 — Inspect the outcome

Show spend, attempts, stop reason, verifier output, changed files, and receipt integrity.

### 6:00 — What the evidence means

Explain any missing rollback evidence, unverified claims, or other evidence boundaries. Do not hide them.

### 7:00 — Verdict

Discuss whether the run was useful, economical, and reviewable. A failure can still be a valuable result when the control layer stopped it safely.

### 8:00 — Audience reproduction

Give viewers the exact command, repository/task, and campaign link.

## Short-form script

> AI coding agents can edit files and run commands, but most runs still have no hard budget or trustworthy receipt. I gave this agent one task, one verifier, and a `$3.00` cap. MartinLoop recorded every attempt, stopped the run according to policy, and exported the result as a receipt. The interesting part is not whether the agent looked confident — it is whether the evidence says the work passed.

## B-roll checklist

- terminal showing `martin-loop start`
- agent adapter availability from `doctor`
- objective, verifier, and budget before execution
- active spend or attempt information
- verifier output
- dossier summary
- `runs verify --latest`
- generated Markdown receipt
- generated JSON receipt
- proof-card PNG/SVG
- Git diff or changed-file review
- optional Arcade mode footage during a long interactive run
- Governed Run Plan presentation before execution
- Verified Handoff presentation after execution
- post-run dossier or history view that keeps the final outcome and evidence boundaries visible

## Creator independence

Creators may criticize MartinLoop, compare it with alternatives, or publish a failed result. MartinLoop should not request editorial approval or suppress evidence boundaries.

Creators must disclose paid sponsorships, free access, affiliate relationships, or other material relationships according to the rules that apply to their platform and location.

## Public proof anchor

The repository includes a live governed receipt recording `$0.51` of spend against a `$3.00` budget, a passing verifier, and signed integrity. It also records an `EVIDENCE_BOUNDARY` because rollback evidence was not present. That qualification must remain attached to the example.

- [Live receipt](../examples/proof-receipts/live-governed-run-receipt.md)
- [Benchmark and receipt reproduction](../oss/BENCHMARK-RECEIPT-PAGE.md)
- [Creator experiments](./EXPERIMENTS.md)
- [Claims and disclosure rules](./CLAIMS-AND-DISCLOSURES.md)

## Contact

- Website: https://martinloop.com
- GitHub: https://github.com/Keesan12/martin-loop
- Email: keesan@martinloop.com
