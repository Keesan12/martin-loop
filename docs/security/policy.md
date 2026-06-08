# Security Policy Model

MartinLoop treats agent execution as a bounded contract. A run should know what it is allowed to do before it starts.

Policy checks include:

- verifier command safety
- allowed and denied path rules
- dependency or migration changes that require review
- secret-like values in task text
- prompt and tool-output patterns that attempt to override the run contract

When a check fails, MartinLoop stops or escalates instead of silently continuing.
