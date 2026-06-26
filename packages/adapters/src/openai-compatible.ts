/**
 * OpenAI-compatible adapter for MartinLoop.
 *
 * Routes agent execution to any endpoint that implements the OpenAI
 * Chat Completions API (`POST /v1/chat/completions`). This covers:
 *
 * Hosted via OpenRouter / Together.ai / Fireworks.ai:
 *   DeepSeek-V3, DeepSeek-R1, Qwen3-235B, Mistral Large, Codestral,
 *   Kimi k2, Nemotron-70B, and hundreds more.
 *
 * Local via Ollama / LM Studio / llama.cpp:
 *   Llama 3.x, Mistral 7B, Phi-4, Gemma 3, any GGUF model.
 *
 * Usage:
 *   # Defaults to OpenAI's hosted endpoint when MARTIN_OPENAI_BASE_URL is unset.
 *   MARTIN_OPENAI_API_KEY=sk-...
 *   MARTIN_OPENAI_MODEL=gpt-4.1-mini
 *   martin-loop run "fix the bug" --engine openai
 *
 *   # Or route to a third-party / self-hosted OpenAI-compatible endpoint:
 *   MARTIN_OPENAI_BASE_URL=https://openrouter.ai/api
 *   MARTIN_OPENAI_API_KEY=sk-or-...
 *   MARTIN_OPENAI_MODEL=deepseek/deepseek-chat
 *   martin-loop run "fix the bug" --engine openai
 *
 * Or for Ollama:
 *   MARTIN_OPENAI_BASE_URL=http://localhost:11434
 *   MARTIN_OPENAI_MODEL=llama3.3
 *   martin-loop run "fix the bug" --engine openai
 */

import type {
  FailureClass,
  MartinAdapter,
  MartinAdapterRequest,
  MartinAdapterResult
} from "@martin/core";

import { readGitChangedFiles, runVerification } from "./cli-bridge.js";
import { createAdapterCapabilities, normalizeUsage } from "./runtime-support.js";

// ---------------------------------------------------------------------------
// OpenRouter/OpenAI-compatible model pricing ($/1K tokens)
// Automatically used when baseUrl contains openrouter.ai or known providers.
// Defaults to a conservative blended estimate for unknown models.
// ---------------------------------------------------------------------------

const KNOWN_MODEL_PRICING: Record<string, { inputPer1K: number; outputPer1K: number }> = {
  // DeepSeek
  "deepseek/deepseek-chat":          { inputPer1K: 0.00027, outputPer1K: 0.0011 },
  "deepseek/deepseek-r1":            { inputPer1K: 0.0008,  outputPer1K: 0.0032 },
  "deepseek/deepseek-coder":         { inputPer1K: 0.00014, outputPer1K: 0.00028 },
  // Qwen
  "qwen/qwen3-235b-a22b":            { inputPer1K: 0.00022, outputPer1K: 0.00088 },
  "qwen/qwen3-32b":                  { inputPer1K: 0.00009, outputPer1K: 0.00009 },
  "qwen/qwen-2.5-coder-32b-instruct":{ inputPer1K: 0.00007, outputPer1K: 0.00007 },
  // Mistral
  "mistralai/codestral-latest":      { inputPer1K: 0.0003,  outputPer1K: 0.0009 },
  "mistralai/mistral-large":         { inputPer1K: 0.003,   outputPer1K: 0.009 },
  "mistralai/mistral-small":         { inputPer1K: 0.0001,  outputPer1K: 0.0003 },
  // Kimi
  "moonshotai/kimi-k2":              { inputPer1K: 0.00065, outputPer1K: 0.0026 },
  // Nemotron
  "nvidia/llama-3.1-nemotron-70b-instruct": { inputPer1K: 0.00012, outputPer1K: 0.0003 },
  // Llama (via OpenRouter)
  "meta-llama/llama-3.3-70b-instruct": { inputPer1K: 0.00012, outputPer1K: 0.0003 },
  "meta-llama/llama-3.1-405b-instruct": { inputPer1K: 0.0008, outputPer1K: 0.0008 },
};

const FALLBACK_INPUT_PER_1K = 0.0003;
const FALLBACK_OUTPUT_PER_1K = 0.0012;
const CHARS_PER_TOKEN = 4;

