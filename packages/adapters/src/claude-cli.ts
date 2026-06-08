/**
 * Real agent-CLI adapters.
 *
 * Exports a generic factory (`createAgentCliAdapter`) and two pre-configured
 * factories (`createClaudeCliAdapter`, `createCodexCliAdapter`) that spawn
 * the respective AI coding CLI as a child subprocess.
 *
 * Usage in CLI:
 *   createClaudeCliAdapter({ workingDirectory: process.cwd() })
 *   createCodexCliAdapter({ workingDirectory: process.cwd() })
 *
 * MCP tools and integration tests use the same factories.
 */

import type {
  FailureClass,
  MartinAdapter,
  MartinAdapterRequest,
  MartinAdapterResult
} from "@martin/core";

import {
  readGitExecutionArtifacts,
  resolveGitRepositoryRoot,
  runSubprocess,
  runVerification,
  type SpawnLike
} from "./cli-bridge.js";
import { buildCodexExecArgs } from "./codex-launcher.js";
import {
  createAdapterCapabilities,
  normalizeStructuredErrors,
  normalizeUsage
} from "./runtime-support.js";

// ---------------------------------------------------------------------------
// Cost estimation
//
// Token costs are estimated using a blended average across top models:
// Anthropic Sonnet, OpenAI GPT-4o Mini, Gemini Flash, Meta Llama 3.
// Override at runtime with --input-cost-per-1k / --output-cost-per-1k CLI
// flags or martin.config.yaml pricing section.
// ---------------------------------------------------------------------------

const BLENDED_INPUT_COST_PER_1K = 0.003;   // $/1K input tokens
const BLENDED_OUTPUT_COST_PER_1K = 0.012;  // $/1K output tokens

// Per-model overrides for common Claude models (fallback: blended average)
const MODEL_PRICING: Record<string, { inputPer1K: number; cachedInputPer1K?: number; outputPer1K: number }> = {
  "claude-opus-4-6":   { inputPer1K: 0.015, outputPer1K: 0.075 },
  "claude-sonnet-4-6": { inputPer1K: 0.003, outputPer1K: 0.015 },
  "claude-haiku-4-5":  { inputPer1K: 0.00025, outputPer1K: 0.00125 },
  // Keep legacy names working
  "claude-opus":       { inputPer1K: 0.015, outputPer1K: 0.075 },
  "claude-sonnet":     { inputPer1K: 0.003, outputPer1K: 0.015 },
  "claude-haiku":      { inputPer1K: 0.00025, outputPer1K: 0.00125 },
  // OpenAI coding models
  "codex":             { inputPer1K: 0.00125, cachedInputPer1K: 0.000125, outputPer1K: 0.01 },
  "gpt-5-codex":       { inputPer1K: 0.00125, cachedInputPer1K: 0.000125, outputPer1K: 0.01 },
  "gpt-5.1-codex":     { inputPer1K: 0.00125, cachedInputPer1K: 0.000125, outputPer1K: 0.01 },
  "gpt-5.1-codex-max": { inputPer1K: 0.00125, cachedInputPer1K: 0.000125, outputPer1K: 0.01 },
  "gpt-5.2-codex":     { inputPer1K: 0.00175, cachedInputPer1K: 0.000175, outputPer1K: 0.014 },
  "codex-mini-latest": { inputPer1K: 0.0015, cachedInputPer1K: 0.000375, outputPer1K: 0.006 }
};

// ---------------------------------------------------------------------------
// Claude CLI JSON output shape (--output-format json)
// ---------------------------------------------------------------------------

