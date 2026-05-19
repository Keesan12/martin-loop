# Martin Loop OSS Boundary Report

Generated: 2026-05-19T02:49:24.776Z

## Verdict
**GO**

## Public Surface
- Root package: `martin-loop@0.1.6`
- Install target: `npm install martin-loop`
- CLI target: `npx martin-loop`
- SDK target: `import { MartinLoop } from "martin-loop"`
- MCP target: `npx -y @martinloop/mcp`

## OSS Packages
| Package | Path | Private | Publish Access | Workspace Deps |
|---|---|---|---|---|
| @martin/contracts | packages/contracts | yes | n/a | none |
| @martin/core | packages/core | yes | n/a | @martin/contracts |
| @martin/adapters | packages/adapters | yes | n/a | @martin/core |
| @martin/cli | packages/cli | no | public | @martin/adapters, @martin/contracts, @martin/core |
| @martinloop/mcp | packages/mcp | no | public | @martin/contracts |

## Boundary Checks
- Forbidden top-level entries: none
- Unexpected top-level entries: none
- Forbidden paid/private package directories: none
- Unexpected package directories: none
- Workspace dependency leaks: none

