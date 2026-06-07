# Martin MCP Delivery Slice Map

This map defines the next public standalone MCP releases after the live `0.2.7` baseline. The point is to keep each release narrow, legible, and easy to validate.

## Live baseline

- public npm baseline: `0.2.7`
- public GitHub release baseline: `mcp-v0.2.7`
- next release to prepare: `0.3.0`

## `0.3.0` — Adoption Pack

Story: make MartinLoop feel native inside agent hosts without widening into hosted or non-OSS territory.

Include:
- stronger setup and bootstrap guidance for Codex, Claude Code, Gemini, Cursor, and VS Code
- clearer `martin_start` guidance and next-step resources
- built-in command map and operating-rules resources
- safer discovery metadata and first-run guidance
- public docs that show the recommended local-first workflow end to end

Do not include:
- hosted endpoints
- bearer-auth remote config defaults
- tenant or org language
- billing or mission-control claims
- non-OSS review routes

Primary public surfaces:
- `packages/mcp/README.md`
- `docs/oss/MCP-FOR-AI-AGENTS.md`
- `docs/oss/QUICKSTART.md`
- `docs/release/MCP-0.3.0-RELEASE-NOTES.md`

## `0.3.1` — Review And Handoff Controls

Story: make review, triage, and handoff easier after a governed run finishes.

Include:
- stronger dossier and eval guidance
- clearer failed-run and publish-readiness flows
- compact review resources for what happened, what failed, and what to do next
- handoff-safe expected outputs for humans and agents

Do not include:
- hosted audit export
- org policy
- fleet controls
- evidence-dashboard claims

Primary public surfaces:
- `packages/mcp/README.md`
- `docs/oss/MCP-FOR-AI-AGENTS.md`
- `docs/release/MCP-0.3.1-RELEASE-NOTES.md`

## `0.3.2` — Opt-In Execution Controls

Story: widen control for power users without making execution feel implicit or invisible.

Include:
- explicit execution-capable profiles
- clearer refusal and escalation messages
- stronger docs for read-only versus execution-capable usage
- install snippets that make the safe default obvious

Do not include:
- hidden auto-execution
- hosted orchestration
- tenant or billing features
- non-OSS transport

Primary public surfaces:
- `packages/mcp/README.md`
- `docs/oss/MCP-FOR-AI-AGENTS.md`
- `docs/release/MCP-0.3.2-RELEASE-NOTES.md`

## Release cut rule

Before a public-prep branch opens:

1. Reconfirm `VERSION-LEDGER.md` against live npm and public GitHub.
2. Keep the changed-path set limited to the slice being shipped.
3. Run the full public release gates on the exact candidate commit.
4. Audit packed tarball contents, README, and release notes before publish.
