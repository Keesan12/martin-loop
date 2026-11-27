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
 *   MARTIN_OPENAI_MODEL=<provider-model-id>
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
import {
  assertConcreteLiveModel,
  resolveOpenAiAuthPosture,
  type OpenAiAuthPosture,
  type OpenAiAuthPostureKind,
} from "@martin/contracts";

import { readGitChangedFiles, runVerification } from "./cli-bridge.js";
import { createAdapterCapabilities, normalizeUsage } from "./runtime-support.js";
import {
  resolveBudgetPreflightPricePerMTokenUsd,
  resolveProviderPricing
} from "./pricing/catalog.js";
import { applyWorkspaceEdits, buildWorkspaceSnapshot } from "./workspace-edit-protocol.js";

// ---------------------------------------------------------------------------
// OpenAI pricing is resolved from the shared, dated provider catalog. Unknown
// compatible-provider models remain unpriced rather than receiving a
// fabricated blended rate.
// ---------------------------------------------------------------------------

const CHARS_PER_TOKEN = 4;

function estimateCost(
  model: string,
  inputChars: number,
  outputChars: number,
  pricePerMTokenUsd?: number
): { tokensIn: number; tokensOut: number; estimatedUsd?: number } {
  const tokensIn = Math.ceil(inputChars / CHARS_PER_TOKEN);
  const tokensOut = Math.ceil(outputChars / CHARS_PER_TOKEN);
  if (pricePerMTokenUsd !== undefined) {
    return {
      tokensIn,
      tokensOut,
      estimatedUsd: ((tokensIn + tokensOut) / 1_000_000) * pricePerMTokenUsd
    };
  }
  const rates = resolveProviderPricing(model, {
    provider: "openai",
    inputTokens: tokensIn
  }).pricing?.ratesPerMillion;
  if (!rates) return { tokensIn, tokensOut };
  return {
    tokensIn,
    tokensOut,
    estimatedUsd: (tokensIn / 1_000_000) * rates.input + (tokensOut / 1_000_000) * rates.output
  };
}

function normalizeOpenAiCompatibleUsage(input: {
  model: string;
  tokensIn: number;
  tokensOut: number;
  usageWasFullyProviderReported: boolean;
  modelSource: "explicit_override" | "provider_configured";
  billingMode: "metered_api" | "local_unmetered" | "unknown";
  authPosture: OpenAiAuthPosture;
  configuredPricePerMTokenUsd?: number;
}) {
  const resolution = resolveProviderPricing(input.model, {
    provider: "openai",
    inputTokens: input.tokensIn
  });
  const rates = resolution.pricing?.ratesPerMillion;
  const isLocalUnmetered = input.billingMode === "local_unmetered";
  const configuredUsd = isLocalUnmetered || input.configuredPricePerMTokenUsd === undefined
    ? undefined
    : ((input.tokensIn + input.tokensOut) / 1_000_000) * input.configuredPricePerMTokenUsd;
  const catalogUsd = rates === undefined
    ? undefined
    : (input.tokensIn / 1_000_000) * rates.input +
      (input.tokensOut / 1_000_000) * rates.output;
  const settledUsd = configuredUsd ?? catalogUsd;
  const provenance = settledUsd === undefined
    ? "unavailable"
    : !isLocalUnmetered && input.usageWasFullyProviderReported
      ? "calculated"
      : "estimated";

  return normalizeUsage({
    actualUsd: isLocalUnmetered || settledUsd === undefined ? 0 : settledUsd,
    ...(provenance === "estimated" && settledUsd !== undefined ? { estimatedUsd: settledUsd } : {}),
    tokensIn: input.tokensIn,
    tokensOut: input.tokensOut,
    provenance,
    providerSettlement: {
      providerId: "openai-compatible",
      model: input.model,
      transport: "http",
      source: input.usageWasFullyProviderReported ? "openai_compatible_json" : "estimated_fallback",
      inputTokens: input.tokensIn,
      outputTokens: input.tokensOut,
      billingMode: input.billingMode,
      openAiAuthPosture: input.authPosture.posture,
      openAiEndpointClass: input.authPosture.endpointClass,
      modelSource: input.modelSource,
      pricingSource: configuredUsd !== undefined
        ? "blended_fallback"
        : rates === undefined
          ? "none"
          : "static_catalog",
      ...(configuredUsd !== undefined
        ? { pricingVersion: "configured-price-per-m-token" }
        : rates === undefined || resolution.entry === undefined
          ? {}
          : { pricingVersion: `official-provider-pricing@${resolution.entry.source.retrievedAt}` }),
      rawUsageAvailable: input.usageWasFullyProviderReported,
      settledAt: new Date().toISOString()
    }
  });
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
  model?: string;
  choices?: OpenAiChoice[];
  usage?: OpenAiUsage;
  error?: { message?: string; type?: string; code?: string };
}

