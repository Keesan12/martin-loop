# MartinLoop 0.5.1

Your coding agent says it is done. MartinLoop makes it prove it.

MartinLoop 0.5.1 delivers a coherent path from **Definition of Done** to **Controlled Run** to **Verified Handoff**, with the same evidence language across the terminal, MCP hosts, receipts, and share bundles.

## What ships

- A truthful Governed Run Plan before execution and a Verified Handoff after it, with clear `VERIFIED`, `STOPPED`, and `NEEDS REVIEW` outcomes.
- Model-agnostic execution: the user, coding agent, or provider chooses the model. MartinLoop observes usage, applies budget controls, and records cost provenance without injecting a hard-coded model.
- Verifier-only execution that runs configured checks and records real evidence without pretending an editing agent ran.
- Grounding and receipt-integrity boundaries that preserve useful execution while preventing missing evidence from becoming a false verification claim.
- Responsive terminal tables, semantic status colors, safe motion, and optional Arcade presentation that never changes run evidence or outcome.
- Markdown-first MCP/IDE responses with preserved `structuredContent` and compatibility JSON.
- Install, verify, rollback, and uninstall support for established MCP hosts.
- A validated, checksummed MCPB `0.5.1` bundle attached to the GitHub release.

## Install

```sh
npx -y martin-loop@0.5.1 start
npx -y @martinloop/mcp@0.5.1
```

## Govern and verify

```sh
npx -y martin-loop@0.5.1 run "Fix the failing test" --verify "npm test" --budget-usd 2 --max-iterations 3
npx -y martin-loop@0.5.1 dossier --latest
npx -y martin-loop@0.5.1 runs verify --latest
```

## Trust boundary

`VERIFIED` means the configured checks passed for the recorded run and evidence boundary. It is not a claim that code is universally correct or automatically safe to merge. Review the diff, verifier commands, scope, receipt integrity, and unresolved findings before accepting a change.

## Release artifacts

- `martin-loop@0.5.1`
- `@martinloop/mcp@0.5.1`
- `martinloop-0.5.1.mcpb` plus SHA-256 checksum
