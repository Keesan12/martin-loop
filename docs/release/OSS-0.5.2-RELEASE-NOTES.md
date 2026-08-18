# MartinLoop 0.5.2

MartinLoop 0.5.2 is a corrective CLI release that makes preflight readiness and run admission agree.

## Fixed

- `martin preflight` now uses the same workflow admission authority as `martin run`.
- Preflight no longer reports `READY` when required workflow receipts such as doctor or estimate would deterministically block the identical run.
- Missing readiness prerequisites and the next command are surfaced before agent spend begins.
- For the same workspace, task, verifier, path scope, and budget, a `READY` preflight is immediately admissible to the run gate.

## Install

```sh
npx -y martin-loop@0.5.2 --version
npx -y martin-loop@0.5.2 start
```

The standalone MCP package and MCPB bundle remain on `0.5.1` for this root-only corrective release:

```sh
npx -y @martinloop/mcp@0.5.1
```

## Trust boundary

`READY` means the workflow prerequisites and configured preflight checks required for that exact run request are satisfied at the time of evaluation. A later change to the workspace, verifier, scope, budget, policy, or environment can require preflight again.
