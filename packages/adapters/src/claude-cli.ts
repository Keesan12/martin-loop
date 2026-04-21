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
  runSubprocess,
  runVerification,
  type SpawnLike
} from "./cli-bridge.js";
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
const MODEL_PRICING: Record<string, { inputPer1K: number; outputPer1K: number }> = {
  "claude-opus-4-6":   { inputPer1K: 0.015,  outputPer1K: 0.075 },
  "claude-sonnet-4-6": { inputPer1K: 0.003,  outputPer1K: 0.015 },
  "claude-haiku-4-5":  { inputPer1K: 0.00025, outputPer1K: 0.00125 },
  // Keep legacy names working
  "claude-opus":       { inputPer1K: 0.015,  outputPer1K: 0.075 },
  "claude-sonnet":     { inputPer1K: 0.003,  outputPer1K: 0.015 },
  "claude-haiku":      { inputPer1K: 0.00025, outputPer1K: 0.00125 }
};

// ---------------------------------------------------------------------------
// Claude CLI JSON output shape (--output-format json)
// ---------------------------------------------------------------------------

interface ClaudeJsonOutput {
  type: string;
  subtype?: string;
  result?: string;
  error?: string;
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

  const tokensIn =
    (parsed.usage.inputTokens ?? parsed.usage.input_tokens ?? 0) +
    (parsed.usage.cacheReadInputTokens ?? parsed.usage.cache_read_input_tokens ?? 0) +
    (parsed.usage.cacheCreationInputTokens ?? parsed.usage.cache_creation_input_tokens ?? 0);
  const tokensOut = parsed.usage.outputTokens ?? parsed.usage.output_tokens ?? 0;

  const pricing =
    (modelLabel ? MODEL_PRICING[modelLabel] : undefined) ??
    { inputPer1K: BLENDED_INPUT_COST_PER_1K, outputPer1K: BLENDED_OUTPUT_COST_PER_1K };

  const actualUsd =
    (tokensIn / 1000) * pricing.inputPer1K +
    (tokensOut / 1000) * pricing.outputPer1K;

  return normalizeUsage({
    actualUsd: Number(actualUsd.toFixed(6)),
    tokensIn,
    tokensOut,
    provenance: "actual"
  });
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
 * Example for Claude:  (p) => ["--print", p, "--dangerously-skip-permissions"]
 * Example for Codex:   (p) => ["--full-auto", p]
 */
export type CliArgsBuilder = (prompt: string) => string[];

export interface AgentCliAdapterOptions {
  /** The executable to spawn (e.g. "claude", "codex"). */
  command: string;
  /** Converts a prompt string into the argv array passed to spawn(). */
  argsBuilder: CliArgsBuilder;
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
  workingDirectory?: string;
  timeoutMs?: number;
  verifyTimeoutMs?: number;
  label?: string;
  /** Override the model passed via --model flag. */
  model?: string;
  /** Run in full-auto mode (--full-auto). Defaults to true. */
  fullAuto?: boolean;
  /** Extra args appended after core args (before prompt). */
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
        usageSettlement: supportsJsonOutput,
        diffArtifacts: true,
        structuredErrors: true,
        cachingSignals: supportsJsonOutput
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

      // stdinPrompt: if argsBuilder signals stdin delivery by returning args ending with "--stdin-prompt",
      // remove that sentinel and pass the prompt via stdin instead (avoids Windows shell-escaping issues).
      const useStdin = args.at(-1) === "--stdin-prompt";
      const spawnArgs = useStdin ? args.slice(0, -1) : args;

      const agentResult = await runSubprocess(options.command, spawnArgs, {
        cwd: workingDirectory,
        timeoutMs,
        spawnImpl: options.spawnImpl,
        ...(useStdin ? { stdinData: prompt } : {})
      });

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
        return {
          status: "failed",
          summary: `${options.command} subprocess exited with an error.`,
          usage: normalizeUsage({
            actualUsd: 0,
            tokensIn: 0,
            tokensOut: 0,
            provenance: "unavailable"
          }),
          verification: { passed: false, summary: "Subprocess error." },
          failure: {
            message: `${agentResult.stderr.trim() || `Exit code ${String(agentResult.exitCode)}`}. environment_mismatch`
          }
        };
      }

      // Parse JSON output if the CLI supports it (Claude with --output-format json)
      let parsed: ClaudeJsonOutput | undefined;
      if (supportsJsonOutput) {
        try {
          parsed = JSON.parse(agentResult.stdout) as ClaudeJsonOutput;
        } catch {
          // Fall through to plain-text handling
        }
      }