// ---------------------------------------------------------------------------
// Adapter options
// ---------------------------------------------------------------------------

export type OpenAiCompatibleBillingMode =
  | "metered_api"
  | "local_unmetered"
  | "unknown";

export interface OpenAiCompatibleAdapterOptions {
  /** Base URL of the OpenAI-compatible API. No trailing slash. */
  baseUrl?: string;
  /** API key. Empty string for local (Ollama/LM Studio) endpoints. */
  apiKey?: string;
  /** Explicit authority for a remote endpoint that intentionally accepts no credential. */
  authPosture?: OpenAiAuthPostureKind;
  /** Model identifier passed as-is to the API (e.g. "deepseek/deepseek-chat"). */
  model?: string;
  /** Explicit billing authority. Required to classify a metered loopback proxy. */
  billingMode?: OpenAiCompatibleBillingMode;
  /** Explicit conservative admission price for a model absent from the official catalog. */
  pricePerMTokenUsd?: number;
  /**
   * System prompt prepended before the MartinLoop task prompt.
   * Default instructs the model to act as a focused coding assistant.
   */
  systemPrompt?: string;
  /** Request timeout in milliseconds. Default: 300_000 (5 min). */
  timeoutMs?: number;
  /** Maximum provider response bytes read into memory. Default: 1 MiB. */
  maxResponseBytes?: number;
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
- Read the task description and repository snapshot carefully and implement only what is asked.
- Do not add unrelated features, refactors, or improvements.
- Respect every allowed-path and denied-path boundary in the task contract.
- For governed coding runs, return ONLY the structured JSON edit plan requested in the user message.
- Every edit must contain the complete replacement content for one repository-relative text file.
- Do not claim success unless your proposed edits satisfy the acceptance criteria and verifier.`;

export const DEFAULT_OPENAI_BASE_URL = "https://api.openai.com";

function normalizeOpenAiCompatibleBaseUrl(baseUrl: string): string {
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new Error("INVALID_OPENAI_BASE_URL: endpoint must be an absolute HTTP(S) URL.");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("INVALID_OPENAI_BASE_URL: endpoint protocol must be HTTP or HTTPS.");
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error(
      "INVALID_OPENAI_BASE_URL: endpoint must not contain credentials, query parameters, or a fragment."
    );
  }
  return baseUrl.replace(/\/+$/u, "");
}

export function resolveOpenAiCompatibleRuntimeConfig(
  env: NodeJS.ProcessEnv = process.env,
  billingModeOverride?: OpenAiCompatibleBillingMode,
  baseUrlOverride?: string,
  pricePerMTokenUsdOverride?: number,
  authPostureOverride?: OpenAiAuthPostureKind,
  apiKeyOverride?: string,
): {
  baseUrl: string;
  model?: string;
  apiKey: string;
  apiKeyConfigured: boolean;
  authPosture: OpenAiAuthPosture;
  billingMode?: OpenAiCompatibleBillingMode;
  pricePerMTokenUsd?: number;
} {
  const apiKey = apiKeyOverride ?? env["MARTIN_OPENAI_API_KEY"] ?? "";
  const configuredBillingMode = billingModeOverride ?? env["MARTIN_OPENAI_BILLING_MODE"];
  if (
    configuredBillingMode !== undefined &&
    configuredBillingMode !== "metered_api" &&
    configuredBillingMode !== "local_unmetered" &&
    configuredBillingMode !== "unknown"
  ) {
    throw new Error(
      "INVALID_OPENAI_BILLING_MODE: MARTIN_OPENAI_BILLING_MODE must be metered_api, local_unmetered, or unknown."
    );
  }
  const baseUrl = normalizeOpenAiCompatibleBaseUrl(
    baseUrlOverride ?? env["MARTIN_OPENAI_BASE_URL"] ?? DEFAULT_OPENAI_BASE_URL
  );
  const configuredPosture = authPostureOverride ?? env["MARTIN_OPENAI_AUTH_POSTURE"];
  if (
    configuredPosture !== undefined &&
    configuredPosture !== "hosted_bearer" &&
    configuredPosture !== "router_bearer" &&
    configuredPosture !== "loopback_no_auth" &&
    configuredPosture !== "remote_no_auth"
  ) {
    throw new Error(
      "INVALID_OPENAI_AUTH_POSTURE: MARTIN_OPENAI_AUTH_POSTURE must be remote_no_auth when explicit remote no-auth authority is required."
    );
  }
  const authPosture = resolveOpenAiAuthPosture({
    baseUrl,
    credentialConfigured: apiKey.length > 0,
    ...(configuredPosture === undefined ? {} : { configuredPosture }),
  });
  const configuredModel = env["MARTIN_OPENAI_MODEL"]
    ? assertConcreteLiveModel(env["MARTIN_OPENAI_MODEL"])
    : undefined;
  const configuredPriceText = pricePerMTokenUsdOverride === undefined
    ? env["MARTIN_OPENAI_PRICE_PER_M_TOKEN_USD"]
    : undefined;
  const configuredPrice = pricePerMTokenUsdOverride ?? (
    configuredPriceText === undefined || configuredPriceText.trim() === ""
      ? undefined
      : Number(configuredPriceText)
  );
  if (configuredPrice !== undefined && (!Number.isFinite(configuredPrice) || configuredPrice < 0)) {
    throw new Error(
      "INVALID_OPENAI_PRICE: MARTIN_OPENAI_PRICE_PER_M_TOKEN_USD must be finite and non-negative."
    );
  }
  return {
    baseUrl,
    ...(configuredModel ? { model: configuredModel } : {}),
    apiKey,
    apiKeyConfigured: apiKey.length > 0,
    authPosture,
    ...(configuredBillingMode ? { billingMode: configuredBillingMode } : {}),
    ...(configuredPrice === undefined ? {} : { pricePerMTokenUsd: configuredPrice })
  };
}

function isLoopbackBaseUrl(baseUrl: string): boolean {
  try {
    const parsed = new URL(baseUrl.includes("://") ? baseUrl : `http://${baseUrl}`);
    const hostname = parsed.hostname.toLowerCase();
    return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
  } catch {
    return false;
  }
}

