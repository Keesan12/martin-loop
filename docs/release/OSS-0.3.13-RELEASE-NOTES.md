# MartinLoop 0.3.13

## Autonomous Model Selection + Portable Governance
## Nested Write Fix (Windows) + Autonomous Model Selection + Portable Governance

### Nested writes now work inside VS Code on Windows

MartinLoop's file-write path was blocked when running inside VS Code's terminal or agent panel on Windows (plain PowerShell worked fine). Root cause: npm-installed CLIs resolve to a `.cmd`/`.ps1` shim on Windows, and the shared spawn chokepoint was wrapping it through an extra `cmd.exe`/`powershell.exe` hop — deep enough nesting that the OS-level write permission stopped propagating.

`createSpawnPlan` now resolves the shim to its real `node <script>.js` target and invokes it directly, removing the extra process hop for both the Claude and Codex adapters at once. Falls back to the prior behavior unchanged when the shim format can't be resolved. Non-Windows platforms are untouched.

A new `sandbox_write_blocked` failure class surfaces this condition distinctly — instead of silently classifying as `no_progress`, a run that produces a valid patch but writes zero files now gives a clear diagnostic.

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
