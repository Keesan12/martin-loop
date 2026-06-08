# Root Release Map

This map keeps the public root-package release train narrow and readable. The root `martin-loop` package and the standalone `@martinloop/mcp` package move on separate version lines.

## Baseline

- live root baseline: `0.3.1`
- current root release to cut: `0.3.2`
- next follow-on after that: `0.3.3`

## `0.3.0` — Shareable Run Receipts

Story: make governed MartinLoop runs easier to hand to another person without copying raw JSON by hand.

Includes:

- `martin share --latest`
- `martin share --loop-id <id>`
- `martin share --file <path>`
- redacted `run-receipt.json`
- human-readable `run-receipt.md`
- `proof-card.svg`

Does not include:

- automatic social posting
- hosted upload flows
- PNG rendering
- browser or clipboard integration

Release gate:

- the share command works from a packed install
- the bundle lands in the canonical run directory by default, or an explicit `--out-dir`
- absolute workstation paths are redacted from the generated artifacts

## `0.3.1` — Multi-Model And Multi-IDE Compatibility

Story: broaden local compatibility after the share flow is established.

Includes:

- compatibility docs and examples for the adapters that are already shipped
- clearer host coverage for local-first IDE and model setups
- install guidance that matches the actual public package surfaces

Does not include:

- hosted transport
- private control-plane features
- billing, team, or tenant language

## `0.3.2` — npx Parity And Trust-Surface Alignment

Story: keep public claims aligned with real runtime behavior and release metadata.

Includes:

- deterministic `npx martin-loop` version identity in mixed workspace contexts
- root release notes and ledger alignment for `0.3.2`
- public standalone MCP baseline truth updates to `0.3.1`
- a public receipt specification for governed run evidence (`docs/oss/AGENT-RUN-RECEIPTS.md`)

Does not include:

- hosted transport
- private control-plane features
- billing, team, or tenant language
