# Martin Loop Phase 13 OSS Core Boundary

Generated: 2026-04-04T05:33:38.591Z

## Verdict
**GO**

## Summary
- Public package target: martin-loop
- Canonical public package manager: npm
- Intended OSS core packages: 5
- Non-OSS workspace packages: 2
- Local-only surfaces: 1
- Private OSS-core packages still gated from publish: 3
- OSS-core packages already publish-configured: 2
- Dependency leaks: 0
- No workspace dependency leaks detected between the intended OSS core and the non-OSS workspace surfaces.

## Public Package Surface
- Install target: `npm install martin-loop`
- CLI target: `npx martin-loop`
- SDK target: `import { MartinLoop } from 'martin-loop'`
- Root `npx martin-loop` support shipped: yes
- Root SDK import shipped: yes

## Intended OSS Core Packages
| Package | Path | Private | Publish Access | Workspace Deps |
|---|---|---|---|---|
| @martin/contracts | packages/contracts | yes | n/a | none |
| @martin/core | packages/core | yes | n/a | @martin/contracts |
| @martin/adapters | packages/adapters | yes | n/a | @martin/core |
| @martin/cli | packages/cli | no | public | @martin/adapters, @martin/contracts, @martin/core |
| @martin/mcp | packages/mcp | no | public | @martin/adapters, @martin/contracts, @martin/core |

## Non-OSS Workspace Packages
| Package | Path | Reason |
|---|---|---|
| @martin/control-plane | apps/control-plane | Managed or RC-only workspace surface that stays out of the initial OSS boundary. |
| @martin/benchmarks | benchmarks | Managed or RC-only workspace surface that stays out of the initial OSS boundary. |

## Local-Only Surfaces
| Path | Reason |
|---|---|
| apps/local-dashboard | Local read-model viewer that is not yet packaged as a publishable OSS workspace. |

## Dependency Leak Review
- No workspace dependency leaks detected.

