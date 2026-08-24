# @martinloop/mcp

Coding agents are getting good enough to do real software work. The messy part is everything around them.

You still have to turn an idea into a clear finish line, keep the agent moving in the right direction, decide whether the result is actually ready, recover when it is not, and understand what happened before you ship it. Most people end up stitching that workflow together themselves.

**MartinLoop is one system around coding agents so people can go from intent to a production-quality software handoff without building their own engineering stack around the agent.**

`@martinloop/mcp` is the MCP entry point into that system.

The coding agent still writes the code. MartinLoop connects the work around it.

```text
INTENT -> DEFINITION OF DONE -> AGENT WORK -> VERIFY -> RECOVER -> HANDOFF
```

## Connect MartinLoop

### Claude Code

```sh
claude mcp add martin-loop -- npx -y @martinloop/mcp@latest
```

Windows:

```sh
claude mcp add --transport stdio --scope user martin-loop -- cmd /c npx -y @martinloop/mcp@latest
```

### Codex

```sh
codex mcp add martin-loop -- npx -y @martinloop/mcp@latest
```

### Gemini CLI

```sh
gemini mcp add martin-loop -- npx -y @martinloop/mcp@latest
```

### Any local MCP host

```sh
npx -y @martinloop/mcp@latest
```

MartinLoop uses local stdio transport. The authenticated coding-agent host keeps authority over its own model selection; MartinLoop does not silently swap in a fallback model.

## What changes once it is connected

Instead of treating the coding agent as a black box that returns a diff, the host gets one workflow around the job:

1. **Define what should ship.** Give the work an objective and a finish line.
2. **Check that the run is ready.** Catch environment or workflow problems before spending a full run on them.
3. **Let the coding agent do the work.** MartinLoop stays around the run rather than replacing the agent.
4. **Check the result against the finish line.** Completion is based on the evidence you configured, not on the agent saying "done."
5. **Recover when the result is not ready.** Preserve enough context to continue, stop, or hand the work to a person without starting from zero.
6. **Hand off something understandable.** The next person or agent can see what happened and what remains unresolved.

The governed result is one of:

- `VERIFIED` — the configured evidence supports the Definition of Done.
- `STOPPED` — a configured execution boundary ended the run.
- `NEEDS REVIEW` — the available evidence is not enough to establish completion.

`VERIFIED` means the checks you chose passed for that run. It is not a claim that software is universally bug-free or automatically safe to merge.

## Why MCP matters here

MartinLoop is useful as a standalone CLI, but MCP lets the coding environment use the same surrounding workflow directly.

A compatible host can plan work, start or continue a governed run, inspect what happened, read verification evidence, review previous runs, and prepare a handoff without forcing the user to jump between unrelated tools.

The exact tool and resource set is discoverable from the running server with `tools/list` and `resources/list`; documentation does not hard-code a count because the surface evolves between releases.

Primary capabilities include:

- planning and preflight
- governed agent execution
- run status and logs
- verification results
- run history and triage
- dossiers and handoff evidence
- PR preparation and review helpers

## For people who are not trying to become the engineering department

The larger MartinLoop direction is not "more controls for engineers." It is reducing how much infrastructure a person has to assemble just to get dependable software work out of coding agents.

That matters for engineering teams, but it also matters for founders, operators, product people, and other non-engineers who can describe what they want built and need a clearer path from that intent to work they can review and ship.

The technical controls underneath MartinLoop — budgets, scope boundaries, verifier commands, recovery evidence, receipts, failure classification, and cost provenance — support that workflow. They are not the product story by themselves.

## Requirements

- Node.js 20+
- A supported coding-agent environment such as Claude Code, Codex, or Gemini CLI for live coding work

## Product context

For machine-readable MartinLoop context:

- [`../../llms.txt`](../../llms.txt)
- [`../../llms-full.txt`](../../llms-full.txt)
- [`../../docs/for-agents.md`](../../docs/for-agents.md)

## Links

- [MartinLoop](https://martinloop.com)
- [GitHub](https://github.com/Keesan12/martin-loop)
- [Standalone CLI](https://www.npmjs.com/package/martin-loop)
- [MCP package](https://www.npmjs.com/package/@martinloop/mcp)

## License

Apache-2.0
