# MartinLoop 0.6.1

MartinLoop 0.6.1 makes model-agnostic coding execution real. Native coding CLIs and OpenAI-compatible model endpoints now feed the same governed execution, verification, receipt, and integrity pipeline.

## What changed

- OpenAI-compatible models can return a constrained structured edit plan that MartinLoop validates and applies before verification.
- Kimi K2, NVIDIA Nemotron, DeepSeek, Qwen, Mistral/Codestral, OpenRouter/Together/Fireworks routes, Ollama, LM Studio, llama.cpp, and other compatible endpoints can participate as governed coding workers through the existing `openai` engine.
- Native Codex, Claude Code, and Gemini CLI execution remains unchanged.
- Every proposed path is checked against repository boundaries and MartinLoop allow/deny scope before any write.
- Path traversal, absolute paths, duplicate targets, malformed responses, no-op success claims, denied paths, and symlink escapes fail before accepted work.
- The normal independent verifier still decides whether the resulting workspace satisfies the job contract.

## Install

```sh
npx -y martin-loop@0.6.1 --version
npx -y martin-loop@0.6.1 doctor --engine openai
npx -y @martinloop/mcp@0.6.1
```