interface ClaudeJsonOutput {
  type: string;
  subtype?: string;
  result?: string;
  error?: string;
  /** Authoritative cumulative cost reported by Claude on the final `result` event (json/stream-json). */
  total_cost_usd?: number;
  usage?: {
    // camelCase (older SDK versions)
    inputTokens?: number;
    outputTokens?: number;
    cacheReadInputTokens?: number;
    cacheCreationInputTokens?: number;
    // snake_case (Claude CLI --output-format json)
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
}

interface CodexJsonEvent {
  type?: string;
  item?: {
    id?: string;
    type?: string;
    text?: string;
  };
  usage?: {
    input_tokens?: number;
    cached_input_tokens?: number;
    output_tokens?: number;
    reasoning_output_tokens?: number;
  };
}

interface GeminiJsonOutput {
  session_id?: string;
  response?: string;
  stats?: {
    cachedReadTokens?: number;
    cachedWriteTokens?: number;
    inputTokens?: number;
    outputTokens?: number;
    thoughtTokens?: number;
    totalTokens?: number;
  };
  error?: {
    type?: string;
    message?: string;
    code?: number;
  };
}

function extractUsage(
  parsed: ClaudeJsonOutput | undefined,
  modelLabel: string | undefined
): MartinAdapterResult["usage"] {
  if (!parsed?.usage) {
    return normalizeUsage({
      actualUsd: 0,
      tokensIn: 0,
      tokensOut: 0,
      provenance: "unavailable"
    });
  }

  const promptTokens =
    (parsed.usage.inputTokens ?? parsed.usage.input_tokens ?? 0) +
    (parsed.usage.cacheCreationInputTokens ?? parsed.usage.cache_creation_input_tokens ?? 0);
  const cachedInputTokens =
    parsed.usage.cacheReadInputTokens ?? parsed.usage.cache_read_input_tokens ?? 0;
  const tokensIn = promptTokens + cachedInputTokens;
  const tokensOut = parsed.usage.outputTokens ?? parsed.usage.output_tokens ?? 0;

  const pricing =
    (modelLabel ? MODEL_PRICING[modelLabel] : undefined) ??
    { inputPer1K: BLENDED_INPUT_COST_PER_1K, outputPer1K: BLENDED_OUTPUT_COST_PER_1K };

  // Prefer Claude's own authoritative total_cost_usd (present on the final
  // `result` event in json/stream-json output) over our pricing-table estimate,
  // which can drift from real billed cost (cache discounts, surcharges, etc).
  const hasAuthoritativeCost = typeof parsed.total_cost_usd === "number";
  const actualUsd: number = hasAuthoritativeCost
    ? (parsed.total_cost_usd as number)
    : (promptTokens / 1000) * pricing.inputPer1K +
      (cachedInputTokens / 1000) * (pricing.cachedInputPer1K ?? pricing.inputPer1K) +
      (tokensOut / 1000) * pricing.outputPer1K;

  return normalizeUsage({
    actualUsd: Number(actualUsd.toFixed(6)),
    tokensIn,
    tokensOut,
    cachedInputTokens,
    provenance: hasAuthoritativeCost ? "actual" : "estimated",
    providerSettlement: {
      providerId: "claude",
      model: modelLabel ?? "claude",
      transport: "cli",
      source: "claude_json",
      inputTokens: promptTokens,
      cachedInputTokens,
      outputTokens: tokensOut,
      rawUsageAvailable: true,
      settledAt: new Date().toISOString()
    }
  });
}

function extractCodexJsonlResult(
  stdout: string,
  modelLabel: string | undefined
): { summary: string; usage: MartinAdapterResult["usage"] } | undefined {
  const events = stdout
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line) as CodexJsonEvent;
      } catch {
        return undefined;
      }
    })
    .filter((event): event is CodexJsonEvent => event !== undefined);

  if (events.length === 0) {
    return undefined;
  }

  const latestAgentMessage = [...events]
    .reverse()
    .find((event) => event.type === "item.completed" && event.item?.type === "agent_message");
  const latestTurnCompleted = [...events]
    .reverse()
    .find((event) => event.type === "turn.completed" && event.usage !== undefined);

  const summary =
    typeof latestAgentMessage?.item?.text === "string" && latestAgentMessage.item.text.trim().length > 0
      ? latestAgentMessage.item.text.trim()
      : stdout.trim();

  if (!latestTurnCompleted?.usage) {
    return {
      summary,
      usage: normalizeUsage({
        actualUsd: 0,
        tokensIn: 0,
        tokensOut: 0,
        provenance: "unavailable",
        providerSettlement: {
          providerId: "codex",
          model: modelLabel ?? "codex",
          transport: "cli",
          source: "unavailable",
          inputTokens: 0,
          outputTokens: 0,
          rawUsageAvailable: false,
          settledAt: new Date().toISOString()
        }
      })
    };
  }

  const promptTokens = latestTurnCompleted.usage.input_tokens ?? 0;
  const cachedInputTokens = latestTurnCompleted.usage.cached_input_tokens ?? 0;
  const outputTokens = latestTurnCompleted.usage.output_tokens ?? 0;
  const reasoningOutputTokens = latestTurnCompleted.usage.reasoning_output_tokens ?? 0;
  const tokensIn = promptTokens + cachedInputTokens;
  const tokensOut = outputTokens + reasoningOutputTokens;
  const pricing =
    (modelLabel ? MODEL_PRICING[modelLabel] : undefined) ??
    MODEL_PRICING["codex"] ??
    { inputPer1K: BLENDED_INPUT_COST_PER_1K, outputPer1K: BLENDED_OUTPUT_COST_PER_1K };
  const actualUsd =
    (promptTokens / 1000) * pricing.inputPer1K +
    (cachedInputTokens / 1000) * (pricing.cachedInputPer1K ?? pricing.inputPer1K) +
    (tokensOut / 1000) * pricing.outputPer1K;

  return {
    summary,
    usage: normalizeUsage({
      actualUsd: Number(actualUsd.toFixed(6)),
      tokensIn,
      tokensOut,
      cachedInputTokens,
      reasoningTokensOut: reasoningOutputTokens,
      provenance: "actual",
      providerSettlement: {
        providerId: "codex",
        model: modelLabel ?? "codex",
        transport: "cli",
        source: "codex_jsonl",
        inputTokens: promptTokens,
        cachedInputTokens,
        outputTokens,
        reasoningOutputTokens,
        rawUsageAvailable: true,
        settledAt: new Date().toISOString()
      }
    })
  };
}

function extractGeminiJsonResult(
  stdout: string,
  modelLabel: string | undefined
): { summary: string; usage: MartinAdapterResult["usage"] } | undefined {
  let parsed: GeminiJsonOutput | undefined;
  try {
    parsed = JSON.parse(stdout) as GeminiJsonOutput;
  } catch {
    return undefined;
  }

  const summary =
    typeof parsed.response === "string" && parsed.response.trim().length > 0
      ? parsed.response.trim()
      : typeof parsed.error?.message === "string" && parsed.error.message.trim().length > 0
        ? parsed.error.message.trim()
        : stdout.trim();

  const promptTokens = parsed.stats?.inputTokens ?? 0;
  const cachedInputTokens = parsed.stats?.cachedReadTokens ?? 0;
  const outputTokens = parsed.stats?.outputTokens ?? 0;
  const reasoningOutputTokens = parsed.stats?.thoughtTokens ?? 0;
  const hasUsage =
    parsed.stats !== undefined &&
    (promptTokens > 0 || cachedInputTokens > 0 || outputTokens > 0 || reasoningOutputTokens > 0);

  if (!hasUsage) {
    return {
      summary,
      usage: normalizeUsage({
        actualUsd: 0,
        tokensIn: 0,
        tokensOut: 0,
        provenance: "unavailable",
        providerSettlement: {
          providerId: "gemini",
          model: modelLabel ?? "flash",
          transport: "cli",
          source: "unavailable",
          inputTokens: 0,
          outputTokens: 0,
          rawUsageAvailable: false,
          settledAt: new Date().toISOString()
        }
      })
    };
  }

  const tokensIn = promptTokens + cachedInputTokens;
  const tokensOut = outputTokens + reasoningOutputTokens;
  const pricing =
    (modelLabel ? MODEL_PRICING[modelLabel] : undefined) ??
    { inputPer1K: BLENDED_INPUT_COST_PER_1K, outputPer1K: BLENDED_OUTPUT_COST_PER_1K };
  const actualUsd =
    (promptTokens / 1000) * pricing.inputPer1K +
    (cachedInputTokens / 1000) * (pricing.cachedInputPer1K ?? pricing.inputPer1K) +
    (tokensOut / 1000) * pricing.outputPer1K;

  return {
    summary,
    usage: normalizeUsage({
      actualUsd: Number(actualUsd.toFixed(6)),
      tokensIn,
      tokensOut,
      cachedInputTokens,
      reasoningTokensOut: reasoningOutputTokens,
      provenance: "actual",
      providerSettlement: {
        providerId: "gemini",
        model: modelLabel ?? "flash",
        transport: "cli",
        source: "gemini_json",
        inputTokens: promptTokens,
        cachedInputTokens,
        outputTokens,
        reasoningOutputTokens,
        rawUsageAvailable: true,
        settledAt: new Date().toISOString()
      }
    })
  };
}

