# Martin OSS Core

This repository is the public OSS-safe Martin Loop runtime surface: runtime packages, CLI, MCP server, examples, and release validation for the root `martin-loop` package.

## Included packages

- `@martin/contracts`
- `@martin/core`
- `@martin/adapters`
- `@martin/cli`
- `@martinloop/mcp`

## Public launch targets

- Install target: `npm install martin-loop`
- CLI target: `npx martin-loop`
- SDK target: `import { MartinLoop } from "martin-loop"`
- MCP target: `npx -y @martinloop/mcp`

## Validation commands

From the repo root:

```bash
pnpm install --frozen-lockfile
pnpm build
pnpm test
pnpm oss:validate
pnpm public:smoke
pnpm --filter @martinloop/mcp smoke:pack
pnpm mcp:published:smoke:pack
```

For isolated end-to-end validation:

```bash
pnpm rc:validate
```

## Notes

- Release focus: stable cockpit guidance for local triage, compact proof receipts, and degraded run-store hardening.

- The root `martin-loop` package and the standalone `@martinloop/mcp` package use separate release tracks. Always verify both lines in [`../release/VERSION-LEDGER.md`](../release/VERSION-LEDGER.md) before release work.
- `@martinloop/mcp` is published and released independently from the root package.
- Use [`../release/VERSION-LEDGER.md`](../release/VERSION-LEDGER.md) before any release work; it is the canonical version map for the root package, the standalone MCP package, and known historical anomalies.
- `pnpm mcp:published:smoke` is a post-publish npm gate; use `pnpm mcp:published:smoke:pack` for local prepublish validation.
- Run `pnpm oss:validate` locally before release work; generated boundary artifacts should stay out of committed public surfaces.

## Where to go next

- [QUICKSTART.md](./QUICKSTART.md)
- [AGENT-START-HERE.md](./AGENT-START-HERE.md)
- [EXAMPLES.md](./EXAMPLES.md)
- [OSS-0.2.5-RELEASE-NOTES.md](../release/OSS-0.2.5-RELEASE-NOTES.md)
- [../../README.md](../../README.md)
