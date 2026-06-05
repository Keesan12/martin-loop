import {
  createClaudeCliAdapter,
  createCodexCliAdapter,
  createVerifierOnlyAdapter
} from "@martin/adapters";

import { createFileRunStore, evaluateCostGovernor, resolveRunsRoot, runMartin } from "@martin/core";
import { DEFAULT_BUDGET, type LoopBudget } from "@martin/contracts";

import { normalizeSafePathPatterns, resolveSafeRepoRoot } from "../server-validation.js";
import { MartinToolError } from "./tool-errors.js";
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

export async function runLoopTool(input: RunLoopInput): Promise<RunLoopOutput> {
  const workingDirectory = resolveSafeRepoRoot(input.workingDirectory);
  const engine = input.engine ?? "claude";
  const model = input.model;
  const allowedPaths = normalizeSafePathPatterns(input.allowedPaths, "allowedPaths");
  const deniedPaths = normalizeSafePathPatterns(input.deniedPaths, "deniedPaths");
  const executionMode = resolveExecutionMode();
  const engineAvailability = await getEngineAvailability(engine, workingDirectory);

  if (executionMode.liveMode && !engineAvailability.launchReady) {
    throw new MartinToolError("engine_unavailable", `Engine '${engine}' is not launch-ready.`, {
      category: "environment",
      suggestion: "Install the requested CLI or set MARTIN_LIVE=false for a no-spend proof run.",
      retryable: false
    });
  }

  const adapter =
    process.env.MARTIN_LIVE === "false"
      ? createVerifierOnlyAdapter({
          workingDirectory,
          adapterId: "direct:proof:verifier-only",
          label: "Proof mode adapter (MARTIN_LIVE=false)",
          providerId: "proof",
          model: "verify-only",
          successSummary: "Proof mode completed without contacting a live provider.",
          successWithChangesSummary:
            "Proof mode completed without contacting a live provider, but the verifier changed files.",
          failureSummary: "Proof mode failed during verifier execution."
        })
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

  const result = await runMartin({
    workspaceId: input.workspaceId ?? "ws_mcp",
    projectId: input.projectId ?? "proj_mcp",
    store: createFileRunStore({ runsRoot: resolveRunsRoot(process.env) }),
    task: {
      title: input.objective.slice(0, 100),
      objective: input.objective,
      verificationPlan: input.verificationPlan ?? [],
      ...(executionMode.liveMode ? {} : { mutationMode: "verify_only" as const }),
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
}