// ---------------------------------------------------------------------------
// Streaming usage circuit breaker (stream-json)
//
// `claude --print --output-format json` only emits a single JSON blob at
// process exit, so a runaway attempt's true cost/token consumption is
// invisible until the whole subprocess has already finished — by which point
// MartinLoop has no way to stop the spend (proven live: a $1 budget attempt
// settled at $3.50 actual / ~93x the configured token cap). `stream-json`
// emits one JSON object per turn, each carrying that turn's usage, so we can
// track cumulative spend in real time and kill the subprocess the moment it
// crosses the per-attempt cap — bounding the worst case to roughly one turn's
// overshoot instead of the entire runaway session.
// ---------------------------------------------------------------------------

interface StreamingUsageSnapshot {
  cumulativeUsd: number;
  tokensIn: number;
  tokensOut: number;
  turns: number;
  finalResult?: ClaudeJsonOutput;
}

function createStreamingUsageInspector(
  capUsd: number,
  modelLabel: string | undefined
): {
  onChunk: (chunk: Buffer, terminate: (reason: string) => void) => void;
  snapshot: () => StreamingUsageSnapshot;
} {
  const pricing =
    (modelLabel ? MODEL_PRICING[modelLabel] : undefined) ??
    { inputPer1K: BLENDED_INPUT_COST_PER_1K, outputPer1K: BLENDED_OUTPUT_COST_PER_1K };

  let buffer = "";
  let cumulativeUsd = 0;
  let tokensIn = 0;
  let tokensOut = 0;
  let turns = 0;
  let finalResult: ClaudeJsonOutput | undefined;

  const ingestLine = (line: string, terminate: (reason: string) => void) => {
    const trimmed = line.trim();
    if (!trimmed) {
      return;
    }

    let event: ClaudeJsonOutput & { message?: { usage?: Record<string, number> } };
    try {
      event = JSON.parse(trimmed) as typeof event;
    } catch {
      return;
    }

    if (event.type === "assistant" && event.message?.usage) {
      const usage = event.message.usage;
      const turnTokensIn =
        (usage.input_tokens ?? usage.inputTokens ?? 0) +
        (usage.cache_read_input_tokens ?? usage.cacheReadInputTokens ?? 0) +
        (usage.cache_creation_input_tokens ?? usage.cacheCreationInputTokens ?? 0);
      const turnTokensOut = usage.output_tokens ?? usage.outputTokens ?? 0;

      tokensIn += turnTokensIn;
      tokensOut += turnTokensOut;
      turns += 1;
      cumulativeUsd += (turnTokensIn / 1000) * pricing.inputPer1K + (turnTokensOut / 1000) * pricing.outputPer1K;

      if (capUsd > 0 && cumulativeUsd > capUsd) {
        terminate(
          `Streaming usage cap exceeded after ${String(turns)} turn(s): cumulative cost ~$${cumulativeUsd.toFixed(4)} ` +
            `surpassed the per-attempt cap $${capUsd.toFixed(4)} (derived from remaining loop budget). ` +
            `Subprocess terminated to bound runaway overspend.`
        );
      }
      return;
    }

    if (event.type === "result") {
      finalResult = event;
    }
  };

  return {
    onChunk: (chunk, terminate) => {
      buffer += chunk.toString("utf8");
      let newlineIndex = buffer.indexOf("\n");
      while (newlineIndex !== -1) {
        const line = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);
        ingestLine(line, terminate);
        newlineIndex = buffer.indexOf("\n");
      }
    },
    snapshot: () => ({ cumulativeUsd, tokensIn, tokensOut, turns, ...(finalResult ? { finalResult } : {}) })
  };
}

/**
 * Parses Claude's `stream-json` output (one JSON object per line) and returns
 * the final `result` event, which carries the same `result`/`usage`/
 * `total_cost_usd` fields as the single-blob `json` format.
 */
function parseStreamJsonResult(stdout: string): ClaudeJsonOutput | undefined {
  let lastResult: ClaudeJsonOutput | undefined;
  for (const rawLine of stdout.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }
    try {
      const event = JSON.parse(line) as ClaudeJsonOutput;
      if (event.type === "result") {
        lastResult = event;
      }
    } catch {
      // Ignore non-JSON / partial lines.
    }
  }
  return lastResult;
}

// ---------------------------------------------------------------------------
// Structural failure hint detection
//
// Provides a classHint to failure-taxonomy based on structural evidence
// rather than keyword scanning (which suffers from false positives).
// ---------------------------------------------------------------------------

