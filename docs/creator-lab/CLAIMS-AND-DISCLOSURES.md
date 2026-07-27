# Creator Claims and Disclosure Rules

This page protects creators, viewers, and MartinLoop from overstating what one run proves.

## Claim-safe language

Creators may say MartinLoop:

- adds explicit USD, token, and iteration budgets to supported coding-agent runs
- requires a configured verifier before a run can count as complete
- records attempts, stop reasons, verifier evidence, spend posture, and receipt integrity
- exports local Markdown and JSON receipt bundles
- can generate opt-in SVG and PNG proof cards
- supports public benchmark lanes included with the published package
- is open source under Apache-2.0
- works with supported installed adapters and MCP hosts described in the current public documentation

## Claims that require the creator's own evidence

Only say these when the creator's published receipt and experiment support them:

- the task finished inside budget
- the verifier passed
- the run used a particular amount of spend
- one agent was cheaper or more effective than another
- MartinLoop stopped a next attempt before additional spend
- rollback evidence was recorded
- the receipt integrity check passed
- a specific failure mode was prevented

Keep the receipt, terminal capture, verifier output, and comparison method available for review.

## Claims to avoid

Do not claim that MartinLoop:

- guarantees correct code
- guarantees security, compliance, or production safety
- always reduces cost
- makes every run fully reversible
- proves rollback when rollback evidence is absent
- supports every coding agent or every model
- replaces human code review
- prevents all hallucinations, failures, or destructive actions
- reproduced an original private incident exactly when only a simplified public reproduction was tested
- saved an exact dollar amount when the controlled and uncontrolled runs were not directly comparable

## The evidence-boundary rule

A creator must preserve any evidence boundary displayed by MartinLoop.

Example:

- verifier: passed
- receipt integrity: signed
- rollback evidence: not recorded
- proof state: `EVIDENCE_BOUNDARY`

The correct interpretation is:

> The verifier passed and the receipt integrity was signed, but the run does not contain evidence that rollback was recorded.

The incorrect interpretation is:

> The run was fully verified and reversible.

## Proof-mode rule

`--proof` is a no-spend proof adapter lane. It may be used to teach the receipt format or governance flow.

It must not be described as:

- a live Claude, Codex, Gemini, or OpenAI coding run
- evidence of real model spend
- evidence that an external coding adapter completed the task
- the main proof asset in creator outreach

For external creator demonstrations, use a real installed adapter confirmed by `doctor`.

## Comparison rules

For agent-versus-agent content:

- start from the same clean repository state
- use the same task, verifier, budget, and maximum attempts
- disclose model and adapter versions when available
- include failed and stopped runs
- compare reviewable outcomes, not spend alone
- disclose manual interventions
- disclose cache, credit, or pricing assumptions that affect the comparison

## Sponsorship and material relationships

Creators must clearly disclose any material relationship, including:

- cash sponsorship
- affiliate or referral revenue
- free paid-plan access
- travel, equipment, or production support
- ownership, advisory, or investment relationships
- performance bonuses or qualified-lead payments

Use the disclosure tools and wording required by the creator's platform and local law. The disclosure should appear before or at the beginning of the promotional claim, not only in a collapsed description.

Suggested plain-language wording:

> MartinLoop provided access and technical support for this experiment. They did not approve my verdict or remove failed results.

For paid content:

> This video is sponsored by MartinLoop. I selected the task and agent, and the receipt shown is the actual result of my run.

For affiliate relationships:

> The link below is a tracked referral link, and I may earn revenue if you become a paying customer.

## Editorial independence

MartinLoop may review a draft for factual errors, exposed secrets, or unsafe commands. MartinLoop should not require a positive conclusion or prevent publication of a failed run.

Creators should not share private keys, credentials, proprietary source code, personal data, or confidential client information in terminals, receipts, screenshots, or diffs.

## Current public sample

The current public live receipt records:

- spend: `$0.51`
- budget: `$3.00`
- attempts: `1`
- verifier: passed
- rollback: not recorded
- receipt integrity: signed
- proof state: evidence boundary

Use the receipt and its qualifications together. Do not separate the positive verifier result from the missing rollback evidence.

- [Live receipt](../examples/proof-receipts/live-governed-run-receipt.md)
- [Creator Lab](./README.md)
- [Creator experiments](./EXPERIMENTS.md)
