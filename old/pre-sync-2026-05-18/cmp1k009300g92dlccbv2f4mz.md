---
title: "AI Coding Agents Need Receipts, Not Just Better Prompts"
datePublished: 2026-05-11T18:47:07.339Z
cuid: cmp1k009300g92dlccbv2f4mz
slug: ai-coding-agents-need-receipts-not-just-better-prompts
cover: https://cdn.hashnode.com/uploads/covers/6a021686fca21b0d4b51c1b3/5eca661c-2dbf-47f5-9e45-829331cf39f5.jpg

---

AI coding agents are crossing an important line.

They are no longer just autocomplete.

They can read a repo, plan a fix, edit files, run commands, inspect errors, retry strategies, and submit something that looks like finished work.

That is powerful.

It is also dangerous in a very boring, engineering-specific way.

The scary failure mode is not that the agent crashes.

The scary failure mode is that the agent keeps going.

It retries.  
It rewrites.  
It burns tokens.  
It changes files.  
It runs commands.  
It says the task is complete.

Then another engineer opens the diff and realizes nobody can easily answer the most important question:

What actually happened?

That is the missing layer in AI coding today.

Not another prompt library.

Not another model wrapper.

Not another “10x developer” demo.

AI coding agents need receipts.

## The Wrong Question Is “Did The Agent Finish?”

Most agent workflows still treat completion as a vague binary.

Did the agent finish?

That sounds reasonable until you ask what “finish” means.

Did the model say it finished?

Did the final message sound confident?

Did one command pass?

Did the agent stop because it was done, or because it ran out of budget?

Did it solve the original task, or did it drift into a nearby problem?

Did it leave the repo in a state another engineer can safely review?

For serious engineering work, “did the agent finish?” is the wrong question.

The better question is:

> Can another engineer audit this run later?

That one question changes the entire product surface.

It forces the agent run to become an engineering artifact, not a black box.

## What An Agent Receipt Should Contain.

An agent receipt is the structured evidence trail from an AI coding run.

It should answer the questions a human reviewer actually cares about:

*   What task was attempted?
    
*   What model, agent, or tool was used?
    
*   What budget was allocated?
    
*   How much was spent?
    
*   What files changed?
    
*   What commands were run?
    
*   What tests passed?
    
*   What tests failed?
    
*   Where did the agent retry?
    
*   Where did it get stuck?
    
*   Why did it stop?
    
*   Can a human resume, revert, or rerun the work?
    

This should not be an afterthought.

Once an agent can mutate a real repository, the run record should be a first-class output.

No serious engineering team would accept a CI/CD system that silently runs, mutates state, fails vaguely, and leaves no useful logs.

AI coding agents should not get a pass just because they feel magical.

## Prompts Are Not Governance.

A better prompt can improve agent behavior.

It cannot create operational control.

Prompts do not give you cost limits.

Prompts do not create audit trails.

Prompts do not classify failure modes.

Prompts do not prove that tests passed.

Prompts do not guarantee that a repo was left in a coherent state.

Prompts are instructions.

Governance is infrastructure.

As AI coding agents move from experiments into real workflows, teams need more than clever instructions. They need control surfaces.

They need to know what the agent is allowed to do, when it should stop, how much it can spend, what evidence it must produce, and what verifier decides whether the work is actually complete.

That is not prompt engineering.

That is platform engineering.

## Budget Caps Are Necessary, But Not Enough.

The obvious first control is a budget cap.

An agent should not silently spend $30 on a task that was supposed to cost $3.

But budget caps introduce a deeper design problem:

What happens when the agent hits the limit?

A naive token cap can interrupt the agent in the middle of a change.

That can leave the repo in a worse state:

*   half-applied edits
    
*   failing tests
    
*   unclear intent
    
*   no rollback trail
    
*   no useful diagnostic
    
*   no obvious next step for the human
    

That is not safe control.

That is just interruption.

The hard part is not stopping an agent.

The hard part is stopping an agent cleanly.

## Safe Halt Boundaries.