function inferStructuralClassHint(
  agentOutput: string,
  verificationSummary: string,
  exitCode: number,
  objective: string
): FailureClass | undefined {
  // Exit code + stderr "Error:" pattern → syntax error
  if (exitCode !== 0 && /\bError:/i.test(verificationSummary)) {
    return "syntax_error";
  }

  // Agent output grossly longer than objective → scope creep signal
  // (5× ratio heuristic: if the agent wrote 5× more than the objective length, flag it)
  if (agentOutput.length > objective.length * 10 && agentOutput.length > 2000) {
    return "scope_creep";
  }

  // Repeated identical short responses → stalled / hallucination
  const trimmed = agentOutput.trim();
  if (trimmed.length < 100 && trimmed.length > 0) {
    // Very short response on a non-trivial task could be hallucination
    return "hallucination";
  }

  return undefined;
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Given a prompt string, returns the full argv array to pass to spawn().
 * Example for Claude:  () => ["--output-format", "json", "--print"]
 * Example for Codex:   () => ["exec", "--sandbox", "workspace-write", "-"]
 */
export type CliArgsBuilder = (prompt: string) => string[];
export type CliStdinBuilder = (prompt: string) => string | undefined;

export interface AgentCliAdapterOptions {
  /** The executable to spawn (e.g. "claude", "codex"). */
  command: string;
  /** Converts a prompt string into the argv array passed to spawn(). */
  argsBuilder: CliArgsBuilder;
  /** Optional stdin payload for CLIs that accept prompt input via stdin or `-`. */
  stdinBuilder?: CliStdinBuilder;
  /** Adapter ID suffix. Defaults to command. */
  adapterIdSuffix?: string;
  /** Working directory for all subprocesses. Defaults to process.cwd(). */
  workingDirectory?: string;
  /** Timeout for the agent subprocess in ms. Defaults to 300_000 (5 min). */
  timeoutMs?: number;
  /** Timeout per verification command in ms. Defaults to 60_000 (1 min). */
  verifyTimeoutMs?: number;
  /** Human-readable label shown in loop records. */
  label?: string;
  /** Model name surfaced in adapter metadata (also used for cost estimation). */
  model?: string;
  /**
   * Whether the CLI outputs JSON when --output-format json is passed.
   * Set to false for CLIs that don't support this flag (e.g. Codex).
   * Defaults to true for Claude.
   */
  supportsJsonOutput?: boolean;
  /**
   * Set when `argsBuilder` requests `--output-format stream-json` (newline-
   * delimited JSON events) rather than single-blob `json`. Enables (a)
   * incremental result parsing that scans for the final `result` event, and
   * (b) a live cumulative-cost circuit breaker that terminates the subprocess
   * the moment projected spend crosses the remaining per-attempt budget,
   * rather than only learning about an overspend after the process exits.
   */
  streamingUsageCap?: boolean;
  /** Test-only override for subprocess spawning. */
  spawnImpl?: SpawnLike;
}

export interface ClaudeCliAdapterOptions {
  workingDirectory?: string;
  timeoutMs?: number;
  verifyTimeoutMs?: number;
  label?: string;
  /** Override the model passed via --model flag. */
  model?: string;
  /** Extra args appended after core args (before prompt). */
  extraArgs?: string[];
  spawnImpl?: SpawnLike;
}

export interface CodexCliAdapterOptions {
  /** Override the executable or absolute command path used to launch Codex. */
  command?: string;
  workingDirectory?: string;
  timeoutMs?: number;
  verifyTimeoutMs?: number;
  label?: string;
  /** Override the model passed via --model flag. */
  model?: string;
  /**
   * Deprecated no-op retained for compatibility.
   *
   * Codex CLI's supported non-interactive entrypoint is `codex exec`.
   * MartinLoop now uses explicit sandboxing instead of the legacy
   * `--full-auto` compatibility path, which can exit before verifier execution.
   */
  fullAuto?: boolean;
  /** Codex sandbox mode for model-generated commands. Defaults to workspace-write. */
  sandbox?: "read-only" | "workspace-write" | "danger-full-access";
  /** Extra args appended after core args (before prompt). */
  extraArgs?: string[];
  spawnImpl?: SpawnLike;
}

export interface GeminiCliAdapterOptions {
  workingDirectory?: string;
  timeoutMs?: number;
  verifyTimeoutMs?: number;
  label?: string;
  /** Override the model passed via --model flag. Defaults to the Gemini `flash` alias. */
  model?: string;
  /** Approval mode for headless Gemini runs. Defaults to yolo for autonomous execution. */
  approvalMode?: "default" | "auto_edit" | "yolo" | "plan";
  /** Enable Gemini sandbox mode when the host is configured for it. Disabled by default. */
  sandbox?: boolean;
  /** Extra args appended after core args. */
  extraArgs?: string[];
  spawnImpl?: SpawnLike;
}

// ---------------------------------------------------------------------------
// Generic factory
// ---------------------------------------------------------------------------

export function createAgentCliAdapter(options: AgentCliAdapterOptions): MartinAdapter {
  const workingDirectory = options.workingDirectory ?? process.cwd();
  const timeoutMs = options.timeoutMs ?? 300_000;
  const verifyTimeoutMs = options.verifyTimeoutMs ?? 60_000;
  const adapterId = `agent-cli:${options.adapterIdSuffix ?? options.command}`;
  const supportsJsonOutput = options.supportsJsonOutput === true;
  const supportsUsageSettlement =
    supportsJsonOutput || options.command === "codex" || options.command === "gemini";

  const adapter: MartinAdapter = {
    adapterId,
    kind: "agent-cli",
    label: options.label ?? `${options.command} CLI adapter`,
    metadata: {
      providerId: options.command,
      model: options.model ?? options.command,
      transport: "cli",
      capabilities: createAdapterCapabilities({
        preflight: true,
        usageSettlement: supportsUsageSettlement,
        diffArtifacts: true,
        structuredErrors: true,
        cachingSignals: supportsUsageSettlement
      })
    },

    async execute(request: MartinAdapterRequest): Promise<MartinAdapterResult> {
      const prompt = buildPrompt(request);
      const estimatedUsage = estimateUsage(prompt, options.model ?? options.command);

      // Preflight: bail if projected cost exceeds remaining budget
      if (request.context.remainingBudgetUsd > 0) {
        const projected = estimatePromptCost(prompt, options.model ?? "");
        if (projected > request.context.remainingBudgetUsd * 0.95) {
          return {
            status: "failed",
            summary: `Preflight: projected cost $${projected.toFixed(4)} exceeds remaining budget $${request.context.remainingBudgetUsd.toFixed(4)}.`,
            usage: normalizeUsage({
              actualUsd: projected,
              estimatedUsd: projected,
              tokensIn: estimatedUsage.tokensIn,
              tokensOut: estimatedUsage.tokensOut,
              provenance: "estimated"
            }),
            verification: { passed: false, summary: "Stopped before execution: budget preflight failed." },
            failure: { message: "budget_preflight_exceeded", classHint: "budget_pressure" as FailureClass }
          };
        }
      }

      const args = options.argsBuilder(prompt);
      const stdinData = options.stdinBuilder?.(prompt);

      // Live cumulative-cost circuit breaker: a single attempt should never be
      // allowed to spend more than the loop has left. `--output-format json`
      // only reports usage once the process exits, so for `stream-json` we
      // watch per-turn usage events as they arrive and kill the subprocess the
      // instant projected spend crosses what remains — bounding the worst case
      // to roughly one turn's overshoot rather than the entire runaway session.
      const streamingUsage =
        options.streamingUsageCap && request.context.remainingBudgetUsd > 0
          ? createStreamingUsageInspector(request.context.remainingBudgetUsd, options.model ?? options.command)
          : undefined;

      const agentResult = await runSubprocess(options.command, args, {
        cwd: workingDirectory,
        timeoutMs,
        spawnImpl: options.spawnImpl,
        ...(stdinData === undefined ? {} : { stdinData }),
        ...(streamingUsage ? { onStdoutChunk: streamingUsage.onChunk } : {})
      });

      if (agentResult.terminationReason) {
        const snapshot = streamingUsage?.snapshot();
        const cumulativeUsd = snapshot?.cumulativeUsd ?? 0;
        return {
          status: "failed",
          summary: `${options.command} subprocess terminated mid-run by the budget circuit breaker. ${agentResult.terminationReason}`,
          usage: normalizeUsage({
            actualUsd: Number(cumulativeUsd.toFixed(6)),
            estimatedUsd: Number(cumulativeUsd.toFixed(6)),
            tokensIn: snapshot?.tokensIn ?? 0,
            tokensOut: snapshot?.tokensOut ?? 0,
            provenance: "estimated"
          }),
          verification: {
            passed: false,
            summary: "Subprocess terminated by the streaming budget circuit breaker before verification could run."
          },
          failure: {
            message: agentResult.terminationReason,
            classHint: "budget_pressure" as FailureClass
          }
        };
      }

      if (agentResult.timedOut) {
        return {
          status: "failed",
          summary: `${options.command} subprocess timed out before completing.`,
          usage: normalizeUsage({
            actualUsd: estimatedUsage.actualUsd,
            estimatedUsd: estimatedUsage.actualUsd,
            tokensIn: estimatedUsage.tokensIn,
            tokensOut: estimatedUsage.tokensOut,
            provenance: "estimated"
          }),
          verification: { passed: false, summary: "Subprocess timed out." },
          failure: {
            message: `${options.command} did not respond within ${String(timeoutMs)}ms. stalled`
          }
        };
      }

      if (agentResult.exitCode !== 0 && agentResult.stdout.trim().length === 0) {
        const failureMessage = formatPreVerifierSubprocessFailure(options.command, agentResult.stderr, agentResult.exitCode);
        return {
          status: "failed",
          summary: `${options.command} subprocess exited before verifier execution.`,
          usage: normalizeUsage({
            actualUsd: 0,
            tokensIn: 0,
            tokensOut: 0,
            provenance: "unavailable"
          }),
          verification: { passed: false, summary: `Verifier not run: ${failureMessage}` },
          failure: {
            message: failureMessage
          }
        };
      }

      // Parse JSON output if the CLI supports it. `stream-json` emits one JSON
      // object per line — the final `result` event carries the same
      // `result`/`usage`/`total_cost_usd` fields as single-blob `json` output.
      let parsed: ClaudeJsonOutput | undefined;
      if (supportsJsonOutput) {
        try {
          parsed = options.streamingUsageCap
            ? parseStreamJsonResult(agentResult.stdout)
            : (JSON.parse(agentResult.stdout) as ClaudeJsonOutput);
        } catch {
          // Fall through to plain-text handling
        }
      }

      const codexJsonlResult =
        !supportsJsonOutput && options.command === "codex"
          ? extractCodexJsonlResult(agentResult.stdout, options.model)
          : undefined;
      const geminiJsonResult =
        !supportsJsonOutput && options.command === "gemini"
          ? extractGeminiJsonResult(agentResult.stdout, options.model)
          : undefined;
      const producedStructuredCompletion =
        parsed?.result !== undefined ||
        codexJsonlResult !== undefined ||
        geminiJsonResult !== undefined;
      if (agentResult.exitCode !== 0 && !producedStructuredCompletion) {
        const failureMessage = formatPreVerifierSubprocessFailure(
          options.command,
          agentResult.stderr || agentResult.stdout,
          agentResult.exitCode
        );
        return {
          status: "failed",
          summary: `${options.command} subprocess exited before verifier execution.`,
          usage: normalizeUsage({
            actualUsd: 0,
            tokensIn: 0,
            tokensOut: 0,
            provenance: "unavailable"
          }),
          verification: { passed: false, summary: `Verifier not run: ${failureMessage}` },
          failure: {
            message: failureMessage
          }
        };
      }

      const agentText =
        codexJsonlResult?.summary ??
        geminiJsonResult?.summary ??
        parsed?.result ??
        agentResult.stdout.trim();
      const summary = truncate(agentText, 2000);
      const usage = parsed?.usage
        ? extractUsage(parsed, options.model)
        : codexJsonlResult?.usage ??
          geminiJsonResult?.usage ??
          normalizeUsage({
            actualUsd: estimatedUsage.actualUsd,
            estimatedUsd: estimatedUsage.actualUsd,
            tokensIn: estimatedUsage.tokensIn,
            tokensOut: Math.max(estimatedUsage.tokensOut, Math.ceil(agentText.length / 4)),
            provenance: "estimated",
            providerSettlement:
              options.command === "codex"
                ? {
                    providerId: "codex",
                    model: options.model ?? "codex",
                    transport: "cli",
                    source: "estimated_fallback",
                    inputTokens: estimatedUsage.tokensIn,
                    outputTokens: Math.max(estimatedUsage.tokensOut, Math.ceil(agentText.length / 4)),
                    rawUsageAvailable: false,
                    settledAt: new Date().toISOString()
                  }
                : options.command === "gemini"
                  ? {
                      providerId: "gemini",
                      model: options.model ?? "flash",
                      transport: "cli",
                      source: "estimated_fallback",
                      inputTokens: estimatedUsage.tokensIn,
                      outputTokens: Math.max(estimatedUsage.tokensOut, Math.ceil(agentText.length / 4)),
                      rawUsageAvailable: false,
                      settledAt: new Date().toISOString()
                    }
                : undefined
          });

      const verificationStack = (request.context as { verificationStack?: Array<{ command: string; type: string; fastFail?: boolean }> }).verificationStack;
      const verification = await runVerification(
        request.context.verificationPlan,
        workingDirectory,
        verifyTimeoutMs,
        verificationStack,
        options.spawnImpl
      );

      // Check for zero-diff (agent ran but made no file changes)
      const repoRoot = (request.context as { repoRoot?: string }).repoRoot;
      const gitRepoRoot = repoRoot ? resolveGitRepositoryRoot(repoRoot) : undefined;
      let noDiff = false;
      if (gitRepoRoot) {
        noDiff = await checkNoDiff(gitRepoRoot, options.spawnImpl);
      }

      // Extract structured errors from stderr/stdout for better failure context
      const structuredErrors = normalizeStructuredErrors(
        extractStructuredErrors(agentResult.stderr, agentResult.stdout)
      );
      const executionArtifacts = gitRepoRoot
        ? await readGitExecutionArtifacts(gitRepoRoot, 5000, options.spawnImpl)
        : undefined;

      // Scope contract enforcement: check touched files against allowedPaths/deniedPaths
      let scopeViolations: string[] = [];
      const scopeCtx = request.context as { allowedPaths?: string[]; deniedPaths?: string[] };
      if (gitRepoRoot && (scopeCtx.allowedPaths?.length || scopeCtx.deniedPaths?.length)) {
        const diffResult = await runSubprocess("git", ["diff", "--name-only", "HEAD"], {
          cwd: gitRepoRoot,
          timeoutMs: 5000,
          spawnImpl: options.spawnImpl
        });
        if (diffResult.exitCode === 0 && diffResult.stdout.trim()) {
          const touchedFiles = diffResult.stdout.trim().split("\n").filter(Boolean);
          const allowed = scopeCtx.allowedPaths ?? [];
          const denied = scopeCtx.deniedPaths ?? [];

          for (const file of touchedFiles) {
            // Check denied patterns (simple glob-like: prefix or exact)
            if (denied.some((d) => file === d || file.startsWith(d.replace(/\*+$/, "")))) {
              scopeViolations.push(file);
              continue;
            }
            // If allowedPaths specified, file must match at least one
            if (allowed.length > 0 && !allowed.some((a) => file === a || file.startsWith(a.replace(/\*+$/, "")))) {
              scopeViolations.push(file);
            }
          }
        }
      }

      // Derive structural classHint from evidence, not keyword scanning
      const structuralHint = inferStructuralClassHint(
        agentText,
        verification.summary,
        agentResult.exitCode,
        request.context.objective
      );

      if (verification.passed) {
        return {
          status: "completed",
          summary,
          usage,
          verification: { passed: true, summary: verification.summary },
          ...(executionArtifacts
            ? {
                execution: {
                  ...executionArtifacts,
                  ...(structuredErrors.length > 0 ? { structuredErrors } : {})
                }
              }
            : structuredErrors.length > 0
              ? { execution: { structuredErrors } }
              : {})
        };
      }

      const classHint: FailureClass | undefined = scopeViolations.length > 0
        ? "scope_creep"
        : noDiff
          ? "no_progress"
          : (structuralHint ?? undefined);

      const errorBlock = structuredErrors.length > 0
        ? `\nSTRUCTURED ERRORS:\n${structuredErrors.map(e => `  ${e.file}${e.line !== undefined ? `:${String(e.line)}` : ""} — ${e.code ? `${e.code}: ` : ""}${e.message}`).join("\n")}`
        : "";

      const scopeBlock = scopeViolations.length > 0
        ? `\n  Scope violations: ${scopeViolations.join(", ")}`
        : "";

      // Write PROGRESS.md to help the next attempt re-anchor on the original objective
      if (repoRoot) {
        try {
          const { writeFile, readFile, appendFile: appendFs } = await import("node:fs/promises");
          const progressPath = `${repoRoot}/PROGRESS.md`;
          const timestamp = new Date().toISOString();
          const entry = `\n## Attempt ${String(request.previousAttempts.length + 1)} — ${timestamp}\n- Failure class: ${classHint ?? "verification_failure"}\n- Verification: ${verification.summary}${errorBlock}${scopeBlock}\n`;
          let content: string;
          try {
            content = await readFile(progressPath, "utf8");
          } catch {
            content = `# Martin Loop Progress\n\n**Original objective:** ${request.context.objective}\n`;
          }
          await writeFile(progressPath, content + entry, "utf8");
        } catch {
          // Non-fatal
        }

        // Reset tracked files to HEAD so next attempt starts from clean state
        try {
          if (gitRepoRoot) {
            await runSubprocess("git", ["restore", "--staged", "--worktree", "."], {
              cwd: gitRepoRoot,
              timeoutMs: 5000
            });
          }
        } catch {
          // Non-fatal
        }
      }

      return {
        status: "failed",
        summary: (structuredErrors.length > 0 || scopeViolations.length > 0)
          ? `${summary}${errorBlock}${scopeViolations.length > 0 ? `\nScope violations: ${scopeViolations.join(", ")}` : ""}`
          : summary,
        usage,
        verification: { passed: false, summary: verification.summary },
        ...(executionArtifacts
          ? {
              execution: {
                ...executionArtifacts,
                ...(structuredErrors.length > 0 ? { structuredErrors } : {})
              }
            }
          : structuredErrors.length > 0
            ? { execution: { structuredErrors } }
            : {}),
        failure: {
          message: verification.summary,
          ...(classHint ? { classHint } : {})
        }
      };
    },

    /**
     * Return a new adapter instance with a different model.
     * Used by run-martin.ts when a change_model intervention fires.
     * Model escalation order: haiku → sonnet → opus (cheapest-first, escalate on repeated failure).
     */
    withModel(newModel: string): MartinAdapter {
      return createAgentCliAdapter({
        ...options,
        model: newModel,
        adapterIdSuffix: `${options.adapterIdSuffix ?? options.command}:${newModel}`
      });
    }
  };

  return adapter;
}

// ---------------------------------------------------------------------------
// Pre-configured: Claude CLI
// ---------------------------------------------------------------------------

/**
 * Spawns `claude --output-format stream-json --verbose --print "<prompt>" [extraArgs]`.
 *
 * `stream-json` emits one JSON event per line — including per-turn usage on
 * each `assistant` message and a final `result` event carrying the same
 * `result`/`usage`/`total_cost_usd` fields as single-blob `json` output — so
 * MartinLoop can both (a) recover real token usage/cost as before, and
 * (b) watch cumulative spend live and self-terminate the subprocess the
 * moment it crosses the remaining per-attempt budget (see
 * `streamingUsageCap` / `createStreamingUsageInspector`), instead of only
 * discovering an overspend after the whole process has already exited.
 *
 * Requires the Claude Code CLI to be installed and authenticated:
 *   https://docs.anthropic.com/claude-code
 */
export function createClaudeCliAdapter(options: ClaudeCliAdapterOptions = {}): MartinAdapter {
  const modelArgs: string[] = options.model ? ["--model", options.model] : [];
  const extraArgs = options.extraArgs ?? [];

  return createAgentCliAdapter({
    command: "claude",
    adapterIdSuffix: "claude",
    model: options.model ?? "claude-sonnet-4-6",
    label: options.label ?? "Claude CLI adapter",
    workingDirectory: options.workingDirectory,
    timeoutMs: options.timeoutMs,
    verifyTimeoutMs: options.verifyTimeoutMs,
    supportsJsonOutput: true,
    streamingUsageCap: true,
    spawnImpl: options.spawnImpl,
    argsBuilder: (_prompt) => [
      "--output-format",
      "stream-json",
      "--verbose",
      "--print",
      "--dangerously-skip-permissions",
      ...modelArgs,
      ...extraArgs
    ],
    stdinBuilder: (prompt) => prompt
  });
}

// ---------------------------------------------------------------------------
// Pre-configured: OpenAI Codex CLI
// ---------------------------------------------------------------------------

/**
 * Spawns `codex exec --cd <workspace> --sandbox <mode> [--model <model>] [extraArgs] -`.
 *
 * The prompt is delivered via stdin so Windows shell quoting cannot truncate or
 * reinterpret long MartinLoop prompts that contain paths, deny rules, or budget
 * context.
 *
 * Requires the Codex CLI to be installed and authenticated:
 *   npm install -g @openai/codex
 */
export function createCodexCliAdapter(options: CodexCliAdapterOptions = {}): MartinAdapter {
  const extraArgs = options.extraArgs ?? [];
  const sandbox = options.sandbox ?? "workspace-write";
  const workingDirectory = options.workingDirectory ?? process.cwd();
  const command = options.command ?? "codex";

  return createAgentCliAdapter({
    command,
    adapterIdSuffix: "codex",
    model: options.model ?? "codex",
    label: options.label ?? "Codex CLI adapter",
    workingDirectory,
    timeoutMs: options.timeoutMs,
    verifyTimeoutMs: options.verifyTimeoutMs,
    supportsJsonOutput: false,
    spawnImpl: options.spawnImpl,
    argsBuilder: () =>
      buildCodexExecArgs({
        workingDirectory,
        sandbox,
        ...(options.model ? { model: options.model } : {}),
        extraArgs,
        mode: "prompt"
      }),
    stdinBuilder: (prompt) => prompt
  });
}

// ---------------------------------------------------------------------------
// Pre-configured: Gemini CLI
// ---------------------------------------------------------------------------

/**
 * Spawns `gemini --model <model> --prompt "" --approval-mode <mode> --output-format json [...]`.
 *
 * The prompt is delivered via stdin while forcing headless mode with `--prompt ""`,
 * which keeps large MartinLoop prompts off the command line on Windows.
 *
 * Requires the Gemini CLI to be installed and authenticated:
 *   npm install -g @google/gemini-cli
 */
export function createGeminiCliAdapter(options: GeminiCliAdapterOptions = {}): MartinAdapter {
  const model = options.model ?? "flash";
  const approvalMode = options.approvalMode ?? "yolo";
  const extraArgs = options.extraArgs ?? [];

  return createAgentCliAdapter({
    command: "gemini",
    adapterIdSuffix: "gemini",
    model,
    label: options.label ?? "Gemini CLI adapter",
    workingDirectory: options.workingDirectory,
    timeoutMs: options.timeoutMs,
    verifyTimeoutMs: options.verifyTimeoutMs,
    supportsJsonOutput: false,
    spawnImpl: options.spawnImpl,
    argsBuilder: () => [
      "--model",
      model,
      "--prompt",
      "",
      "--approval-mode",
      approvalMode,
      ...(options.sandbox ? ["--sandbox"] : []),
      "--output-format",
      "json",
      ...extraArgs
    ],
    stdinBuilder: (prompt) => prompt
  });
}

// ---------------------------------------------------------------------------
// Prompt builder
//
// Implements Qralph-style context isolation:
// - Each attempt gets a fresh, distilled prompt — NOT the full conversation history
// - Prior attempts are summarized (last 3 max, via distillContext in core)
// - Interventions translate into concrete prompt directives
// - Context budget info surfaces remaining runway to the agent
// ---------------------------------------------------------------------------

function buildPrompt(request: MartinAdapterRequest): string {
  const lines: string[] = [];
  const mutationMode = request.context.mutationMode ?? "edit";

  lines.push("You are running in autonomous agentic mode.");
  if (mutationMode === "verify_only") {
    lines.push("DO NOT EDIT FILES. Run the verifier only and report whether it passes.");
    lines.push("Do not ask for confirmation. Do not ask clarifying questions.");
  } else {
    lines.push("MAKE ALL REQUIRED FILE EDITS NOW. Do not ask for confirmation. Do not ask clarifying questions.");
    lines.push("Do not explain what you found without also making the changes. Edit the files and complete the task.");
  }
  lines.push("");

  lines.push("If PROGRESS.md exists in your working directory, read it first for context from prior attempts.");
  lines.push("If it does not exist, proceed with the objective below.");
  lines.push("");

  lines.push(
    mutationMode === "verify_only"
      ? "Complete the following verification-only task without making file changes."
      : "Complete the following coding task. Make all necessary file changes."
  );
  lines.push("When you are done, the verification commands listed below must pass.");
  lines.push("");

  lines.push("OBJECTIVE:");
  lines.push(sanitizeForPrompt(request.context.objective));
  lines.push("");

  // Acceptance criteria (from task contract)
  if ((request.context as { acceptanceCriteria?: string[] }).acceptanceCriteria?.length) {
    lines.push("ACCEPTANCE CRITERIA (all must be satisfied):");
    for (const criterion of (request.context as { acceptanceCriteria?: string[] }).acceptanceCriteria ?? []) {
      lines.push(`  - ${sanitizeForPrompt(criterion)}`);
    }
    lines.push("");
  }

  // Scope contract
  const ctx = request.context as { allowedPaths?: string[]; deniedPaths?: string[] };
  if (ctx.allowedPaths?.length || ctx.deniedPaths?.length) {
    lines.push("SCOPE CONTRACT (immutable — do not expand):");
    if (ctx.allowedPaths?.length) {
      lines.push(`  Allowed paths: ${ctx.allowedPaths.join(", ")}`);
    }
    if (ctx.deniedPaths?.length) {
      lines.push(`  Forbidden paths: ${ctx.deniedPaths.join(", ")}`);
    }
    lines.push("");
  }

  if (request.context.verificationPlan.length > 0) {
    lines.push("VERIFICATION (all commands must exit with code 0):");
    for (const cmd of request.context.verificationPlan) {
      lines.push(`  ${cmd}`);
    }
    lines.push("");
  }

  const attemptNumber = request.previousAttempts.length + 1;
  lines.push("CONSTRAINTS:");
  lines.push(`  Attempt ${String(attemptNumber)}`);
  lines.push(`  Remaining budget: $${String(request.context.remainingBudgetUsd)} USD`);
  lines.push(`  Remaining iterations: ${String(request.context.remainingIterations)}`);
  lines.push(
    mutationMode === "verify_only"
      ? "  Do not modify files; only run verification."
      : "  Do not expand scope beyond what is needed to pass verification."
  );
  lines.push("");

  if (request.previousAttempts.length > 0) {
    lines.push("PRIOR FAILED ATTEMPTS (learn from these — do not repeat the same mistakes):");
    for (const attempt of request.previousAttempts) {
      const failurePart = attempt.failureClass ? ` [${attempt.failureClass}]` : "";
      const interventionPart = attempt.intervention ? ` -> intervention: ${attempt.intervention}` : "";
      lines.push(`  Attempt ${String(attempt.index)}${failurePart}: ${sanitizeForPrompt(attempt.summary ?? "")}${interventionPart}`);
    }
    lines.push("");
  }

  // Intervention directives
  const lastIntervention = request.previousAttempts.at(-1)?.intervention;
  if (lastIntervention === "tighten_task") {
    lines.push("SCOPE LOCK (prior attempt expanded scope — do not repeat):");
    lines.push("  Only touch files directly required to make the verification commands pass.");
    lines.push("  Do NOT add features, refactor unrelated code, or modify files outside the objective.");
    lines.push("");
  }
  if (lastIntervention === "compress_context") {
    lines.push("BREVITY MODE (prior attempt was too large — be concise):");
    lines.push("  Keep changes minimal. Only output what changed and why.");
    lines.push("");
  }
  if (lastIntervention === "run_verifier") {
    lines.push("VERIFICATION FOCUS (prior attempt failed verification):");
    lines.push("  Before finalizing, mentally simulate running each verification command.");
    lines.push("  Only mark yourself done when confident all commands will pass.");
    lines.push("");
  }
  if (lastIntervention === "change_model") {
    lines.push("FRESH APPROACH (previous attempts did not converge):");
    lines.push("  Do not repeat prior reasoning. Start from first principles on the objective.");
    lines.push("");
  }

  lines.push(`FOCUS: ${sanitizeForPrompt(request.context.focus)}`);
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) {
    return text;
  }

  return `...${text.slice(-(maxLength - 3))}`;
}

