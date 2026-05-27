# MCP Compatibility

`@martinloop/mcp` is a local-first stdio MCP server for governed AI coding work.

## Compatibility Commitments

- `martin_run` remains the only execution entrypoint.
- Read-only inspection tools are additive.
- Resources, resource templates, and prompts are additive.
- The npm package exposes the server through `npx -y @martinloop/mcp`.
- The server identifier is `io.github.Keesan12/martin-loop`.

## Host Coverage

- Codex: local stdio profiles
- Claude Code: local, user, and project scopes
- Gemini: local settings snippets with `includeTools`
- Generic: JSON config for MCP-aware wrappers

## Launcher Behavior

- Windows: `cmd /c npx -y @martinloop/mcp`
- macOS/Linux: `npx -y @martinloop/mcp`

## Discovery

Resources and prompts include version metadata so hosts can confirm which surface they loaded. The server does not advertise authoritative change notifications yet.
