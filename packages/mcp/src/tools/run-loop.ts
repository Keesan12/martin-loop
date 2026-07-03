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
  type RunStore,
  type RunMartinInput,
  type RunMartinResult
} from "@martin/core";
import type { LoopBudget, ReceiptScope } from "@martin/contracts";

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
import { normalizeLoopBudget } from "./workflow-governance.js";

export interface RunLoopInput {
  objective: string;
  workingDirectory?: string;
  engine?: MartinEngine;
  model?: string;
  maxUsd?: number;
  maxIterations?: number;
  maxTokens?: number;
  verifyTimeoutMs?: number;
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
    receiptScope: ReceiptScope;
    loop: ReturnType<typeof buildLoopPreview>;
    verification: ReturnType<typeof buildVerificationSummary>;
    artifacts: ReturnType<typeof buildArtifactSummary>;
  };
}

let proofModeVerifierSpawnImpl: SpawnLike | undefined;
let runStoreOverrideForTests: RunStore | undefined;
let runMartinImpl: (input: RunMartinInput) => Promise<RunMartinResult> = runMartin;

export function __setProofModeVerifierSpawnImplForTests(spawnImpl?: SpawnLike): void {
  proofModeVerifierSpawnImpl = spawnImpl;
}

export function __setRunStoreOverrideForTests(store?: RunStore): void {
  runStoreOverrideForTests = store;
}

export function __setRunMartinImplForTests(
  impl?: (input: RunMartinInput) => Promise<RunMartinResult>
): void {
  runMartinImpl = impl ?? runMartin;
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
          ...(input.verifyTimeoutMs !== undefined ? { verifyTimeoutMs: input.verifyTimeoutMs } : {}),
          ...(proofModeVerifierSpawnImpl ? { spawnImpl: proofModeVerifierSpawnImpl } : {})
        })
      : engine === "codex"
        ? createCodexCliAdapter({
            workingDirectory,
            ...(input.verifyTimeoutMs !== undefined ? { verifyTimeoutMs: input.verifyTimeoutMs } : {}),
            ...(model ? { model } : {}),
            ...(codexCommandOverride ? { command: codexCommandOverride } : {})
          })
        : engine === "gemini"
          ? createGeminiCliAdapter({
              workingDirectory,
              ...(input.verifyTimeoutMs !== undefined ? { verifyTimeoutMs: input.verifyTimeoutMs } : {}),
              ...(model ? { model } : {})
            })
        : createClaudeCliAdapter({
            workingDirectory,
            ...(input.verifyTimeoutMs !== undefined ? { verifyTimeoutMs: input.verifyTimeoutMs } : {}),
            ...(model ? { model } : {})
          });

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

  const budget: LoopBudget = normalizeLoopBudget(partialBudget);

  const result = await runMartinImpl({
    workspaceId: input.workspaceId ?? "ws_mcp",
    projectId: input.projectId ?? "proj_mcp",
    store: runStoreOverrideForTests ?? createFileRunStore({ runsRoot }),
    receiptScope,
    task: {
      title: input.objective.slice(0, 100),
      objective: input.objective,
      verificationPlan: input.verificationPlan ?? [],
      ...(input.verifyTimeoutMs !== undefined
        ? { verificationTimeoutMs: input.verifyTimeoutMs }
        : {}),
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
      receiptScope: result.loop.receiptScope ?? receiptScope,
      loop: buildLoopPreview(result.loop),
      verification,
      artifacts
    }
  };
}
