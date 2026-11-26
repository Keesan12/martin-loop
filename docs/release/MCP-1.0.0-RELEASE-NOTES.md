# MartinLoop MCP 1.0.0

MartinLoop MCP 1.0.0 brings the same model verification, run controls, and receipt accounting to MCP clients.

## What changed

- Readiness checks report provider, model, pricing, and workspace availability before governed execution.
- Governed runs validate concrete model selection and explicit fallback choices.
- Failed provider attempts retain observed usage and report pricing uncertainty in their evidence.
- `martin_plan`, `martin_preflight`, and `martin_run` accept optional `softTimeLimitMs` and `maxWallClockMs` inputs. At the soft limit, the run warns, leaves any active attempt room to finish and settle, and starts no further attempts. The hard limit still bounds execution.
- The MCP npm package, plug-in, server metadata, and MCPB product version are aligned at 1.0.0.

## Install

Verify 1.0.0 is available with `npm view @martinloop/mcp@1.0.0 version`, then point a supported MCP client at `npx -y @martinloop/mcp@1.0.0`.

## Verification

Release verification covers installed package discovery, MCPB validation, and the registry listing. The [version ledger](./VERSION-LEDGER.md) links to the published artifacts.
