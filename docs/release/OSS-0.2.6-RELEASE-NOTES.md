# MartinLoop OSS v0.2.6

## Highlights

- closes the public audit remediation train for the remaining `v0.2.5` follow-up findings
- hardens the verifier command leash against additional destructive command shapes
- broadens context-integrity scanning across task metadata and verifier output
- adds model-aware budget preflight pricing, grounding cache invalidation, and configurable red-phase model selection
- tightens MCP path validation and adds local `martin_run` abuse controls

## Security and Safety

- blocks additional destructive verifier command variants including split-flag `rm`, absolute-path destructive executables, scoped `npx --yes` packages, `find -delete`, `find -exec rm`, `node -e`, `shred`, `truncate`, and split-flag `git clean -f -d`
- restores high-signal secret redaction coverage for connection strings, bearer tokens, AWS-style secrets, Stripe keys, and generic secret-bearing environment variables
- expands context-integrity detection for authority-inversion phrasing such as instruction override attempts, system override markers, and identity reassignment prompts
- scans task title, task objective, verifier stdout, and verifier stderr before those channels can influence later loop behavior
- rejects URL-encoded path traversal patterns in MCP safe-path inputs
- enforces process-local `martin_run` concurrency and start-rate limits with structured rate-limit failures

## Reliability

- uses model-aware budget preflight pricing with explicit override precedence
- rebuilds cached repo grounding indexes when indexed files change
- lets the red phase resolve its model from an explicit option or `MARTIN_RED_PHASE_MODEL` before falling back to the default

## Release Proof

- audit closure matrix: `docs/release/v0.2.6-audit-closure.md`
- machine-readable closure packet: `docs/release/v0.2.6-audit-closure.json`
