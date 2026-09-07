# MartinLoop 0.6.0

MartinLoop 0.6.0 makes the first governed run more reliable and keeps its evidence truthful from execution through handoff.

## What changed

- Older installations receive a non-blocking upgrade notice on stderr while commands continue normally; JSON stdout remains machine-readable.
- Verified Handoffs preserve completed verifier evidence even when a budget boundary determines the final run outcome.
- MCP installation refreshes stale canonical MartinLoop entries while preserving unrelated host configuration.
- Empty objectives fail before engine discovery or agent spend.
- `martin-loop demo` creates a ready-to-run Git workspace automatically.
- The packaged GitHub Actions budget-gate example now includes its runnable workflow.

## Install

```sh
npx -y martin-loop@0.6.0 --version
npx -y martin-loop@0.6.0 demo
npx -y @martinloop/mcp@0.6.0
```

Publication is complete only after both npm artifacts and their GitHub releases are visible and independently verified.
