# martin-loop 0.2.6

MartinLoop `0.2.6` tightened the public root package around runtime safety and clearer developer-facing package guidance.

## What changed

- stronger verifier-command blocking for destructive command patterns
- broader context-integrity scanning across task metadata and verifier output
- safer secret redaction and path validation
- model-aware budget pricing
- grounding cache invalidation improvements
- updated README, quickstart, and package metadata for the public root package

## Package versions at this release point

| Package | Public version |
| --- | --- |
| `martin-loop` | `0.2.6` |
| `@martinloop/mcp` | `0.2.5` |

`martin-loop` is the public CLI and SDK package. `@martinloop/mcp` stays on its own standalone version line.
