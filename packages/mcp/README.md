# @martinloop/mcp

Governed MCP server for AI coding agents that need hard spend limits, verifier gates, scoped file edits, and inspectable run records.

`@martinloop/mcp@0.2.0` exposes ten stdio tools plus read-only MCP resources, resource templates, and prompts:

- `martin_doctor`
- `martin_preflight`
- `martin_run`
- `martin_inspect`
- `martin_status`
- `martin_list_runs`
- `martin_get_run`
- `martin_get_attempt`
- `martin_get_verification_results`
- `martin_run_dossier`

Recommended flow:

1. `martin_doctor`
2. `martin_preflight`
3. `martin_run`
4. `martin_list_runs`, `martin_run_dossier`, `martin_inspect`, or `martin_status`

## What This Server Is For

Use this MCP when a host already knows how to delegate coding work, but you want Martin Loop to bound that work with:

- a hard budget ceiling (`maxUsd`)
- an attempt ceiling (`maxIterations`)
- a total token ceiling (`maxTokens`)
- verifier commands (`verificationPlan`)
- allowed and denied file globs
- persisted run records you can inspect afterward

It is a good fit for Claude Code, Codex-oriented hosts, and other MCP clients that want governed code-change execution instead of open-ended retry behavior.

For host-facing integration guidance, see [MCP for AI Agents](https://github.com/Keesan12/martin-loop/blob/main/docs/oss/MCP-FOR-AI-AGENTS.md).

## Quickstart

Run the packaged server directly:

```sh
npx -y @martinloop/mcp
```

Add it to Codex:

```sh
codex mcp add martin-loop -- npx -y @martinloop/mcp
```

Add it to Claude Code:

```sh
# macOS/Linux
claude mcp add --transport stdio --scope user martin-loop -- npx -y @martinloop/mcp

# Windows PowerShell/cmd
claude mcp add --transport stdio --scope user martin-loop -- cmd /c npx -y @martinloop/mcp
```

Generic stdio configuration:

```json
{
  "type": "stdio",
  "command": "npx",
  "args": ["-y", "@martinloop/mcp"]
}
```

Codex host configuration in `~/.codex/config.toml`:

```toml
[mcp_servers.martin-loop]
command = "npx"
args = ["-y", "@martinloop/mcp"]
```

If you want generated host config instead of hand-writing snippets, use the root CLI:

```sh
martin mcp print-config --host codex --profile minimal
martin mcp print-config --host claude --profile diagnostic
martin mcp print-config --host gemini --profile full-local
martin mcp install --host codex --scope project --dry-run
```

Profile guide:

- `minimal` is the default read-only local profile.
- `diagnostic` adds deeper read-only run inspection.
- `full-local` is the profile that exposes `martin_run`.
- `starter` and `full` remain compatibility aliases.

## Requirements

- Node 20+
- For live `martin_run` usage, either the `claude` CLI or the `codex` CLI must be available on `PATH`
- For stub or smoke flows, set `MARTIN_LIVE=false`

Example stub launch:

```sh
MARTIN_LIVE=false npx -y @martinloop/mcp
```

## Tool Contract

| Tool | Purpose | Required input | Important optional input | Notes |
| --- | --- | --- | --- | --- |
| `martin_doctor` | Inspect local readiness and run-store health | none | `workingDirectory`, `runsDir`, `engine` | Read-only setup lane before execution. |
| `martin_preflight` | Normalize and validate a proposed run contract | `objective` | `workingDirectory`, `engine`, `model`, `maxUsd`, `maxIterations`, `maxTokens`, `verificationPlan`, `allowedPaths`, `deniedPaths`, `workspaceId`, `projectId` | Read-only contract check; does not execute work. |
| `martin_run` | Run a governed coding loop | `objective` | `workingDirectory`, `engine`, `model`, `maxUsd`, `maxIterations`, `maxTokens`, `verificationPlan`, `allowedPaths`, `deniedPaths`, `workspaceId`, `projectId` | Unknown arguments are rejected. |
| `martin_inspect` | Read a saved run record or run folder | none | `file`, `runsDir` | `file` may point to a `loop-record.json`, legacy `.jsonl`, or a run directory under the runs root. |
| `martin_status` | Report budget pressure and stop conditions | exactly one of `loopJson`, `file`, `loopId`, or `latest` | `runsDir` | `latest` must be `true` when used. |
| `martin_list_runs` | List recent run summaries | none | `runsDir`, `limit` | Read-only cockpit view over local run records. |
| `martin_get_run` | Load a run dossier | exactly one of `loopId` or `latest` | `runsDir` | Read-only task, budget, cost, and attempt details. |
| `martin_get_attempt` | Load one attempt | `loopId`, `attemptIndex` | `runsDir` | Read-only attempt evidence. |
| `martin_get_verification_results` | Extract verifier events | exactly one of `loopId` or `latest` | `runsDir` | Read-only verifier completion summaries. |
| `martin_run_dossier` | Build a compact review dossier | exactly one of `loopId` or `latest` | `runsDir` | Summary, budget, attempts, and verification evidence. |

## Discovery Surface

`0.2.0` adds read-only cockpit discovery for MCP hosts that support resources and prompts.

Resources:

- `martin://runs/summary`
- `martin://runs/latest`

Resource templates:

- `martin://runs/{loopId}`
- `martin://runs/{loopId}/attempts/{attemptIndex}`
- `martin://runs/{loopId}/verification`

Prompts:

- `martin_review_run`
- `martin_triage_failures`

## Safe-Root Path Model

This MCP does not let tool callers point at arbitrary filesystem locations. The server resolves tool paths against safe roots chosen when the server starts.

- `workingDirectory`
  Defaults to `MARTIN_MCP_WORKSPACE_ROOT` or the server process current directory. If you pass a value, it must still resolve inside that workspace root. `.` and repo-relative subpaths are the safest choices.
- `file`
  For `martin_inspect` and `martin_status`, `file` resolves under the runs root, not the whole machine. Direct file targets must end in `.json` or `.jsonl`; run directories are also accepted where the tool supports them.
- `runsDir`
  Defaults to `MARTIN_RUNS_DIR` or `~/.martin/runs`. Passing `runsDir` only re-states or narrows that safe runs root; it does not grant access outside it.
- `allowedPaths` and `deniedPaths`
  These are relative glob patterns only. Absolute paths, drive-qualified paths, and patterns containing `..` are rejected.

Absolute paths can work only when they still resolve inside the corresponding safe root. Escapes above the workspace or runs root are rejected.

## Tool Examples

### `martin_run`

```json
{
  "objective": "Fix the auth regression and prove it with tests",
  "engine": "codex",
  "maxUsd": 3,
  "maxIterations": 3,
  "maxTokens": 20000,
  "verificationPlan": ["pnpm test --filter auth"],
  "workingDirectory": ".",
  "allowedPaths": ["src/**", "tests/**"],
  "deniedPaths": [".env*", "secrets/**"]
}
```

### `martin_inspect`

Inspect the default runs root:

```json
{}
```

Inspect a specific saved loop record under the runs root:

```json
{
  "file": "loop-123/loop-record.json"
}
```

Inspect a subdirectory under the configured runs root:

```json
{
  "runsDir": "team-a"
}
```

### `martin_status`

Status for the latest saved run:

```json
{
  "latest": true
}
```

Status for a specific persisted loop:

```json
{
  "loopId": "loop-123"
}
```

Status from inline JSON:

```json
{
  "loopJson": "{\"loopId\":\"loop-123\",\"status\":\"completed\",\"lifecycleState\":\"completed\",\"attempts\":[],\"budget\":{\"maxUsd\":5,\"softLimitUsd\":3,\"maxIterations\":2,\"maxTokens\":1000},\"cost\":{\"actualUsd\":1.25,\"avoidedUsd\":0,\"tokensIn\":20,\"tokensOut\":10}}"
}
```

## Registry Metadata

The registry manifest artifact for this package is `server.json`. In this repository, that manifest is authored at `packages/mcp/server.json`.

Current metadata:

- npm package: `@martinloop/mcp`
- registry server name: `io.github.Keesan12/martin-loop`
- manifest artifact name: `server.json`

Official MCP Registry publication is separate from npm publication. After publishing the package to npm, run the publisher from `packages/mcp`:

```sh
mcp-publisher login github
mcp-publisher publish
```

## Verification

From the repository root:

```sh
pnpm --filter @martinloop/mcp lint
pnpm --filter @martinloop/mcp test
pnpm --filter @martinloop/mcp build
pnpm --filter @martinloop/mcp smoke:pack
pnpm --filter @martinloop/mcp smoke:published:pack
pnpm --filter @martinloop/mcp verify:release
pnpm --filter @martinloop/mcp smoke:published
```

- `smoke:pack` verifies the packed tarball shape and a stdio MCP launch
- `smoke:published:pack` verifies install-and-run behavior from a freshly packed local tarball before npm publish
- `verify:release` checks metadata parity, release-note presence, and public MCP doc accuracy for the current package version
- `smoke:published` verifies the npm-installed artifact through `npm install` plus live MCP tool calls

## Version Notes

The root `CHANGELOG.md` is repo-wide and includes non-MCP changes. For the `@martinloop/mcp` surface, prefer this README and `server.json`.