A better design is to stop agents at safe halt boundaries.

A halt boundary is a clean state transition where the system can decide whether the run should continue, stop, escalate, or require human approval.

Instead of checking budget in the middle of an effect, the system checks budget between steps.

At each boundary, the control layer can ask:

*   Is the run still within budget?
    
*   Has the verifier passed?
    
*   Has the agent repeated the same failed strategy?
    
*   Has the task drifted?
    
*   Did the agent touch files outside scope?
    
*   Is human approval required?
    
*   Should the repo be reverted?
    
*   Should the run stop with a diagnostic?
    

The desired behavior is not:

> The agent hit budget and died.

The desired behavior is:

> The agent reached a checkpoint, halted cleanly, explained why, and left enough evidence for a human to act.

That is the difference between a kill switch and a control plane.

## Test-Verified Completion Beats Agent-Reported Completion.

Another principle matters:

Do not trust agent-reported completion.

Trust verified completion.

If an agent says it fixed the issue, the next question should be:

What proved it?

The verifier could be:

*   a unit test
    
*   an integration test
    
*   a typecheck
    
*   a lint command
    
*   a build step
    
*   a policy check
    
*   a benchmark
    
*   a human approval gate
    

Not every task has a perfect verifier.

But “the model said it is done” should not be the default standard for completion.

Engineering teams already understand this.

We do not merge code because someone says it probably works.

We run tests.

We inspect diffs.

We review changes.

We preserve logs.

AI coding agents need to fit into that world.

## Why I’m Building MartinLoop.

I’m building MartinLoop as the open-source control plane for AI coding agents.

The goal is to make autonomous coding runs:

*   bounded
    
*   inspectable
    
*   test-verifiable
    
*   auditable
    
*   reproducible
    
*   safe to halt
    
*   easier for humans to review
    

The first version focuses on the unglamorous but necessary pieces:

*   hard budget caps
    
*   JSONL run records
    
*   audit trails
    
*   failure classification
    
*   safe halt boundaries
    
*   test-verified completion
    

The core MartinLoop question is simple:

> Can another engineer audit this run later?

That question is the product.

Everything else flows from it.

## The Governance Layer Is Coming.

AI coding agents will keep getting better.

They will get faster, cheaper, more autonomous, and more deeply integrated into developer workflows.

That makes governance more important, not less.

As agents become more capable, teams will need answers to questions like:

*   Which agents are allowed to touch which repos?
    
*   What files are they allowed to edit?
    
*   What commands are they allowed to run?
    
*   What budget can they spend?
    
*   What verifier decides completion?
    
*   What happens when they fail?
    
*   What evidence is preserved?
    
*   Can the run be replayed?
    
*   Can a human resume or revert the work?
    

These are not hype questions.

They are operational questions.

They are the questions that show up when a demo becomes infrastructure.

## The Next Layer Of AI Coding.

The next layer of AI coding will not only be about better models.

It will be about better systems around those models.

Agents need budgets.

Agents need logs.

Agents need failure modes.

Agents need halt boundaries.

Agents need verifier gates.

Agents need receipts.

That is the layer MartinLoop is building.

Not because AI coding agents are bad.

Because they are becoming useful enough that we need to treat them seriously.

## Feedback Wanted.

MartinLoop is early and open source.

I’m especially interested in feedback from developers, platform engineers, DevSecOps teams, and anyone using Claude Code, Codex, Cursor, Devin-style agents, or custom coding loops in real repos.

The questions I’m working through:

1.  What should every agent run record by default?
    
2.  What failure modes should every coding agent classify?
    
3.  Should budget checks happen only at safe halt boundaries?
    
4.  What verifier gates matter most in real workflows?
    
5.  Where should this control layer live: CI, agent runtime, MCP/tool layer, or platform workflow?
    

GitHub: https://github.com/Keesan12/Martin-Loop  
Website: https://martinloop.com

AI coding agents are going to get more autonomy.

Before we give them more autonomy, we should give them receipts.