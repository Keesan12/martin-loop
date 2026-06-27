# MartinLoop 0.3.17 — Faster Codex startup, tighter budget controls, HTTP MCP

## What changed

### Codex session-start is now fast by default

`martin session-start --host codex` and `martin phase session-start --host codex`
no longer perform a live Codex launch probe during diagnostics. They now report
host readiness immediately and point you to `martin preflight` for the actual
live launch check.

That keeps the operator feedback loop fast while still preserving the governed
launch validation in the right place.

### Claude budget enforcement is tighter on expensive turns

Governed Claude runs now pass the remaining token budget through to the
subprocess and enforce stricter stop conditions when a prompt is unusually
large or a single turn tries to consume a disproportionate share of the
remaining budget.

This reduces one-turn overshoot risk without waiting for the next attempt to
discover that the run has already spent too much.

### The MCP server can now run over local HTTP

The standalone MCP package now supports:

```sh
npx -y @martinloop/mcp --http --port 3033
```

stdio remains the default for host installs, but local bridges and proxies can
now use a first-party HTTP endpoint instead of wrapping the process
themselves.

### Agents can now read MartinLoop mode directly

The new `martin://agent/mode-status` resource tells a host which working mode
is currently active (`auto`, `plan`, or `edits`), whether it came from a
project override or global default, and which commands switch modes.

### Frozen installs now work cleanly with pnpm 10

Workspace overrides now live in `pnpm-workspace.yaml`, which restores
`pnpm install --frozen-lockfile` for local validation and GitHub Actions
release runs under pnpm 10.

The workspace config also records the required non-interactive build approvals
for `esbuild` and `protobufjs`, so release installs no longer depend on a local
approval prompt.

## Why it matters

- Codex operators get immediate session-start feedback instead of waiting on a
  live probe.
- Budget enforcement stays honest on high-context Claude runs.
- MCP hosts have a cleaner path for HTTP bridge scenarios.
- Agents can reason about MartinLoop mode before they start a governed run.
- Release validation stays reproducible under the current pnpm toolchain.

## Upgrade

```sh
npm install -g martin-loop@0.3.17
```

## Verification

- Focused Codex integration and session-start tests pass with real CLI
  availability guards.
- MCP discovery and server validation tests cover the new `mode-status`
  resource and HTTP transport.
- Adapter tests cover remaining-token passthrough and the tighter spending
  guardrails.
