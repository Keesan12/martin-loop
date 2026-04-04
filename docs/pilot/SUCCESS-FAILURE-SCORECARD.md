# Pilot Success And Failure Scorecard

## Success Signals

- operators can explain why Martin stopped, retried, discarded, or escalated from artifacts alone
- no silent grounding failures appear in reviewed runs
- no unsafe execution escapes the approved trust profile
- rollback evidence is present and understandable when restore is required
- accounting labels remain honest and do not blur `actual` with `estimated`

## Failure Signals

- unexplained repo mutations or restore ambiguity
- misleading spend reporting
- grounding claims that do not match verifier or grounding artifacts
- repeated safety blocks that operators cannot explain from the artifact bundle
- a task class that repeatedly requires human intervention without producing reliable value

## Stop Conditions

- stop using Martin for the current repo or task class when the failure signals outweigh the success signals
- stop widening pilot scope when cross-platform behavior is still inconsistent
- stop pilot expansion immediately if a restore failure leaves repo state ambiguous
