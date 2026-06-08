# Prompt And Context Integrity

AI coding agents can receive instructions through user prompts, tool output, and prior attempt history. Before each attempt, MartinLoop's Context Integrity Pre-gate scans the compiled task focus, the verifier/test output captured from prior attempts, and a summary of prior attempt outcomes for high-signal attempts to redefine the agent's identity, override the run contract, or escalate authority — before that text re-enters the loop as part of the next prompt.

Separately, the grounding scanner inspects the resulting patch diff against a repo-aware index after each attempt and flags changes that touch files or symbols outside the declared scope. That is a distinct gate from the Context Integrity Pre-gate described here — it is what actually covers "repository files," recorded as a `grounding-scan.json` artifact on each attempt.

Examples of suspicious patterns:

- instruction override attempts
- authority inversion
- identity redefinition
- requests to ignore the verifier or budget
- attempts to bypass repository scope

The goal is not to classify every string perfectly. The goal is to catch high-signal attempts to alter the run contract before another attempt is admitted.
