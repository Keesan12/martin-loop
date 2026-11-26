# MartinLoop 1.0.0

MartinLoop 1.0.0 strengthens model verification, usage accounting, and receipt integrity for governed coding runs.

## What changed

- Governed runs bind work to a concrete provider model and validate any explicitly approved fallback before running it.
- CLI and MCP readiness checks report provider availability, model selection, pricing, and workspace scope before a run.
- Codex can verify the model against the exact execution session when its completion event omits the model.
- Failed attempts retain observed token usage and distinguish reported costs, estimates, and unavailable pricing.
- Provider-free governed runs use a budget of exactly $0. Live governed runs require a positive budget.
- Set `--soft-time-limit-ms` on `martin run` or `martin preflight` to configure an optional wrap-up threshold. During a run, MartinLoop warns when the threshold is reached, lets an in-flight attempt finish and settle, and starts no further attempts. SDK adapters can listen for the advisory `wrapUpSignal` and wrap up cooperatively. The hard deadline set by `--max-wall-clock-ms` still bounds execution.
- On Windows, governed Codex runs use evidence from their own execution session, including when several runs are active.

## Install

Verify 1.0.0 is available with `npm view martin-loop@1.0.0 version`, then run `npx -y martin-loop@1.0.0 --version` to verify the pinned CLI package.

## Verification

Release verification covers the CLI and MCP packages, installed artifacts, provider execution, and supported platforms. The [version ledger](./VERSION-LEDGER.md) links to the published artifacts.
