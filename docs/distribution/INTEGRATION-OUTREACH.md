# Integration Outreach Pack

Use this file for direct outreach to projects and communities building around AI coding agents.

## Core message

Hey [Name] — I’m building MartinLoop, an OSS governed runtime for AI coding agents.

The repo already supports budget caps, verifier gates, JSONL run records, rollback evidence, Claude/Codex adapters, and an MCP package.

I’m trying to understand where a control layer like this should integrate best with projects like [their project]: CLI wrapper, MCP boundary, CI, or runtime adapter.

Would value your blunt take — useful direction or wrong abstraction?

## Target projects

- Claude Code
- Codex CLI
- MCP servers
- Aider
- Cline
- Continue
- OpenHands
- SWE-agent
- Goose
- DevContainers
- GitHub Actions

## Outreach notes by target

### Claude Code

- emphasize governed repo runs and MCP install path
- ask whether the best control point is local CLI wrapper or MCP boundary

### Codex CLI

- emphasize budget caps, verifier gates, and auditable run records
- ask whether wrapper, runtime adapter, or CI integration is most useful

### MCP projects

- emphasize the packaged `@martinloop/mcp` server surface
- ask whether the trust layer belongs at tool boundary or runtime boundary

### Aider, Cline, Continue, OpenHands, SWE-agent, Goose

- emphasize adapter-normalized receipts and halt reasons
- ask how much control should live in the agent runtime versus CI or wrapper

### DevContainers and GitHub Actions

- emphasize safe default automation, budget visibility, and verifier gates in shared team workflows
- ask where platform teams want policy to live

## Supporting assets

- challenge page: [UNDER-3-CHALLENGE.md](./UNDER-3-CHALLENGE.md)
- directory copy: [DIRECTORY-SUBMISSIONS.md](./DIRECTORY-SUBMISSIONS.md)
- repo: [github.com/Keesan12/martin-loop](https://github.com/Keesan12/martin-loop)
- npm: [npmjs.com/package/martin-loop](https://www.npmjs.com/package/martin-loop)
