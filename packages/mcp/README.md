# @martinloop/mcp

Governed MCP server for AI coding agents with budgets, verifier gates, and inspectable runs.

`@martinloop/mcp` is local-first and stdio-first. It gives MCP hosts one governed execution entrypoint plus read-only tools, resources, and prompts for reviewing persisted MartinLoop run records.

For host-facing setup, see [MCP setup](https://github.com/Keesan12/martin-loop/blob/main/docs/getting-started/mcp.md).

## What Ships

### Tools

- `martin_doctor`
- `martin_preflight`
- `martin_run`
- `martin_inspect`
- `martin_status`
- `martin_list_runs`
- `martin_triage_runs`
- `martin_get_run`
- `martin_get_attempt`
- `martin_get_verification_results`
- `martin_run_dossier`

### Resources

- `martin://server/health`
- `martin://runs/recent`
- `martin://runs/triage`
- `martin://runs/latest/summary`
- `martin://runs/latest/proof-card`
- `martin://runs/latest/budget-status`
- `martin://runs/latest/verifier-evidence`
- `martin://runs/latest/rollback-evidence`
- `martin://agent/next-step`
- `martin://guides/mcp-usage`
- `martin://guides/publish-readiness`

### Resource Templates

- `martin://runs/{loopId}`
- `martin://runs/{loopId}/attempts/{attemptIndex}`
- `martin://runs/{loopId}/verification`

### Prompts

- `martin_start`
- `martin_preflight`
- `martin_triage`
- `martin_resume`
- `martin_prove`
- `martin_release_check`
- `martin_governed_coding_kickoff`
- `martin_debug_failed_run`
- `martin_publish_readiness_review`
- `martin_triage_run_store`

## Recommended Flow

1. `martin_doctor`
2. `martin_preflight`
3. `martin_run`
4. `martin_triage_runs`
5. `martin://agent/next-step` or `martin://runs/latest/summary`
6. `martin_run_dossier` or the `martin_get_*` tools when compact evidence says deeper inspection is needed
7. `martin://runs/latest/proof-card` or `martin_prove` for a shareable receipt

## Install

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
claude mcp add --transport stdio --scope user martin-loop -- npx -y @martinloop/mcp
```

Windows PowerShell or cmd.exe:

```sh
claude mcp add --transport stdio --scope user martin-loop -- cmd /c npx -y @martinloop/mcp
```

Generate host config from the root CLI:

```sh
npx martin-loop mcp print-config --host codex --transport stdio --profile starter
npx martin-loop mcp print-config --host claude --transport stdio --profile full
npx martin-loop mcp print-config --host gemini --transport stdio --profile starter
```

Registry/server identifier: `io.github.Keesan12/martin-loop`

## Runtime Model

- `martin_run` is the only execution entrypoint.
- All other Martin MCP tools are read-only.
- Live runs require `claude` or `codex` on `PATH`.
- Stub or smoke flows use `MARTIN_LIVE=false`.
- Paths stay bounded to the configured workspace root and runs root.
- Direct raw-model compatibility is not the target. MartinLoop supports hosts and wrappers that speak MCP.

## Host Notes

- `codex`: local stdio profiles
- `claude`: local, user, and project scopes
- `gemini`: local `settings.json` snippets with `includeTools`
- `generic`: JSON config for MCP-aware wrappers

Operating-system launcher behavior:

- Windows: `cmd /c npx -y @martinloop/mcp`
- macOS/Linux: `npx -y @martinloop/mcp`

If you need a strict read-only host config, use a manual allow-list and omit `martin_run`.

## Debugging

Use the live handshake inspector before debugging a host configuration:

```sh
pnpm --filter @martinloop/mcp inspect:live
```

For the official MCP Inspector UI:

```sh
npx @modelcontextprotocol/inspector --command npx --args "-y,@martinloop/mcp"
```

The stdio server keeps protocol output on stdout and diagnostic logging on stderr.

## Verification

From the repository root:

```sh
pnpm --filter @martinloop/mcp lint
pnpm --filter @martinloop/mcp test
pnpm --filter @martinloop/mcp build
pnpm --filter @martinloop/mcp smoke:pack
pnpm --filter @martinloop/mcp smoke:published:pack
pnpm --filter @martinloop/mcp verify:release
```

See the [MCP tool reference](https://github.com/Keesan12/martin-loop/blob/main/docs/reference/mcp-tools.md) and [MCP compatibility](https://github.com/Keesan12/martin-loop/blob/main/docs/reference/mcp-compatibility.md).
