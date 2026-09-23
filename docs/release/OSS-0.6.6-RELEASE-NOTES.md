# MartinLoop 0.6.6 — Reliability Patch

## What changed

### MCP schema compatibility
Removed all 14 root-level `oneOf` combinators from MCP tool `inputSchema` definitions. Claude and Codex hosts reject tools whose root `inputSchema` contains JSON Schema combinators before the model can invoke them. Runtime selector validation is unchanged — `server-validation.ts` continues to enforce exactly-one-selector exclusivity at runtime.

### Proactive routing disclosure (Codex)
The Codex AGENTS.md governance content now includes the recommended 6-step default sequence for fresh non-trivial governed changes, routing disclosure guidance (briefly tell the user which workflow and why), and a context-reuse rule. Read-only diagnosis path preserved.

### Windows Claude native-installer support
The Claude CLI is now discovered at `%USERPROFILE%\.local\bin` on Windows, the default install location for the Anthropic native installer. Install suggestion strings are now platform-aware — Windows shows the PowerShell one-liner (`irm https://claude.ai/install.ps1 | iex`), macOS/Linux shows the curl equivalent. The deprecated `npm install -g @anthropic-ai/claude-code` suggestion has been removed.

## Regression baseline

0.6.6 preserves all proven 0.6.5 behavior: signal continue/satisfied non-terminal, terminal event precedence, workspace governance state isolation, project mode canonical roundtrip, badge explicit --runs-dir, MCP activeAttemptId, rollback=not_required, demo maxTokens cap removed.