      const agentText = parsed?.result ?? agentResult.stdout.trim();
      const summary = truncate(agentText, 2000);
      const usage = parsed?.usage
        ? extractUsage(parsed, options.model)
        : normalizeUsage({
            actualUsd: estimatedUsage.actualUsd,
            estimatedUsd: estimatedUsage.actualUsd,
            tokensIn: estimatedUsage.tokensIn,
            tokensOut: Math.max(estimatedUsage.tokensOut, Math.ceil(agentText.length / 4)),
            provenance: "estimated"
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
      let noDiff = false;
      if (repoRoot) {
        noDiff = await checkNoDiff(repoRoot);
      }

      // Extract structured errors from stderr/stdout for better failure context
      const structuredErrors = normalizeStructuredErrors(
        extractStructuredErrors(agentResult.stderr, agentResult.stdout)
      );
      const executionArtifacts = repoRoot
        ? await readGitExecutionArtifacts(repoRoot, 5000, options.spawnImpl)
        : undefined;

      // Scope contract enforcement: check touched files against allowedPaths/deniedPaths
      let scopeViolations: string[] = [];
      const scopeCtx = request.context as { allowedPaths?: string[]; deniedPaths?: string[] };
      if (repoRoot && (scopeCtx.allowedPaths?.length || scopeCtx.deniedPaths?.length)) {
        const diffResult = await runSubprocess("git", ["diff", "--name-only", "HEAD"], { cwd: repoRoot, timeoutMs: 5000 });
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
          await runSubprocess("git", ["restore", "--staged", "--worktree", "."], { cwd: repoRoot, timeoutMs: 5000 });
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
 * Spawns `claude --output-format json --print "<prompt>" --dangerously-skip-permissions [extraArgs]`.
 *
 * The --output-format json flag causes Claude CLI to return structured JSON
 * including real token usage counts, enabling accurate cost tracking.
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
    spawnImpl: options.spawnImpl,
    argsBuilder: (_prompt) => [
      "--output-format",
      "json",
      "--print",
      "--dangerously-skip-permissions",
      ...modelArgs,
      ...extraArgs,
      "--stdin-prompt"  // sentinel: tells execute() to deliver prompt via stdin
    ]
  });
}

// ---------------------------------------------------------------------------
// Pre-configured: OpenAI Codex CLI
// ---------------------------------------------------------------------------

/**
 * Spawns `codex [--full-auto] [--model <model>] "<prompt>" [extraArgs]`.
 *
 * Requires the Codex CLI to be installed and authenticated:
 *   npm install -g @openai/codex
 */
export function createCodexCliAdapter(options: CodexCliAdapterOptions = {}): MartinAdapter {
  const fullAuto = options.fullAuto !== false;
  const modelArgs: string[] = options.model ? ["--model", options.model] : [];
  const extraArgs = options.extraArgs ?? [];

  return createAgentCliAdapter({
    command: "codex",
    adapterIdSuffix: "codex",
    model: options.model ?? "codex",
    label: options.label ?? "Codex CLI adapter",
    workingDirectory: options.workingDirectory,
    timeoutMs: options.timeoutMs,
    verifyTimeoutMs: options.verifyTimeoutMs,
    supportsJsonOutput: false,
    spawnImpl: options.spawnImpl,
    argsBuilder: (prompt) => [
      ...(fullAuto ? ["--full-auto"] : []),
      ...modelArgs,
      prompt,
      ...extraArgs
    ]
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

  lines.push("You are running in autonomous agentic mode.");
  lines.push("MAKE ALL REQUIRED FILE EDITS NOW. Do not ask for confirmation. Do not ask clarifying questions.");
  lines.push("Do not explain what you found without also making the changes. Edit the files and complete the task.");
  lines.push("");

  lines.push("If PROGRESS.md exists in your working directory, read it first for context from prior attempts.");
  lines.push("If it does not exist, proceed with the objective below.");
  lines.push("");

  lines.push("Complete the following coding task. Make all necessary file changes.");
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
  lines.push("  Do not expand scope beyond what is needed to pass verification.");
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
    .replace(/\bghp_[A-Za-z0-9_]{8,}\b/gu, "[REDACTED_SECRET]")
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

async function checkNoDiff(repoRoot: string): Promise<boolean> {
  const result = await runSubprocess("git", ["diff", "--name-only", "HEAD"], { cwd: repoRoot, timeoutMs: 5000 });
  return result.exitCode === 0 && result.stdout.trim().length === 0;
}
