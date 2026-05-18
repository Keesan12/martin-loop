# Martin Loop Hardening Charter

## Purpose
This document defines the next program of work after the initial rebuild slices. The goal is not to add more product surface area. The goal is to make Martin Loop trustworthy enough that a skeptical senior engineer from a top-tier company can review the design, inspect the artifacts, and conclude that the system is evidence-driven, bounded, and auditable.

## Operating principle
Martin Loop is not allowed to market or imply capabilities that it cannot prove from runtime artifacts.

## Hardening pillars
1. **Grounding Integrity**
   - Replace soft “hallucination” language with hard grounding verdicts backed by evidence.
   - Detect missing symbols, invented modules, unapproved dependencies, and unsupported completion claims.
2. **Budget Control v3**
   - Move budget from post-hoc reporting to preflight admission control, in-flight accounting, and next-attempt permission gating.
3. **Leash v2**
   - Bound filesystem access, commands, network, patch size, time, and spend.
   - Require human approval for risky changes.
4. **Patch Truth**
   - Keep, discard, escalate, or handoff decisions must be evidence-backed and deterministic.
5. **Golden Path Stability**
   - One canonical execution path must run reliably end-to-end before additional complexity is added.

## What success looks like
- A task enters with an immutable contract.
- The runtime compiles a minimal grounded context packet.
- The adapter executes only if the task is admitted by budget and safety policy.
- Verification artifacts, grounding evidence, and spend data are persisted for every attempt.
- The loop ends with an explainable decision and a truthful read model.

## What does not count as success
- A dashboard that looks convincing but derives from missing or estimated data without visible labeling.
- A taxonomy label without evidence.
- A budget number that cannot be tied to preflight, settlement, and provider mode.
- A completion claim that is not supported by verifier artifacts.
- A safety system that warns but does not block.

## Hardening rules
1. Do not add new top-level product claims until their proof artifacts exist.
2. Do not add more adapters until the golden path is stable.
3. Do not hide estimated values as exact values.
4. Do not keep patches by default.
5. Do not allow free-form mutable progress text to become the source of truth.

## One-week outcome target
At the end of the one-week hardening sprint, the team should be able to demonstrate:
- one stable golden path,
- grounding failure detection on challenge cases,
- budget admission blocking,
- leash blocking on unsafe commands,
- patch keep/discard decisions with evidence,
- a read-model view that traces every number to runtime artifacts.
