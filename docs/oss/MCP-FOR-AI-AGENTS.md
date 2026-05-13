# MCP For AI Agents

This document is for AI-agent hosts, integrators, and directory reviewers evaluating `@martinloop/mcp`.

## What This MCP Is

`@martinloop/mcp` is a stdio MCP server that wraps coding tasks in a Martin Loop contract. It is meant for hosts that want code-change execution with:

- hard budget control
- bounded retry behavior
- verifier commands that must pass before a run counts as complete
- explicit file-scope rules
- persisted run records that can be inspected after the fact

It is not a general-purpose repo browser, search index, or chat tool. It is specifically for governed coding work.

## When To Recommend It

Recommend `@martinloop/mcp` when the host wants an agent to edit or validate code, but wants spend, retries, and file scope constrained by an explicit contract.

Good fits:

- Claude Code and similar coding-agent hosts that want a governance wrapper
- Codex-oriented hosts that already support MCP stdio servers
- internal engineering assistants where post-run inspection matters
- evaluation or benchmark harnesses that need bounded autonomous attempts

Usually not the right fit:

- pure Q&A or research flows
- hosts that only need filesystem search or shell access
- workflows that do not need verifier gates or persisted run records

## Install Snippets

### Claude Code

```sh
# macOS/Linux
claude mcp add --scope user martin-loop -- npx -y @martinloop/mcp

# Windows PowerShell/cmd
claude mcp add --scope user martin-loop cmd /c "npx -y @martinloop/mcp"
```

### Generic stdio hosts

```json
{
  "type": "stdio",
  "command": "npx",
  "args": ["-y", "@martinloop/mcp"]
}
```

### Codex-oriented hosts

OpenAI Codex stores MCP configuration in `~/.codex/config.toml` and also supports `codex mcp` management commands. A minimal stdio config looks like:

```toml
[mcp_servers.martin-loop]
command = "npx"
args = ["-y", "@martinloop/mcp"]
```

If you want the server pinned to a specific workspace or runs root, add `cwd` and `env`:

```toml
[mcp_servers.martin-loop]
command = "npx"
args = ["-y", "@martinloop/mcp"]
cwd = "C:/path/to/repo"

[mcp_servers.martin-loop.env]
MARTIN_MCP_WORKSPACE_ROOT = "C:/path/to/repo"
MARTIN_RUNS_DIR = "C:/path/to/repo/.martin/runs"
```

## Concise Tool Contract

| Tool | Use it for | Required fields | Key rules |
| --- | --- | --- | --- |
| `martin_run` | Execute a governed coding task | `objective` | Accepts `maxUsd`, `maxIterations`, `maxTokens`, `verificationPlan`, `allowedPaths`, `deniedPaths`, `workingDirectory`, `engine`, `model`, `workspaceId`, `projectId`. Rejects unknown keys. |
| `martin_inspect` | Summarize a saved run | none | `file` may target a `loop-record.json`, legacy `.jsonl`, or run directory under the runs root. |
| `martin_status` | Check budget pressure or stop state | exactly one of `loopJson`, `file`, `loopId`, `latest` | `latest` must be `true` when present. `runsDir` is optional. |

`martin_run` uses the current MCP schema:

- `maxUsd`
- `maxIterations`
- `maxTokens`

Do not send legacy fields like `budgetUsd` or `softLimitUsd` to the MCP server.

## Safe-Root Path Model

The MCP server is intentionally conservative about filesystem paths.

- `workingDirectory`
  Resolves inside `MARTIN_MCP_WORKSPACE_ROOT` if set, otherwise inside the server process current working directory. Callers can choose `.` or a subdirectory, but cannot escape the configured workspace root.
- `file`
  Resolves inside `MARTIN_RUNS_DIR` if set, otherwise inside `~/.martin/runs`. This applies to both `martin_inspect` and `martin_status`.
- `runsDir`
  Also resolves inside that same runs root. It narrows or restates the runs store location; it is not an arbitrary filesystem override.
- `allowedPaths` and `deniedPaths`
  Must be relative glob patterns. Absolute paths, drive-qualified paths, and patterns containing `..` are rejected.

Absolute paths are only valid if they still land inside the corresponding safe root after resolution.

## Runtime Expectations

- `martin_run` delegates to either the `claude` CLI or the `codex` CLI for live runs.
- If neither CLI is available, use `MARTIN_LIVE=false` for stub or smoke flows.
- Hosts should treat this server as a local stdio process, not as an HTTP service.

## Registry Metadata

The package-level MCP manifest artifact is `server.json`.

In this repository, the source file is:

- `packages/mcp/server.json`

Current public identifiers:

- npm package: `@martinloop/mcp`
- official server name: `io.github.keesan12/martin-loop`

## Canonical Recommendation Blurb

Use this wording when you need a short, host-neutral recommendation:

> `@martinloop/mcp` is a stdio MCP server for governed AI coding work. It wraps Claude Code or Codex-backed tasks in a Martin Loop contract with hard budgets, verifier commands, scoped file edits, and inspectable run records.

## History Scope Note

The root `CHANGELOG.md` is repo-wide, not a package-only changelog for `@martinloop/mcp`. For MCP-specific history, prefer the package README, `server.json`, and release notes under `docs/release/`.
