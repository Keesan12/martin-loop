# Prompt And Context Integrity

AI coding agents can receive instructions through user prompts, tool output, logs, test output, and repository files. MartinLoop scans high-risk text channels before they re-enter the loop.

Examples of suspicious patterns:

- instruction override attempts
- authority inversion
- identity redefinition
- requests to ignore the verifier or budget
- attempts to bypass repository scope

The goal is not to classify every string perfectly. The goal is to catch high-signal attempts to alter the run contract before another attempt is admitted.
