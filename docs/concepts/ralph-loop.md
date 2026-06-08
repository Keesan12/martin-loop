# Ralph-Style Loops

A Ralph-style loop is the failure mode where an AI coding agent keeps trying without knowing when continuing is unsafe, uneconomical, or unlikely to succeed.

The loop itself is not the problem. Attempt, check, retry is a useful pattern. The risk comes from running that pattern without a budget, verifier, scope, stop reason, or audit trail.

MartinLoop adds the missing control layer:

- budget checks before the next attempt
- verifier-gated completion
- scope and policy checks before execution
- structured records for every run
- rollback evidence when repo-backed persistence is configured

If a coding agent keeps retrying without producing a verified result, MartinLoop is designed to stop the loop with an inspectable reason instead of letting it drift.
