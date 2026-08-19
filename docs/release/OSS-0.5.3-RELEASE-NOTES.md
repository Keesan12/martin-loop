# MartinLoop 0.5.3

MartinLoop 0.5.3 makes Codex execution adapt to the installation you actually have instead of assuming one fixed CLI contract.

## What changed

- MartinLoop resolves the exact Codex executable it will use and reads that binary's advertised capabilities before execution.
- Global and `exec` options are kept in their correct scope instead of being treated as interchangeable.
- Sandbox, approval, automation, model, working-directory, JSON, color, and prompt transport options are used only when the resolved Codex binary advertises them.
- MartinLoop proves a writable execution strategy with a temporary workspace marker before reporting Codex launch readiness.
- Doctor, preflight, and the governed run reuse the same resolved Codex execution contract.
- Model choice stays with Codex unless the operator explicitly supplies `--model`.
- Unsupported optional flags are omitted rather than guessed, and MartinLoop never falls forward into a broader sandbox permission as a compatibility fallback.

## One system around the coding agent

MartinLoop is the execution-control system around coding agents such as Codex and Claude Code. The coding agent still writes the code. MartinLoop controls the run and makes completion prove itself.

The public workflow now reads as one connected lifecycle:

```text
DEFINE
  -> PREFLIGHT
  -> CONTROL
  -> VERIFY
  -> RECOVER
  -> PROVE
  -> ANALYZE
```

That lifecycle covers the run contract, budget, scope, execution boundaries, retries, stop conditions, verification, recovery evidence, Verified Handoff, receipts, history, failure classification, and post-run analysis without requiring teams to stitch together a separate control tool for each step.

## Governed completion

MartinLoop keeps three authoritative completion states:

- `VERIFIED` when the configured evidence supports the Definition of Done
- `STOPPED` when a configured hard boundary ends the run
- `NEEDS REVIEW` when completion cannot be established from the available evidence

A passing MartinLoop verifier establishes only what the configured checks prove. It is not a universal correctness or automatic merge-safety claim.

## Install

```sh
npx -y martin-loop@0.5.3 --version
npx -y martin-loop@0.5.3 start
```

The standalone MCP package is aligned to the same product version:

```sh
npx -y @martinloop/mcp@0.5.3
```

## Agent discovery

AI agents and coding assistants can start with the repository's `llms.txt`, `llms-full.txt`, and agent-facing documentation to understand when MartinLoop should govern a coding task, the canonical execution lifecycle, the completion states, and the public CLI and MCP entry points.
