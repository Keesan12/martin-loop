# MartinLoop 0.3.13

## Autonomous Model Selection + Portable Governance

### `martin run` now selects the right model automatically

No more specifying `--model` for every run. MartinLoop classifies the task complexity and picks the cheapest capable model:

- Simple focused task → haiku tier (claude-haiku, gpt-4o-mini, gemini-2.5-flash)
- Architectural refactor → sonnet tier (claude-sonnet-4-6, gpt-4.1, gemini-2.5-pro)
- Security + migration → opus tier (claude-opus-4-6, o3, gemini-2.5-ultra)

This applies across all supported engines: Claude, Codex, Gemini, OpenAI-compatible endpoints (DeepSeek, Qwen, Nemotron, Kimi, Llama).

You can always override with `--model <model-id>` when you need a specific model.

### `martin start` learns your budget preference

If you've stored a default budget via MartinLoop memory, `martin start` uses it. No more hardcoded `$2` suggestions.

### Fully portable — works on any machine

All governance hooks, memory paths, and config locations use standard OS APIs:
- `homedir()` for `~/.claude/settings.json`, `~/.codex/config.toml`, etc.
- `npx martin-loop gate` for governance enforcement — works without global install
- `path.join()` for cross-platform path construction

### 28 new tests

- 12 memory store tests (append-only, never overwrites, preference retrieval)
- 16 model auto-selection tests (tier resolution, engine routing, fallback behavior)

## Install

```sh
npm install -g martin-loop@0.3.13
```