function buildPrompt(request: MartinAdapterRequest, workspaceSnapshot = ""): string {
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

  if (request.context.mutationMode === "read_only") {
    lines.push(
      "READ-ONLY EXECUTION. Do not propose file edits or deletions.",
      "Inspect the supplied workspace context and report factual findings only.",
      ""
    );
  }

  if ((request.context.acceptanceCriteria?.length ?? 0) > 0) {
    lines.push(
      `ACCEPTANCE CRITERIA:`,
      ...(request.context.acceptanceCriteria ?? []).map((criterion) => `  - ${criterion}`),
      ``
    );
  }

  if ((request.context.allowedPaths?.length ?? 0) > 0) {
    lines.push(`ALLOWED EDIT PATHS:`, ...(request.context.allowedPaths ?? []).map((path) => `  - ${path}`), ``);
  }
  if ((request.context.deniedPaths?.length ?? 0) > 0) {
    lines.push(`DENIED EDIT PATHS:`, ...(request.context.deniedPaths ?? []).map((path) => `  - ${path}`), ``);
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

  if (workspaceSnapshot) {
    if (request.context.mutationMode === "read_only") {
      lines.push(
        ``,
        `WORKSPACE SNAPSHOT (read-only context; paths are repository-relative):`,
        workspaceSnapshot,
        ``,
        `RESPONSE CONTRACT:`,
        `Return a concise factual inspection summary. Do not propose edits, deletions, patches, or write commands.`
      );
    } else {
      lines.push(
        ``,
        `WORKSPACE SNAPSHOT (read-only context; paths are repository-relative):`,
        workspaceSnapshot,
        ``,
        `RESPONSE CONTRACT:`,
        `Return ONLY JSON with this shape:`,
        `{"summary":"short description","edits":[{"path":"src/file.ts","content":"complete replacement file content"}],"deletions":[]}`,
        `Use only repository-relative paths. Every proposed path is validated by MartinLoop before any file is written.`,
        `If a file should not change, omit it. Do not wrap the JSON in explanatory prose.`
      );
    }
  }

  return lines.join("\n");
}

function abortError(message: string): Error {
  const error = new Error(message);
  error.name = "AbortError";
  return error;
}

const DEFAULT_MAX_RESPONSE_BYTES = 1_048_576;

async function readBoundedResponseText(response: Response, maxBytes: number): Promise<string> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new Error("INVALID_OPENAI_RESPONSE_LIMIT: maxResponseBytes must be a positive safe integer.");
  }
  if (!response.body) {
    throw new Error("OPENAI_RESPONSE_BODY_MISSING");
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let byteCount = 0;
  let text = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    byteCount += value.byteLength;
    if (byteCount > maxBytes) {
      await reader.cancel("OPENAI_RESPONSE_TOO_LARGE");
      throw new Error(`OPENAI_RESPONSE_TOO_LARGE: response exceeded ${String(maxBytes)} bytes`);
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseOpenAiResponse(text: string, requestedModel: string): OpenAiResponse {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(
      `OPENAI_RESPONSE_INVALID_JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!isRecord(parsed)) {
    throw new Error("OPENAI_RESPONSE_INVALID_SCHEMA: expected an object");
  }
  if (parsed.model !== undefined) {
    if (typeof parsed.model !== "string") {
      throw new Error("OPENAI_RESPONSE_INVALID_SCHEMA: model must be a string");
    }
    if (parsed.model !== requestedModel) {
      throw new Error(
        `OPENAI_RESPONSE_MODEL_MISMATCH: requested ${requestedModel}, observed ${parsed.model}`,
      );
    }
  }
  if (parsed.error !== undefined) {
    if (!isRecord(parsed.error)) {
      throw new Error("OPENAI_RESPONSE_INVALID_SCHEMA: error must be an object");
    }
    for (const field of ["message", "type", "code"] as const) {
      if (parsed.error[field] !== undefined && typeof parsed.error[field] !== "string") {
        throw new Error(`OPENAI_RESPONSE_INVALID_SCHEMA: error.${field} must be a string`);
      }
    }
    return parsed as OpenAiResponse;
  }
  if (!Array.isArray(parsed.choices) || parsed.choices.length === 0) {
    throw new Error("OPENAI_RESPONSE_INVALID_SCHEMA: choices must be a non-empty array");
  }
  for (const [index, choice] of parsed.choices.entries()) {
    if (!isRecord(choice) || !isRecord(choice.message)) {
      throw new Error(`OPENAI_RESPONSE_INVALID_SCHEMA: choices[${String(index)}].message must be an object`);
    }
    if (choice.message.role !== "assistant" || typeof choice.message.content !== "string") {
      throw new Error(
        `OPENAI_RESPONSE_INVALID_SCHEMA: choices[${String(index)}].message requires assistant role and string content`,
      );
    }
    if (
      choice.finish_reason !== undefined &&
      choice.finish_reason !== null &&
      typeof choice.finish_reason !== "string"
    ) {
      throw new Error(`OPENAI_RESPONSE_INVALID_SCHEMA: choices[${String(index)}].finish_reason must be a string or null`);
    }
  }
  if (parsed.usage !== undefined) {
    if (!isRecord(parsed.usage)) {
      throw new Error("OPENAI_RESPONSE_INVALID_USAGE: usage must be an object");
    }
    for (const field of ["prompt_tokens", "completion_tokens", "total_tokens"] as const) {
      const value = parsed.usage[field];
      if (value !== undefined && (!Number.isSafeInteger(value) || (value as number) < 0)) {
        throw new Error(`OPENAI_RESPONSE_INVALID_USAGE: ${field} must be a finite nonnegative integer`);
      }
    }
    if (
      typeof parsed.usage.prompt_tokens === "number" &&
      typeof parsed.usage.completion_tokens === "number" &&
      typeof parsed.usage.total_tokens === "number" &&
      parsed.usage.total_tokens !== parsed.usage.prompt_tokens + parsed.usage.completion_tokens
    ) {
      throw new Error("OPENAI_RESPONSE_INVALID_USAGE: total_tokens must equal prompt_tokens plus completion_tokens");
    }
  }
  return parsed as OpenAiResponse;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createOpenAiCompatibleAdapter(
  options: OpenAiCompatibleAdapterOptions
): MartinAdapter {
  const workingDirectory = options.workingDirectory ?? process.cwd();
  const timeoutMs = options.timeoutMs ?? 300_000;
  const maxResponseBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  const verifyTimeoutMs = options.verifyTimeoutMs ?? 120_000;
  const systemPrompt = options.systemPrompt ?? DEFAULT_SYSTEM_PROMPT;
  const fetchFn = options.fetchImpl ?? globalThis.fetch;
  const runtimeConfig = resolveOpenAiCompatibleRuntimeConfig(
    process.env,
    options.billingMode,
    options.baseUrl,
    options.pricePerMTokenUsd,
    options.authPosture,
    options.apiKey,
  );
  const baseUrl = runtimeConfig.baseUrl;
  const model = options.model === undefined
    ? runtimeConfig.model
    : assertConcreteLiveModel(options.model);
  if (!model) {
    throw new Error(
      "MODEL_CONFIGURATION_REQUIRED: set --model or MARTIN_OPENAI_MODEL for direct OpenAI-compatible execution."
    );
  }
  const apiKey = options.apiKey ?? runtimeConfig.apiKey;
  const authPosture = runtimeConfig.authPosture;
  if (
    (authPosture.posture === "hosted_bearer" || authPosture.posture === "router_bearer") &&
    !authPosture.credentialConfigured
  ) {
    throw new Error("OPENAI_BEARER_CREDENTIAL_REQUIRED: the selected hosted endpoint requires a bearer credential.");
  }
  const modelSource = options.model ? "explicit_override" as const : "provider_configured" as const;
  const billingMode: OpenAiCompatibleBillingMode =
    runtimeConfig.billingMode ??
    (isLoopbackBaseUrl(baseUrl) && apiKey.length === 0
      ? "local_unmetered"
      : apiKey.length > 0
        ? "metered_api"
        : "unknown");
  const catalogPricePerMTokenUsd = resolveBudgetPreflightPricePerMTokenUsd(model, {
    provider: "openai"
  });
  const configuredPricePerMTokenUsd = runtimeConfig.pricePerMTokenUsd;
  const pricePerMTokenUsd = billingMode === "local_unmetered"
    ? 0
    : configuredPricePerMTokenUsd ?? catalogPricePerMTokenUsd;
  if (billingMode !== "local_unmetered" && pricePerMTokenUsd === undefined) {
    throw new Error(
      "PRICING_CONFIGURATION_REQUIRED: non-local unknown models require pricePerMTokenUsd."
    );
  }

  return {
    adapterId: `openai-compatible:${model}`,
    kind: "direct-provider",
    label: `OpenAI-compatible: ${model}`,
    metadata: {
      providerId: "openai-compatible",
      model,
      transport: "http",
      authPosture: authPosture.posture,
      endpointClass: authPosture.endpointClass,
      credentialConfigured: authPosture.credentialConfigured,
      ...(pricePerMTokenUsd === undefined ? {} : {
        budgetPreflight: {
          pricePerMTokenUsd,
          basis: billingMode === "local_unmetered"
            ? "local_unmetered_billing_authority"
            : "provider_pricing_catalog_max_active_token_rate"
        }
      }),
      capabilities: createAdapterCapabilities({
        preflight: true,
        usageSettlement: true,
        diffArtifacts: true
      })
    },

    async execute(request: MartinAdapterRequest): Promise<MartinAdapterResult> {
      const hasVerificationSteps =
        request.context.verificationPlan.length > 0 ||
        (request.context.verificationStack?.length ?? 0) > 0;
      const mutationMode = request.context.mutationMode ?? "edit";
      const governedCodingRun =
        request.context.mutationMode === "edit" ||
        hasVerificationSteps ||
        (request.context.allowedPaths?.length ?? 0) > 0 ||
        (request.context.deniedPaths?.length ?? 0) > 0;
      const workspaceSnapshot = governedCodingRun
        ? await buildWorkspaceSnapshot({
            workingDirectory,
            allowedPaths: request.context.allowedPaths,
            deniedPaths: request.context.deniedPaths
          })
        : "";
      const prompt = buildPrompt(request, workspaceSnapshot);
      const estimated = estimateCost(model, prompt.length, 2000, pricePerMTokenUsd);
      const baselineChangedFiles = hasVerificationSteps
        ? new Set(await readGitChangedFiles(workingDirectory, 5_000))
        : new Set<string>();
      const cancelledResult = (): MartinAdapterResult => ({
        status: "failed",
        summary: `${model} request cancelled by parent.`,
        usage: normalizeUsage({ actualUsd: 0, tokensIn: 0, tokensOut: 0, provenance: "unavailable" }),
        verification: { passed: false, summary: "Request cancelled before verifier." },
        failure: { message: "parent_cancelled", classHint: "infrastructure_error" as FailureClass }
      });

      if (request.signal?.aborted) return cancelledResult();

      // Preflight: bail if projected cost exceeds remaining budget
      if (
        billingMode !== "local_unmetered" &&
        request.context.remainingBudgetUsd > 0 &&
        estimated.estimatedUsd !== undefined &&
        estimated.estimatedUsd > request.context.remainingBudgetUsd * 0.95
      ) {
        return {
          status: "failed",
          summary: `Preflight: projected cost $${estimated.estimatedUsd.toFixed(4)} exceeds remaining budget $${request.context.remainingBudgetUsd.toFixed(4)}.`,
          usage: normalizeUsage({
              actualUsd: estimated.estimatedUsd,
              estimatedUsd: estimated.estimatedUsd,
            tokensIn: estimated.tokensIn,
            tokensOut: estimated.tokensOut,
            provenance: "estimated"
          }),
          verification: { passed: false, summary: "Stopped before execution: budget preflight failed." },
          failure: { message: "budget_preflight_exceeded", classHint: "budget_pressure" as FailureClass }
        };
      }

      const apiRoot = /\/v1$/iu.test(baseUrl) ? baseUrl : `${baseUrl}/v1`;
      const endpoint = `${apiRoot}/chat/completions`;
      let responseText = "";
      let tokensIn = estimated.tokensIn;
      let tokensOut = 0;
      let usageWasFullyProviderReported = false;

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

      const controller = new AbortController();
      let timedOut = false;
      const abortFromParent = () => controller.abort(request.signal?.reason);
      if (request.signal?.aborted) abortFromParent();
      else if (request.signal) {
        request.signal.addEventListener("abort", abortFromParent, { once: true });
        if (request.signal.aborted) abortFromParent();
      }
      const timer = setTimeout(() => {
        timedOut = true;
        controller.abort(abortError(`${model} request timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      try {
        const res = await fetchFn(endpoint, {
          method: "POST",
          headers,
          body: requestBody,
          signal: controller.signal
        });
        const rawBody = await readBoundedResponseText(res, maxResponseBytes);
        if (!res.ok) {
          let errMsg = `HTTP ${String(res.status)}`;
          try {
            const errorBody = JSON.parse(rawBody) as unknown;
            if (
              isRecord(errorBody) &&
              isRecord(errorBody.error) &&
              typeof errorBody.error.message === "string"
            ) {
              errMsg = errorBody.error.message;
            }
          } catch {
            // HTTP status is authoritative even when the error body is malformed.
          }
          return {
            status: "failed",
            summary: `${model} API error: ${errMsg}`,
            usage: normalizeUsage({ actualUsd: 0, tokensIn: 0, tokensOut: 0, provenance: "unavailable" }),
            verification: { passed: false, summary: "API call failed before verifier." },
            failure: { message: errMsg, classHint: "infrastructure_error" as FailureClass }
          };
        }

        const body = parseOpenAiResponse(rawBody, model);
        if (body.error) {
          const errMsg = body.error.message ?? "OpenAI-compatible response contained an error";
          return {
            status: "failed",
            summary: `${model} API error: ${errMsg}`,
            usage: normalizeUsage({ actualUsd: 0, tokensIn: 0, tokensOut: 0, provenance: "unavailable" }),
            verification: { passed: false, summary: "API response failed before verifier." },
            failure: { message: errMsg, classHint: "infrastructure_error" as FailureClass }
          };
        }
        responseText = body.choices?.[0]?.message.content ?? "";
        if (body.usage) {
          const providerPromptTokens = body.usage.prompt_tokens;
          const providerCompletionTokens = body.usage.completion_tokens;
          usageWasFullyProviderReported =
            providerPromptTokens !== undefined && providerCompletionTokens !== undefined;
          tokensIn = providerPromptTokens ?? tokensIn;
          tokensOut = providerCompletionTokens ?? Math.ceil(responseText.length / CHARS_PER_TOKEN);
        } else {
          tokensOut = Math.ceil(responseText.length / CHARS_PER_TOKEN);
        }
      } catch (error: unknown) {
        const isAbort = error instanceof Error && error.name === "AbortError";
        if (request.signal?.aborted && !timedOut) return cancelledResult();
        const message = isAbort
          ? `${model} request timed out after ${timeoutMs}ms`
          : error instanceof Error
            ? error.message
            : String(error);
        const invalidResponse = message.startsWith("OPENAI_RESPONSE_");
        return {
          status: "failed",
          summary: message,
          usage: normalizeUsage({ actualUsd: 0, tokensIn: 0, tokensOut: 0, provenance: "unavailable" }),
          verification: {
            passed: false,
            summary: isAbort
              ? "Request timed out before verifier execution."
              : invalidResponse
                ? "Invalid provider response before verifier execution."
                : "Network or response-stream error before verifier execution."
          },
          failure: { message, classHint: "infrastructure_error" as FailureClass }
        };
      } finally {
        clearTimeout(timer);
        request.signal?.removeEventListener("abort", abortFromParent);
      }

      if (!responseText.trim()) {
        return {
          status: "failed",
          summary: `${model} returned an empty response.`,
          usage: normalizeOpenAiCompatibleUsage({
            model,
            tokensIn,
            tokensOut: 0,
            usageWasFullyProviderReported,
            modelSource,
            billingMode,
            authPosture,
            configuredPricePerMTokenUsd
          }),
          verification: { passed: false, summary: "Empty response — nothing to verify." },
          failure: { message: "empty_response" }
        };
      }

      let rollbackWorkspaceEdits: (() => Promise<void>) | undefined;
      if (governedCodingRun && mutationMode === "edit") {
        try {
          const application = await applyWorkspaceEdits({
            workingDirectory,
            responseText,
            allowedPaths: request.context.allowedPaths,
            deniedPaths: request.context.deniedPaths
          });
          rollbackWorkspaceEdits = application.rollback;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return {
            status: "failed",
            summary: `${model} did not produce an admissible governed workspace edit: ${message}`,
            usage: normalizeOpenAiCompatibleUsage({
              model,
              tokensIn,
              tokensOut,
              usageWasFullyProviderReported,
              modelSource,
              billingMode,
              authPosture,
              configuredPricePerMTokenUsd
            }),
            verification: { passed: false, summary: "Workspace edit protocol failed before verifier execution." },
            failure: { message }
          };
        }
      }

      // Run verification
      const verification = await runVerification(
        request.context.verificationPlan,
        workingDirectory,
        verifyTimeoutMs,
        request.context.verificationStack,
        undefined,
        {
          runId: request.loopId,
          workspaceId: request.workspaceId,
          attemptId: request.attemptId,
          cwd: workingDirectory,
          ...(request.context.runsRoot ? { runsRoot: request.context.runsRoot } : {}),
          ...(request.context.executionProfile ? { executionProfile: request.context.executionProfile } : {}),
          ...(request.context.allowedNetworkDomains?.length ? { allowedNetworkDomains: [...request.context.allowedNetworkDomains] } : {}),
        },
        request.signal
      );

      const verificationConfigured = verification.binding.commands.length > 0;
      if (verificationConfigured && !verification.passed && rollbackWorkspaceEdits) {
        try {
          await rollbackWorkspaceEdits();
        } catch (error) {
          const rollbackMessage = error instanceof Error ? error.message : String(error);
          return {
            status: "failed",
            summary: `${model} verifier failed and workspace rollback failed: ${rollbackMessage}`,
            usage: normalizeOpenAiCompatibleUsage({
              model,
              tokensIn,
              tokensOut,
              usageWasFullyProviderReported,
              modelSource,
              billingMode,
              authPosture,
              configuredPricePerMTokenUsd
            }),
            verification,
            failure: { message: `WORKSPACE_EDIT_ROLLBACK_FAILED: ${rollbackMessage}` }
          };
        }
      }

      const execution = {
        changedFiles: hasVerificationSteps
          ? (await readGitChangedFiles(workingDirectory, 5_000)).filter(
              (file) => !baselineChangedFiles.has(file)
            )
          : []
      };

      return {
        status: verification.passed || !verificationConfigured ? "completed" : "failed",
        summary: verification.passed
          ? `${model} completed the task. Verifier passed.`
          : !verificationConfigured
            ? `${model} completed the task without verifier evidence; outcome is not VERIFIED.`
          : `${model} completed but verifier failed: ${verification.summary}`,
        usage: normalizeOpenAiCompatibleUsage({
          model,
          tokensIn,
          tokensOut,
          usageWasFullyProviderReported,
          modelSource,
          billingMode,
          authPosture,
          configuredPricePerMTokenUsd
        }),
        verification,
        execution,
        ...(verification.passed || !verificationConfigured ? {} : {
          failure: { message: verification.summary }
        })
      };
    }
  };
}
