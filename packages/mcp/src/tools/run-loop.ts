import {
  createClaudeCliAdapter,
  createCodexCliAdapter,
  createStubDirectProviderAdapter
} from "@martin/adapters";

import { createFileRunStore, evaluateCostGovernor, resolveRunsRoot, runMartin } from "@martin/core";
import { DEFAULT_BUDGET, type LoopBudget } from "@martin/contracts";

import { normalizeSafePathPatterns, resolveSafeRepoRoot } from "../server-validation.js";
import { MartinToolError, rateLimitExceededError } from "./tool-errors.js";
import {
  buildArtifactSummary,
  buildVerificationSummary,
  buildLoopPreview,
  buildRunRecordPaths,
  getEngineAvailability,
  resolveExecutionMode,
  type MartinEngine
} from "./tool-support.js";

export interface RunLoopInput {
  objective: string;
  workingDirectory?: string;
  engine?: "claude" | "codex";
  model?: string;
  maxUsd?: number;
  maxIterations?: number;
  maxTokens?: number;
  verificationPlan?: string[];
  allowedPaths?: string[];
  deniedPaths?: string[];
  workspaceId?: string;
  projectId?: string;
}

export interface RunLoopOutput {
  status: string;
  lifecycleState: string;
  reason: string;
  attempts: number;
  costUsd: number;
  verificationPassed: boolean;
  loopId: string;
  pressure: string;
  shouldStop: boolean;
  remainingBudgetUsd: number;
  remainingIterations: number;
  remainingTokens: number;
  engine: MartinEngine;
  workingDirectory: string;
  budget: LoopBudget;
  inspection: {
    runsRoot: string;
    runDirectory: string;
    loopRecordPath: string;
    ledgerPath: string;
    loop: ReturnType<typeof buildLoopPreview>;
    verification: ReturnType<typeof buildVerificationSummary>;
    artifacts: ReturnType<typeof buildArtifactSummary>;
  };
}

interface RunLoopRateLimitState {
  inFlight: number;
  startedAt: number[];
}

const RUN_LOOP_LIMIT_STATE = new Map<string, RunLoopRateLimitState>();
const DEFAULT_MAX_CONCURRENT_RUNS = 2;
const DEFAULT_MAX_RUN_STARTS = 4;
const DEFAULT_RUN_WINDOW_SECONDS = 600;

export async function runLoopTool(input: RunLoopInput): Promise<RunLoopOutput> {
  const workingDirectory = resolveSafeRepoRoot(input.workingDirectory);
  const releaseRateLimit = acquireRunLoopRateLimit(workingDirectory);
  const engine = input.engine ?? "claude";
  const model = input.model;
  const allowedPaths = normalizeSafePathPatterns(input.allowedPaths, "allowedPaths");
  const deniedPaths = normalizeSafePathPatterns(input.deniedPaths, "deniedPaths");
  const executionMode = resolveExecutionMode();
  const engineAvailability = getEngineAvailability(engine);

  if (executionMode.liveMode && !engineAvailability.available) {
    throw new MartinToolError("engine_unavailable", `Engine '${engine}' is not available on PATH.`, {
      category: "environment",
      suggestion: "Install the requested CLI or set MARTIN_LIVE=false for stub execution.",
      retryable: false
    });
  }

  const adapter =
    process.env.MARTIN_LIVE === "false"
      ? createStubDirectProviderAdapter({ label: "Stub adapter (MARTIN_LIVE=false)", providerId: "stub", model: "stub" })
      : engine === "codex"
        ? createCodexCliAdapter({ workingDirectory, ...(model ? { model } : {}) })
        : createClaudeCliAdapter({ workingDirectory, ...(model ? { model } : {}) });

  const partialBudget: Partial<LoopBudget> = {};
  if (input.maxUsd !== undefined) {
    partialBudget.maxUsd = input.maxUsd;
  }
  if (input.maxIterations !== undefined) {
    partialBudget.maxIterations = input.maxIterations;
  }
  if (input.maxTokens !== undefined) {
    partialBudget.maxTokens = input.maxTokens;
  }

  const budget: LoopBudget = {
    ...DEFAULT_BUDGET,
    ...partialBudget
  };

  try {
    const result = await runMartin({
      workspaceId: input.workspaceId ?? "ws_mcp",
      projectId: input.projectId ?? "proj_mcp",
      store: createFileRunStore({ runsRoot: resolveRunsRoot(process.env) }),
      task: {
        title: input.objective.slice(0, 100),
        objective: input.objective,
        verificationPlan: input.verificationPlan ?? [],
        repoRoot: workingDirectory,
        ...(allowedPaths ? { allowedPaths } : {}),
        ...(deniedPaths ? { deniedPaths } : {})
      },
      budget,
      adapter
    });

    const lastAttempt = result.loop.attempts.at(-1);
    const verificationPassed =
      lastAttempt !== undefined && result.decision.lifecycleState === "completed";
    const costState = evaluateCostGovernor({
      budget: result.loop.budget,
      cost: {
        actualUsd: result.loop.cost.actualUsd,
        avoidedUsd: result.loop.cost.avoidedUsd ?? 0,
        tokensIn: result.loop.cost.tokensIn,
        tokensOut: result.loop.cost.tokensOut
      },
      attemptsUsed: result.loop.attempts.length
    });
    const runsRoot = resolveRunsRoot(process.env);
    const recordPaths = buildRunRecordPaths(runsRoot, result.loop.loopId);
    const verification = buildVerificationSummary(result.loop);
    const artifacts = buildArtifactSummary(result.loop);

    return {
      status: result.loop.status,
      lifecycleState: result.decision.lifecycleState,
      reason: result.decision.reason,
      attempts: result.loop.attempts.length,
      costUsd: result.loop.cost.actualUsd,
      verificationPassed,
      loopId: result.loop.loopId,
      pressure: costState.pressure,
      shouldStop: costState.shouldStop,
      remainingBudgetUsd: costState.remainingBudgetUsd,
      remainingIterations: costState.remainingIterations,
      remainingTokens: costState.remainingTokens,
      engine,
      workingDirectory,
      budget,
      inspection: {
        ...recordPaths,
        loop: buildLoopPreview(result.loop),
        verification,
        artifacts
      }
    };
  } finally {
    releaseRateLimit();
  }
}