function formatPreVerifierSubprocessFailure(command: string, stderr: string, exitCode: number): string {
  const detail = stderr.trim() || `Exit code ${String(exitCode)}`;
  const lowerDetail = detail.toLowerCase();
  const codexLaunchBlocked =
    command === "codex" &&
    /\b(full-auto|sandbox|approval|permission|trusted|safety|unexpected argument)\b/u.test(lowerDetail);

  if (codexLaunchBlocked) {
    return `Codex CLI failed before patch completion, likely due to its launch/sandbox configuration. MartinLoop invokes Codex through "codex exec --sandbox workspace-write"; verify Codex CLI auth and configuration if this persists. ${detail}. environment_mismatch`;
  }

  return `${detail}. environment_mismatch`;
}

const INJECTION_PATTERNS = [
  /\[INST\]/gi,
  /<\/?system>/gi,
  /^(IGNORE|DISREGARD|FORGET|NEW INSTRUCTION|OVERRIDE)\b.+$/gim,
  /<\/?s>/gi
] as const;

function sanitizeForPrompt(input: string): string {
  let out = input;
  for (const pattern of INJECTION_PATTERNS) {
    out = out.replace(pattern, "[FILTERED]");
  }
  return redactSecretsForPrompt(out);
}

function estimatePromptCost(promptText: string, model: string): number {
  const inputTokens = Math.ceil(promptText.length / 3.5);
  const outputTokens = 2000;
  const pricing = MODEL_PRICING[model] ?? { inputPer1K: BLENDED_INPUT_COST_PER_1K, outputPer1K: BLENDED_OUTPUT_COST_PER_1K };
  return (inputTokens / 1000) * pricing.inputPer1K + (outputTokens / 1000) * pricing.outputPer1K;
}

