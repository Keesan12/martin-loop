# Root Release Map

This map keeps the public root-package release train narrow and readable. The root `martin-loop` package and the standalone `@martinloop/mcp` package move on separate version lines.

## Baseline

- live root baseline: `0.2.11`
- next root release to cut: `0.3.0`
- next follow-on after that: `0.3.1`

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