export function resetRunLoopRateLimitForTests(): void {
  RUN_LOOP_LIMIT_STATE.clear();
}

function acquireRunLoopRateLimit(workingDirectory: string): () => void {
  const key = `${workingDirectory}::martin_run`;
  const now = Date.now();
  const windowMs = resolveRunWindowSeconds() * 1_000;
  const maxConcurrent = resolvePositiveInteger(
    process.env.MARTIN_MCP_RUN_LIMIT_MAX_CONCURRENT,
    DEFAULT_MAX_CONCURRENT_RUNS
  );
  const maxStarts = resolvePositiveInteger(
    process.env.MARTIN_MCP_RUN_LIMIT_MAX,
    DEFAULT_MAX_RUN_STARTS
  );
  const state = RUN_LOOP_LIMIT_STATE.get(key) ?? {
    inFlight: 0,
    startedAt: []
  };

  state.startedAt = state.startedAt.filter((startedAt) => now - startedAt < windowMs);

  if (state.inFlight >= maxConcurrent) {
    throw rateLimitExceededError(
      "Local MCP run limits blocked martin_run because too many runs are already active for this workspace.",
      1,
      "Wait for an active Martin run to finish or raise the local concurrency limit."
    );
  }

  if (state.startedAt.length >= maxStarts) {
    const retryAfterMs = Math.max(windowMs - (now - state.startedAt[0]!), 1_000);
    throw rateLimitExceededError(
      "Local MCP run limits blocked martin_run because too many runs were started for this workspace.",
      Math.ceil(retryAfterMs / 1_000),
      "Wait for the local Martin run window to cool down or raise the local start-rate limit."
    );
  }

  state.inFlight += 1;
  state.startedAt.push(now);
  RUN_LOOP_LIMIT_STATE.set(key, state);

  let released = false;
  return () => {
    if (released) {
      return;
    }
    released = true;
    const latest = RUN_LOOP_LIMIT_STATE.get(key);
    if (!latest) {
      return;
    }

    latest.inFlight = Math.max(0, latest.inFlight - 1);
    latest.startedAt = latest.startedAt.filter((startedAt) => now - startedAt < windowMs);

    if (latest.inFlight === 0 && latest.startedAt.length === 0) {
      RUN_LOOP_LIMIT_STATE.delete(key);
      return;
    }

    RUN_LOOP_LIMIT_STATE.set(key, latest);
  };
}

function resolveRunWindowSeconds(): number {
  return resolvePositiveInteger(
    process.env.MARTIN_MCP_RUN_LIMIT_WINDOW_SECONDS,
    DEFAULT_RUN_WINDOW_SECONDS
  );
}

function resolvePositiveInteger(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}
