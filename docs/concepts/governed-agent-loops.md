# Governed Agent Loops

An AI coding loop usually follows a simple pattern: attempt the task, run checks, retry on failure, and repeat. That pattern is useful, but it needs limits when it can spend tokens, edit files, or continue after repeated failure.

MartinLoop adds governance around the loop:

- a budget before work begins
- a verifier that defines success
- file-scope rules for what the agent may touch
- policy checks before execution
- evidence after each run

The agent still does the coding work. MartinLoop decides whether the next attempt is allowed, whether the result is verified, and what evidence is saved for review.
