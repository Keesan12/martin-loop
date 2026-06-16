# @martinloop/mcp 0.3.2

`0.3.2` is a validation hotfix for the standalone MartinLoop MCP server.

## Release story

Fix a tool-input validation gap that could reject valid spend-limit requests.

## What changed

- `martin_run`, `martin_preflight`, and `martin_doctor` now accept `engine: "gemini"`, matching the engines the run loop already supports.
- Previously, any call that combined `engine: "gemini"` with a budget field (for example `maxUsd`) was rejected with `Invalid engine.`, even though Gemini-backed runs were otherwise fully supported.
- No other tool inputs, defaults, or behaviors changed.

## Why this matters

If you set a spend limit or budget for a Gemini-backed run through the MCP tools, that request now validates correctly instead of being rejected.

## Out of scope

- opt-in execution controls (planned for `0.3.3`)
- new tools or schema fields
- changes to budget enforcement behavior

## Release gate

Setting a spend limit on any supported engine - Claude, Codex, or Gemini - through `martin_run`, `martin_preflight`, or `martin_doctor` must validate successfully.