function estimateCost(
  model: string,
  inputChars: number,
  outputChars: number
): { tokensIn: number; tokensOut: number; actualUsd: number } {
  const pricing = KNOWN_MODEL_PRICING[model] ?? {
    inputPer1K: FALLBACK_INPUT_PER_1K,
    outputPer1K: FALLBACK_OUTPUT_PER_1K
  };
  const tokensIn = Math.ceil(inputChars / CHARS_PER_TOKEN);
  const tokensOut = Math.ceil(outputChars / CHARS_PER_TOKEN);
  const actualUsd =
    (tokensIn / 1000) * pricing.inputPer1K + (tokensOut / 1000) * pricing.outputPer1K;
  return { tokensIn, tokensOut, actualUsd };
}

// ---------------------------------------------------------------------------
// OpenAI chat completions response shape
// ---------------------------------------------------------------------------

interface OpenAiMessage {
  role: string;
  content: string | null;
}

interface OpenAiChoice {
  message: OpenAiMessage;
  finish_reason?: string;
}

interface OpenAiUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
}

interface OpenAiResponse {
  choices?: OpenAiChoice[];
  usage?: OpenAiUsage;
  error?: { message?: string; type?: string; code?: string };
}

// ---------------------------------------------------------------------------
// Adapter options
// ---------------------------------------------------------------------------

export interface OpenAiCompatibleAdapterOptions {
  /** Base URL of the OpenAI-compatible API. No trailing slash. */
  baseUrl?: string;
  /** API key. Empty string for local (Ollama/LM Studio) endpoints. */
  apiKey?: string;
  /** Model identifier passed as-is to the API (e.g. "deepseek/deepseek-chat"). */
  model?: string;
  /**
   * System prompt prepended before the MartinLoop task prompt.
   * Default instructs the model to act as a focused coding assistant.
   */
  systemPrompt?: string;
  /** Request timeout in milliseconds. Default: 300_000 (5 min). */
  timeoutMs?: number;
  /** Verifier timeout in milliseconds. Default: 120_000. */
  verifyTimeoutMs?: number;
  /** Working directory for git artifact collection and verification. */
  workingDirectory?: string;
  /** Optional fetch override for testing. */
  fetchImpl?: typeof fetch;
}

// ---------------------------------------------------------------------------
// Prompt builder
// ---------------------------------------------------------------------------

const DEFAULT_SYSTEM_PROMPT = `You are an expert software engineer executing a governed coding task.
Follow these rules exactly:
- Read the task description carefully and implement only what is asked.
- Do not add features, refactors, or improvements beyond the stated task.
- If the task asks you to write or modify code, output the complete file content with changes applied.
- Be precise, minimal, and test-backed in all changes.
- State what you changed and why at the end of your response.`;

export const DEFAULT_OPENAI_BASE_URL = "https://api.openai.com";
export const DEFAULT_OPENAI_MODEL = "gpt-4.1-mini";

export function resolveOpenAiCompatibleRuntimeConfig(
  env: NodeJS.ProcessEnv = process.env
): {
  baseUrl: string;
  model: string;
  apiKey: string;
  apiKeyConfigured: boolean;
  authPosture: "api_key" | "anonymous_or_local";
} {
  const apiKey = env["MARTIN_OPENAI_API_KEY"] ?? "";
  return {
    baseUrl: env["MARTIN_OPENAI_BASE_URL"] ?? DEFAULT_OPENAI_BASE_URL,
    model: env["MARTIN_OPENAI_MODEL"] ?? DEFAULT_OPENAI_MODEL,
    apiKey,
    apiKeyConfigured: apiKey.length > 0,
    authPosture: apiKey.length > 0 ? "api_key" : "anonymous_or_local"
  };
}

