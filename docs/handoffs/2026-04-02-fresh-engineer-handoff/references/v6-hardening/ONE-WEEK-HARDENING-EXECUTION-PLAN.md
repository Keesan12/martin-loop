# One-Week Hardening Execution Plan

## Goal
In one week, move Martin from “promising rebuild” to “trustworthy hardening candidate.”

## Day 1: Golden path and crash elimination
- fix missing functions and crashing adapter/runtime paths
- certify one canonical adapter path
- add fatal-path tests
- deliver baseline stability report

## Day 2: Grounding Integrity core
- build anatomy snapshot
- changed-file and dependency delta capture
- missing symbol / unresolved reference collection
- grounding verdict v1
- grounding challenge tests 1–5

## Day 3: Budget Control v3 core
- add preflight estimator
- implement accounting mode distinction
- add admission block
- persist settlement artifacts
- budget challenge tests 6–9

## Day 4: Leash v2 and patch truth
- command allowlist and path protections
- network and dependency approval gates
- patch score + decision logic
- safety challenge tests 10–13 and patch tests 14–17

## Day 5: Certification, read-model truth, claim freeze
- run full challenge set
- produce certification evidence pack
- update read model with grounding/budget/leash/patch views
- update claim freeze matrix and launch wording

## Daily deliverables
- branch or PR summary
- passing tests added
- unresolved blockers list
- updated release risk register
