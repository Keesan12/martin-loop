import {
  createClaudeCliAdapter,
  createCodexCliAdapter,
  createGeminiCliAdapter,
  probeCodexLaunch,
  resolveCliCommandAvailability,
  createVerifierOnlyAdapter,
  type SpawnLike
} from "@martin/adapters";

import {
  createFileRunStore,
  evaluateCostGovernor,
  resolveRunsRoot,
  runMartin,
  type RunStore
} from "@martin/core";
import type { ExecutionPolicy, LoopBudget, ReceiptScope } from "@martin/contracts";

import { normalizeSafePathPatterns, resolveSafeRepoRoot } from "../server-validation.js";
import { MartinToolError } from "./tool-errors.js";
import { compileMcpExecutionPolicy } from "./execution-policy.js";
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
  engine?: "claude" | "codex" | "gemini";
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
  effectivePolicy: ExecutionPolicy;
  inspection: {
    runsRoot: string;
    runDirectory: string;
    loopRecordPath: string;
    ledgerPath: string;
    receiptScope: ReceiptScope;
    loop: ReturnType<typeof buildLoopPreview>;
    verification: ReturnType<typeof buildVerificationSummary>;
    artifacts: ReturnType<typeof buildArtifactSummary>;
  };
}

let proofModeVerifierSpawnImpl: SpawnLike | undefined;
let runStoreOverrideForTests: RunStore | undefined;

export function __setProofModeVerifierSpawnImplForTests(spawnImpl?: SpawnLike): void {
  proofModeVerifierSpawnImpl = spawnImpl;
}

export function __setRunStoreOverrideForTests(store?: RunStore): void {
  runStoreOverrideForTests = store;
}

export async function runLoopTool(input: RunLoopInput): Promise<RunLoopOutput> {
  const workingDirectory = resolveSafeRepoRoot(input.workingDirectory);
  const engine = input.engine ?? "claude";
  const model = input.model;
  const allowedPaths = normalizeSafePathPatterns(input.allowedPaths, "allowedPaths");
  const deniedPaths = normalizeSafePathPatterns(input.deniedPaths, "deniedPaths");
  const executionMode = resolveExecutionMode();
  const workspaceRoot = resolveSafeRepoRoot();
  const runsRoot = resolveRunsRoot(process.env);
  const receiptScope = {
    invocationRoot: workspaceRoot,
    workingDirectory,
    repoRoot: workingDirectory,
    runsRoot
  };
  let codexCommandOverride: string | undefined;
  if (executionMode.liveMode) {
    if (engine === "codex") {
      const engineAvailability = resolveCliCommandAvailability("codex");
      if (!engineAvailability.available) {
        throw new MartinToolError("engine_unavailable", `Engine '${engine}' is not available on PATH.`, {
          category: "environment",
          suggestion: "Install the requested CLI or set MARTIN_LIVE=false for a no-spend proof run.",
          retryable: false
        });
      }

      const codexProbe = probeCodexLaunch({
        workingDirectory,
        availability: engineAvailability
      });
      if (!codexProbe.ok) {
        throw new MartinToolError("engine_unavailable", codexProbe.summary, {
          category: "environment",
          suggestion: "Run martin_doctor or martin_preflight with engine='codex' before retrying live governed work.",
          retryable: false
        });
      }
      codexCommandOverride = codexProbe.command;
    } else {
      const engineAvailability = getEngineAvailability(engine);
      if (!engineAvailability.available) {
        throw new MartinToolError("engine_unavailable", `Engine '${engine}' is not available on PATH.`, {
          category: "environment",
          suggestion: "Install the requested CLI or set MARTIN_LIVE=false for a no-spend proof run.",
          retryable: false
        });
      }
    }
  }

  const adapter =
    !executionMode.liveMode
      ? createVerifierOnlyAdapter({
          workingDirectory,
          label: "Proof mode adapter (MARTIN_LIVE=false)",
          ...(proofModeVerifierSpawnImpl ? { spawnImpl: proofModeVerifierSpawnImpl } : {})
        })
      : engine === "codex"
        ? createCodexCliAdapter({
            workingDirectory,
            ...(model ? { model } : {}),
            ...(codexCommandOverride ? { command: codexCommandOverride } : {})
          })
        : engine === "gemini"
          ? createGeminiCliAdapter({ workingDirectory, ...(model ? { model } : {}) })
          : createClaudeCliAdapter({ workingDirectory, ...(model ? { model } : {}) });

  const effectivePolicy = compileMcpExecutionPolicy({
    workingDirectory,
    maxUsd: input.maxUsd,
    maxIterations: input.maxIterations,
    maxTokens: input.maxTokens,
    verificationPlan: input.verificationPlan,
    allowedPaths,
    deniedPaths
  });
  const budget: LoopBudget = effectivePolicy.budget;

  const result = await runMartin({
    workspaceId: input.workspaceId ?? "ws_mcp",
    projectId: input.projectId ?? "proj_mcp",
    store: runStoreOverrideForTests ?? createFileRunStore({ runsRoot }),
    receiptScope,
    executionPolicy: effectivePolicy,
    task: {
      title: input.objective.slice(0, 100),
      objective: input.objective,
      ...effectivePolicy.task
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
    effectivePolicy,
    inspection: {
      ...recordPaths,
      receiptScope: result.loop.receiptScope ?? receiptScope,
      loop: buildLoopPreview(result.loop),
      verification,
      artifacts
    }
  };
}
