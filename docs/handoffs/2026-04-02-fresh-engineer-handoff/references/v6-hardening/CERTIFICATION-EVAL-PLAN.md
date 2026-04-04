# Certification Eval Plan

## Objective
Produce a certification-grade proof set for Martin Loop hardening.

## Test lanes
1. Unit tests
2. Runtime integration tests
3. Adapter contract tests
4. Challenge set tests
5. End-to-end bakeoff tasks
6. Staging provider-path tests

## Mandatory certification scenarios
- grounding failure
- budget admission block
- unsafe command block
- no-progress halt
- exact vs estimated accounting distinction
- keep/discard correctness
- golden path success

## Evidence package for each scenario
- contract
- compiled context packet summary
- adapter request metadata
- verifier artifacts
- grounding artifact
- budget artifact
- patch decision artifact
- read-model screenshot or JSON summary

## Release gate
The product does not ship until every mandatory scenario has:
- deterministic expected outcome,
- passing result,
- persisted evidence,
- no critical crash.