function estimateUsage(promptText: string, model: string): MartinAdapterResult["usage"] {
  const inputTokens = Math.ceil(promptText.length / 3.5);
  const outputTokens = 2_000;

  return normalizeUsage({
    actualUsd: estimatePromptCost(promptText, model),
    estimatedUsd: estimatePromptCost(promptText, model),
    tokensIn: inputTokens,
    tokensOut: outputTokens,
    provenance: "estimated"
  });
}

function redactSecretsForPrompt(input: string): string {
  return input
    .replace(/\bOPENAI_API_KEY\s*=\s*[^\s"'`]+/giu, "OPENAI_API_KEY=[REDACTED_SECRET]")
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/gu, "[REDACTED_SECRET]")
    .replace(/\bghp_[A-Za-z0-9_]{16,}\b/gu, "[REDACTED_SECRET]")
    .replace(/\bgithub_pat_[A-Za-z0-9_]{20,}\b/gu, "[REDACTED_SECRET]")
    .replace(/\b(?:gho|ghu|ghs|ghr)_[A-Za-z0-9_]{16,}\b/gu, "[REDACTED_SECRET]")
    .replace(/\bAKIA[0-9A-Z]{16}\b/gu, "[REDACTED_SECRET]")
    .replace(/\b(?:aws_secret_access_key|AWS_SECRET_ACCESS_KEY)\s*[:=]\s*[^\s"'`]+/giu, "AWS_SECRET_ACCESS_KEY=[REDACTED_SECRET]")
    .replace(/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/giu, "[REDACTED_SECRET]")
    .replace(/\bAIza[0-9A-Za-z_-]{30,}\b/gu, "[REDACTED_SECRET]")
    .replace(/-----BEGIN(?:\s+[A-Z0-9]+)*\s+PRIVATE KEY-----[\s\S]*?-----END(?:\s+[A-Z0-9]+)*\s+PRIVATE KEY-----/gu, "[REDACTED_SECRET]")
    .replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/gu, "[REDACTED_SECRET]")
    .replace(/\B\.env(?!\.example\b)(?:\.[A-Za-z0-9._-]+)?\b/giu, "[REDACTED_PATH]");
}

interface StructuredError {
  file: string;
  line?: number;
  col?: number;
  code?: string;
  message: string;
}

function extractStructuredErrors(stderr: string, stdout: string): StructuredError[] {
  const errors: StructuredError[] = [];
  const combined = `${stderr}\n${stdout}`;

  // TypeScript: file.ts(42,5): error TS2322: message
  for (const m of combined.matchAll(/^(.+\.tsx?)\((\d+),(\d+)\): error (TS\d+): (.+)$/gm)) {
    errors.push({ file: m[1] ?? "", line: Number(m[2]), col: Number(m[3]), code: m[4], message: m[5] ?? "" });
  }

  // ESLint / tsc path-style: ./src/foo.ts:42:5: error message
  for (const m of combined.matchAll(/^(\.?\/[\w./-]+\.tsx?):(\d+):(\d+):\s+error\s+(.+)$/gm)) {
    errors.push({ file: m[1] ?? "", line: Number(m[2]), col: Number(m[3]), message: m[4] ?? "" });
  }

  // Jest FAIL line: FAIL src/foo.test.ts
  for (const m of combined.matchAll(/^FAIL\s+([\w./-]+\.test\.[jt]sx?)$/gm)) {
    errors.push({ file: m[1] ?? "", message: "Test suite failed" });
  }

  return errors.slice(0, 10); // cap at 10 to avoid bloating prompts
}

async function checkNoDiff(repoRoot: string, spawnImpl?: SpawnLike): Promise<boolean> {
  const result = await runSubprocess("git", ["diff", "--name-only", "HEAD"], {
    cwd: repoRoot,
    timeoutMs: 5000,
    spawnImpl
  });
  return result.exitCode === 0 && result.stdout.trim().length === 0;
}
