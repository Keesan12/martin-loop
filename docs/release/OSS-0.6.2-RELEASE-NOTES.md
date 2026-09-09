# MartinLoop 0.6.2

MartinLoop 0.6.2 is a deterministic hardening release for the Codex governed-execution path and the public release surface.

## What changed

- Codex autonomy resolutions used by tests now carry the same successful launch-probe provenance required by production code.
- The Codex execution contract stays fail-closed when caller-created autonomy resolution is not launch-probe verified.
- Public README guard coverage now matches the current product-facing README structure instead of stale pre-0.6.1 copy.
- Generated MCP install links are pinned to the exact `@martinloop/mcp@0.6.2` package line for deterministic host setup.
- Root package, standalone MCP package, plugin metadata, MCPB product version, release-truth metadata, and built runtime version authority align at `0.6.2`.

## Install

```sh
npx -y martin-loop@0.6.2 --version
npx -y martin-loop@0.6.2 doctor --engine codex
npx -y @martinloop/mcp@0.6.2
```
