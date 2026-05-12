# Martin Loop

Martin Loop is a governed AI coding-loop runtime for teams that want hard budgets, verifier gates, scoped edits, and inspectable run records around autonomous code changes.

## Public package surface

- Install: `npm install martin-loop`
- CLI: `npx martin-loop`
- SDK: `import { MartinLoop } from "martin-loop"`
- MCP: `npx -y @martinloop/mcp`

The public root package stays on the `0.1.x` line. The standalone MCP package is published independently as `@martinloop/mcp`.

## What is in this public repo

- `packages/contracts`: loop, policy, budget, and telemetry types
- `packages/core`: orchestration, policy, rollback, persistence, and runtime logic
- `packages/adapters`: Claude CLI, Codex CLI, direct-provider, and stub adapters
- `packages/cli`: the local operator CLI
- `packages/mcp`: the stdio MCP server for `martin_run`, `martin_inspect`, and `martin_status`
- `examples/`: public examples for CI and adapter integrations
- `demo/seeded-workspace/`: a disposable sandbox used by the packaged `demo` command

## Quick start

Install the root package:

```sh
npm install -g martin-loop
martin-loop --help
```

Create a disposable demo workspace:

```sh
npx martin-loop demo --dir ./martin-loop-demo
```

Run a safe stub-backed task from the repo:

```powershell
$env:MARTIN_LIVE='false'
pnpm run:cli -- run --objective "Summarize the current runtime state" --verify "pnpm --filter @martin/core test"
Remove-Item Env:MARTIN_LIVE
```

## MCP quick start

Use the published MCP package directly:

```sh
npx -y @martinloop/mcp
```

Claude Code install:

- macOS/Linux: `claude mcp add --scope user martin-loop -- npx -y @martinloop/mcp`
- Windows PowerShell/cmd: `claude mcp add --scope user martin-loop cmd /c "npx -y @martinloop/mcp"`

## Local validation

From the repo root:

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm test
pnpm oss:validate
pnpm public:smoke
pnpm --filter @martinloop/mcp smoke:pack
```

For an isolated temp-home validation pass:

```sh
pnpm rc:validate
pnpm release:matrix:local
```

## Documentation

- OSS overview: [docs/oss/README.md](https://github.com/Keesan12/martin-loop/blob/main/docs/oss/README.md)
- Quickstart: [docs/oss/QUICKSTART.md](https://github.com/Keesan12/martin-loop/blob/main/docs/oss/QUICKSTART.md)
- Examples: [docs/oss/EXAMPLES.md](https://github.com/Keesan12/martin-loop/blob/main/docs/oss/EXAMPLES.md)
- MCP maintainer publishing guide: [docs/release/MCP-PUBLISHING.md](https://github.com/Keesan12/martin-loop/blob/main/docs/release/MCP-PUBLISHING.md)

## License

MIT. See [LICENSE](./LICENSE).