function buildPrompt(request: MartinAdapterRequest): string {
  const lines: string[] = [
    `TASK: ${request.context.taskTitle}`,
    ``,
    `OBJECTIVE:`,
    request.context.objective,
    ``
  ];

  if (request.context.focus) {
    lines.push(`FOCUS: ${request.context.focus}`, ``);
  }

  if (request.context.verificationPlan.length > 0) {
    lines.push(
      `VERIFICATION COMMANDS (must pass after your changes):`,
      ...request.context.verificationPlan.map((cmd) => `  ${cmd}`),
      ``
    );
  }

  if (request.previousAttempts.length > 0) {
    const last = request.previousAttempts.at(-1);
    if (last) {
      lines.push(
        `PREVIOUS ATTEMPT SUMMARY:`,
        last.summary ?? "",
        ``
      );
    }
  }

  lines.push(
    `BUDGET REMAINING: $${request.context.remainingBudgetUsd.toFixed(4)} | Iterations left: ${request.context.remainingIterations}`
  );

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createOpenAiCompatibleAdapter(
  options: OpenAiCompatibleAdapterOptions
): MartinAdapter {
  const workingDirectory = options.workingDirectory ?? process.cwd();
  const timeoutMs = options.timeoutMs ?? 300_000;
  const verifyTimeoutMs = options.verifyTimeoutMs ?? 120_000;
  const systemPrompt = options.systemPrompt ?? DEFAULT_SYSTEM_PROMPT;
  const fetchFn = options.fetchImpl ?? globalThis.fetch;
  const runtimeConfig = resolveOpenAiCompatibleRuntimeConfig();
  const baseUrl = (options.baseUrl ?? runtimeConfig.baseUrl).replace(/\/$/, "");
  const model = options.model ?? runtimeConfig.model;
  const apiKey = options.apiKey ?? runtimeConfig.apiKey;

  return {
    adapterId: `openai-compatible:${model}`,
    kind: "direct-provider",
    label: `OpenAI-compatible: ${model}`,
    metadata: {
      providerId: "openai-compatible",
      model,
      transport: "http",
      capabilities: createAdapterCapabilities({
        preflight: true,
        usageSettlement: true,
        diffArtifacts: true
      })
    },

    async execute(request: MartinAdapterRequest): Promise<MartinAdapterResult> {
      const prompt = buildPrompt(request);
      const estimated = estimateCost(model, prompt.length, 2000);
      const hasVerificationSteps =
        request.context.verificationPlan.length > 0 ||
        (request.context.verificationStack?.length ?? 0) > 0;
      const baselineChangedFiles = hasVerificationSteps
        ? new Set(await readGitChangedFiles(workingDirectory, 5_000))
        : new Set<string>();

      // Preflight: bail if projected cost exceeds remaining budget
      if (
        request.context.remainingBudgetUsd > 0 &&
        estimated.actualUsd > request.context.remainingBudgetUsd * 0.95
      ) {
        return {
          status: "failed",
          summary: `Preflight: projected cost $${estimated.actualUsd.toFixed(4)} exceeds remaining budget $${request.context.remainingBudgetUsd.toFixed(4)}.`,
          usage: normalizeUsage({
            actualUsd: estimated.actualUsd,
            estimatedUsd: estimated.actualUsd,
            tokensIn: estimated.tokensIn,
            tokensOut: estimated.tokensOut,
            provenance: "estimated"
          }),
          verification: { passed: false, summary: "Stopped before execution: budget preflight failed." },
          failure: { message: "budget_preflight_exceeded", classHint: "budget_pressure" as FailureClass }
        };
      }

      // Call the OpenAI-compatible endpoint with exponential-backoff retry on
      // transient failures (429 rate-limit, 503/5xx server errors, network errors).
      // Auth errors (401/403) and bad-request errors (400) are not retried — they
      // indicate a permanent configuration problem.
      const MAX_RETRIES = 3;
      const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);
      const endpoint = `${baseUrl}/v1/chat/completions`;
      let responseText = "";
      let tokensIn = estimated.tokensIn;
      let tokensOut = 0;

      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;
      if (baseUrl.includes("openrouter")) {
        headers["HTTP-Referer"] = "https://martinloop.com";
        headers["X-Title"] = "MartinLoop";
      }
      const requestBody = JSON.stringify({
        model,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: prompt }
        ],
        temperature: 0.2,
        max_tokens: 8192
      });

      let lastError = "";
      let succeeded = false;

      for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
          const res = await fetchFn(endpoint, {
            method: "POST",
            headers,
            body: requestBody,
            signal: controller.signal
          });

          const body = (await res.json()) as OpenAiResponse;

          if (!res.ok || body.error) {
            const errMsg = body.error?.message ?? `HTTP ${res.status}`;
            if (RETRYABLE_STATUS.has(res.status) && attempt < MAX_RETRIES - 1) {
              lastError = errMsg;
              // Exponential backoff: 1s, 2s, 4s
              await new Promise((resolve) => setTimeout(resolve, 1000 * Math.pow(2, attempt)));
              continue;
            }
            return {
              status: "failed",
              summary: `${model} API error: ${errMsg}`,
              usage: normalizeUsage({ actualUsd: 0, tokensIn: 0, tokensOut: 0, provenance: "unavailable" }),
              verification: { passed: false, summary: "API call failed before verifier." },
              failure: { message: errMsg, classHint: "infrastructure_error" as FailureClass }
            };
          }

          responseText = body.choices?.[0]?.message?.content ?? "";
          if (body.usage) {
            tokensIn = body.usage.prompt_tokens ?? tokensIn;
            tokensOut = body.usage.completion_tokens ?? 0;
          } else {
            tokensOut = Math.ceil(responseText.length / CHARS_PER_TOKEN);
          }
          succeeded = true;
          break;
        } catch (error: unknown) {
          const isAbort = error instanceof Error && error.name === "AbortError";
          if (isAbort || attempt === MAX_RETRIES - 1) {
            const message = isAbort
              ? `${model} request timed out after ${timeoutMs}ms`
              : String(error);
            return {
              status: "failed",
              summary: message,
              usage: normalizeUsage({ actualUsd: 0, tokensIn: 0, tokensOut: 0, provenance: "unavailable" }),
              verification: { passed: false, summary: isAbort ? "Request timed out." : "Network error." },
              failure: { message, classHint: "infrastructure_error" as FailureClass }
            };
          }
          // Transient network error — retry with backoff
          lastError = String(error);
          await new Promise((resolve) => setTimeout(resolve, 1000 * Math.pow(2, attempt)));
        } finally {
          clearTimeout(timer);
        }
      }

      if (!succeeded) {
        return {
          status: "failed",
          summary: `${model} API error after ${MAX_RETRIES} attempts: ${lastError}`,
          usage: normalizeUsage({ actualUsd: 0, tokensIn: 0, tokensOut: 0, provenance: "unavailable" }),
          verification: { passed: false, summary: "API call failed after retries." },
          failure: { message: lastError, classHint: "infrastructure_error" as FailureClass }
        };
      }

      if (!responseText.trim()) {
        return {
          status: "failed",
          summary: `${model} returned an empty response.`,
          usage: normalizeUsage({ actualUsd: 0, tokensIn, tokensOut: 0, provenance: "actual" }),
          verification: { passed: false, summary: "Empty response — nothing to verify." },
          failure: { message: "empty_response" }
        };
      }

      // Run verification
      const verification = await runVerification(
        request.context.verificationPlan,
        workingDirectory,
        verifyTimeoutMs,
        request.context.verificationStack
      );

      const execution = {
        changedFiles: hasVerificationSteps
          ? (await readGitChangedFiles(workingDirectory, 5_000)).filter(
              (file) => !baselineChangedFiles.has(file)
            )
          : []
      };

      const pricing = KNOWN_MODEL_PRICING[model] ?? {
        inputPer1K: FALLBACK_INPUT_PER_1K,
        outputPer1K: FALLBACK_OUTPUT_PER_1K
      };
      const actualUsd =
        (tokensIn / 1000) * pricing.inputPer1K + (tokensOut / 1000) * pricing.outputPer1K;

      return {
        status: verification.passed ? "completed" : "failed",
        summary: verification.passed
          ? `${model} completed the task. Verifier passed.`
          : `${model} completed but verifier failed: ${verification.summary}`,
        usage: normalizeUsage({
          actualUsd,
          tokensIn,
          tokensOut,
          provenance: "actual"
        }),
        verification,
        execution,
        ...(verification.passed ? {} : {
          failure: { message: verification.summary }
        })
      };
    }
  };
}
