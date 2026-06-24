# Phase 2: Universal Model & IDE Coverage

## Goal
MartinLoop governs every popular AI model across every popular IDE and platform with customized behavior per model and per platform.

## Model Adapter Matrix

### Tier 1 — Native CLI adapters (have dedicated adapter code)
| Model Family | Adapter | CLI Command | Status |
|-------------|---------|-------------|--------|
| Claude (Anthropic) | `createClaudeCliAdapter` | `claude` | ✅ Shipped |
| Codex/GPT (OpenAI) | `createCodexCliAdapter` | `codex` | ✅ Shipped |
| Gemini (Google) | `createGeminiCliAdapter` | `gemini` | ✅ Shipped |

### Tier 2 — OpenAI-compatible adapters (use generic HTTP adapter)
| Model Family | Provider | Endpoint | Status |
|-------------|----------|----------|--------|
| DeepSeek | DeepSeek API | `api.deepseek.com/v1` | Planned |
| Qwen | Alibaba Cloud | `dashscope.aliyuncs.com/compatible-mode/v1` | Planned |
| Nemotron | NVIDIA NIM | `integrate.api.nvidia.com/v1` | Planned |
| Kimi | Moonshot AI | `api.moonshot.cn/v1` | Planned |
| Llama | Ollama / Together | `localhost:11434/v1` or `api.together.xyz/v1` | Planned |

### Implementation
For Tier 2 models, extend the existing `createOpenAICompatibleAdapter` in `packages/adapters/src/openai-compatible.ts` with model-specific:
- Token pricing for cost estimation
- Context window limits for budget calculation
- Response format parsing
- Capability flags (structured output, tool use, etc.)

## IDE / Platform Matrix

### MCP-capable hosts (full governance via MCP server)
| IDE | MCP Support | Governance Hooks | Config Path | Status |
|-----|------------|-----------------|-------------|--------|
| Claude Code (terminal) | ✅ Native | PreToolUse + Stop hooks | `~/.claude/settings.json` | ✅ Shipped |
| Claude Code (desktop) | ✅ Native | Same hooks | Same | ✅ Shipped |
| Codex (terminal) | ✅ Native | AGENTS.md | `~/.codex/config.toml` | ✅ Shipped |
| VS Code (Copilot) | ✅ Agent mode | copilot-instructions | `.vscode/settings.json` | ✅ Config shipped |
| Cursor | ✅ Native | .cursor/rules | `.cursor/mcp.json` | ✅ Config shipped |
| Continue.dev | ✅ Native | rules files | `.continue/config.json` | ✅ Config shipped |
| Gemini CLI | ✅ Native | GEMINI.md | `~/.gemini/settings.json` | ✅ Config shipped |

### Non-MCP hosts (governance via CLI wrapper or API proxy)
| IDE | Approach | Status |
|-----|----------|--------|
| PyCharm / JetBrains | CLI wrapper: `martin-loop run` wraps any model CLI | Planned |
| Jupyter Notebook | Python SDK: `import martinloop; martinloop.govern(cell)` | Planned |
| Terminal (raw) | CLI: `martin-loop run --engine <any>` | ✅ Shipped |
| PowerShell / Windows CLI | CLI with Windows-safe paths | ✅ Shipped |
| macOS Terminal | CLI native | ✅ Shipped |
| Linux / Ubuntu | CLI native | ✅ Shipped |

### Mobile (observation only — no governance execution)
| App | Approach | Status |
|-----|----------|--------|
| ChatGPT mobile | View receipts via dashboard URL | Planned (dashboard) |
| Claude mobile | View receipts via dashboard URL | Planned (dashboard) |

## Phased Execution

### Phase 2A: OpenAI-compatible adapter with model registry (this session)
- Add model pricing registry to `openai-compatible.ts`
- Register DeepSeek, Qwen, Nemotron, Kimi, Llama configurations
- Wire `martin estimate --engine deepseek` etc.

### Phase 2B: JetBrains + Jupyter integration (next session)
- JetBrains: Plugin that wraps terminal commands through MartinLoop
- Jupyter: Python package `martinloop` with cell governance

### Phase 2C: Platform-specific hardening (next session)
- Windows path handling audit across all adapters
- macOS homebrew install path detection
- Linux systemd service for persistent MCP server

### Phase 2D: Mobile receipt viewer (dashboard milestone)
- Shareable receipt URLs from the control plane dashboard
