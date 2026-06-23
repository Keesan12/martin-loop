# MartinLoop 0.3.9 — Pre Work Burn

`0.3.9` introduces routing economics. Every run receipt now shows how much money was spent before the agent made its first meaningful code change.

## The Problem

Multi-agent coding systems can spend 30-70% of their budget on manager, router, and planner calls before a single line of code changes. You don't see this in the final bill. You just see "$4.82 for a bug fix" and assume the agent was writing code the whole time.

It wasn't. $2.31 of that was spent deciding what to do. MartinLoop now tracks and reports that.

## What's New

### Pre Work Burn

Every run receipt now includes:

```
Pre Work Burn: $2.31 / $4.82 total (48%)
Time to first delta: 11m 32s
Route recommendation: direct_worker_next_time
```

Pre Work Burn is the cost accumulated before the agent's first meaningful workspace change — a real file edit, not metadata, lockfiles, or cache writes.

### Route Classification

`classifyRoute()` scores task complexity and recommends whether to use direct execution or manager orchestration:

- Short, scoped, single-file tasks → direct worker (skip the coordination overhead)
- Security-sensitive, multi-file, or architectural tasks → manager orchestration
- Security + migration combined → consensus mode

The classifier considers objective length, file scope, keyword signals (auth, migration, refactor), and historical success rates.

### Routing Policy

New policy type for controlling coordination cost:

```yaml
routing:
  maxPreworkBudgetPct: 25
  maxPreworkCostUsd: 2.00
  maxManagerCalls: 2
  skipOrchestrationIfConfidenceAbove: 0.85
```

`evaluatePreworkBurnPolicy()` checks live run state against these caps.

### Cost-per-Outcome

`calculateCostPerOutcome()` returns:
- Cost per accepted change
- Cost per attempt
- Acceptance rate
- Wasted coordination spend (total spend on rejected runs, prework spend on accepted runs)

## Upgrade

```sh
npm install -g martin-loop@0.3.9
```

## Quick Check

```sh
martin-loop --version    # 0.3.9
martin-loop doctor
```
