# Coding agent and model support

MartinLoop is an independent governed-execution layer above the coding worker. The worker can change without changing the job contract, budget, scope rules, verifier, receipt format, or Control Plane evidence model.

## Engine contract

The public CLI supports these engine values:

| Engine | Execution path | Typical workers |
| --- | --- | --- |
| `auto` | MartinLoop resolves an available supported runtime | Recovery/default selection |
| `codex` | Native Codex CLI adapter | OpenAI Codex CLI |
| `claude` | Native Claude Code CLI adapter | Anthropic Claude Code |
| `gemini` | Native Gemini CLI adapter | Google Gemini CLI |
| `openai` | OpenAI-compatible HTTP adapter | OpenAI API and compatible hosted/local model endpoints |

The native CLI adapters let the coding-agent runtime mutate the workspace directly. MartinLoop surrounds that execution with budget, iteration, scope, verifier, receipt, and evidence controls.

The `openai` adapter covers raw model endpoints that do not have their own MartinLoop-integrated coding CLI. For governed coding runs, MartinLoop supplies a bounded repository snapshot and a constrained structured edit contract. It validates every proposed path before any write, applies only admitted repository-relative text edits, and then runs the same independent verifier used by the native agent paths.

## OpenAI-compatible models

Any endpoint that implements the expected OpenAI-compatible chat-completions API can be configured through the `openai` engine. Examples include provider routes for:

- Kimi K2
- NVIDIA Nemotron
- DeepSeek
- Qwen / Qwen Coder
- Mistral / Codestral
- Llama-family models
- other compatible models exposed by OpenRouter, Together, Fireworks, or similar services
- local models served by Ollama, LM Studio, or llama.cpp-compatible servers

Model availability and exact model IDs are provider-specific. MartinLoop does not create separate engine names such as `kimi` or `nemotron`; those models use the common `openai` execution contract.

Example hosted configuration:

```sh
MARTIN_OPENAI_BASE_URL=https://openrouter.ai/api
MARTIN_OPENAI_API_KEY=<secret>
MARTIN_OPENAI_MODEL=moonshotai/kimi-k2
martin-loop run "implement the task" --engine openai
```

Example local configuration:

```sh
MARTIN_OPENAI_BASE_URL=http://localhost:11434
MARTIN_OPENAI_MODEL=<local-model-id>
martin-loop run "implement the task" --engine openai
```

Local endpoints may not require an API key. Never put API keys in task text, receipts, screenshots, or committed configuration.

## Governed coding behavior

For a governed coding run, the execution contract is the same regardless of worker:

1. MartinLoop records the objective and acceptance criteria.
2. Budget and iteration limits are fixed before execution.
3. Allowed and denied file scopes are fixed before execution.
4. The selected worker performs or proposes the code changes.
5. MartinLoop enforces the scope boundary.
6. An independent verifier runs against the resulting workspace.
7. MartinLoop persists the outcome, spend/usage provenance, scope evidence, verifier evidence, and receipt integrity.
8. The same evidence model can be synchronized to the Control Plane.

A model response claiming success is not sufficient. On the OpenAI-compatible path, malformed responses, no-op responses, path traversal, absolute paths, duplicate targets, or any edit outside the governed scope fail before the verifier can turn an unchanged baseline into a false success.

## What "model-agnostic" means

Model-agnostic does **not** mean that every model exposes identical capabilities, pricing, authentication, tool use, or quality. It means MartinLoop keeps its governance and evidence contract independent of the worker implementation.

A company can change from Claude to Codex, Gemini, Kimi, Nemotron, another compatible hosted model, or a local model without replacing the MartinLoop control plane around the job.

## ChatGPT naming

There is no `--engine chatgpt` alias. `ChatGPT` is a product surface, not the MartinLoop engine contract. OpenAI coding execution uses the `codex` CLI path or the configured `openai` compatible endpoint path, depending on the runtime being used.
