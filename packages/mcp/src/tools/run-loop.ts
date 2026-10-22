import {
  createClaudeCliAdapter,
  createCodexCliAdapter,
  createGeminiCliAdapter,
  createOpenAiCompatibleAdapter,
  resolveOpenAiCompatibleRuntimeConfig,
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
  type MartinAdapter,
  type RunStore
} from "@martin/core";
import type { ExecutionMode, LoopBudget, ReceiptScope } from "@martin/contracts";

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
  /** Explicit ordered provider fallbacks authorized by the caller. */
  fallbackEngines?: MartinEngine[];
  maxUsd?: number;
  maxIterations?: number;
  maxTokens?: number;
  verifyTimeoutMs?: number;
  providerExecutionTimeoutMs?: number;
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
  executionMode: ExecutionMode;
  governanceClaimEligible: boolean;
  loopId: string;
  pressure: string;
  shouldStop: boolean;
  remainingBudgetUsd: number;
  remainingIterations: number;
  remainingTokens?: number;
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

export function __setProofModeVerifierSpawnImplForTests(spawnImpl?: SpawnLike): void {
  proofModeVerifierSpawnImpl = spawnImpl;
}

export function __setRunStoreOverrideForTests(store?: RunStore): void {
  runStoreOverrideForTests = store;
}

function assertAuthorizedFallbackEngines(
  primary: MartinEngine,
  fallbacks: MartinEngine[]
): void {
  const seen = new Set<MartinEngine>();
  for (const fallback of fallbacks) {
    if (fallback === primary) {
      throw new MartinToolError("invalid_arguments", "Fallback chain cannot repeat the primary engine.", {
        category: "invalid_input",
        retryable: false
      });
    }
    if (seen.has(fallback)) {
      throw new MartinToolError("invalid_arguments", `Duplicate fallback engine '${fallback}'.`, {
        category: "invalid_input",
        retryable: false
      });
    }
    seen.add(fallback);
  }
}

function ensureLiveEngineReady(
  engine: MartinEngine,
  workingDirectory: string,
  providerExecutionTimeoutMs?: number
): ReturnType<typeof probeCodexLaunch> | undefined {
  if (engine === "openai") {
    const config = resolveOpenAiCompatibleRuntimeConfig();
    const localEndpoint = /^(?:https?:\/\/)?(?:localhost|127\.0\.0\.1|\[::1\])(?::|\/|$)/iu.test(
      config.baseUrl
    );
    if (!config.model) {
      throw new MartinToolError(
        "engine_unavailable",
        "Authorized OpenAI-compatible fallback has no configured model.",
        {
          category: "environment",
          suggestion: "Set MARTIN_OPENAI_MODEL before authorizing the OpenAI fallback.",
          retryable: false
        }
      );
    }
    if (!config.apiKeyConfigured && !localEndpoint) {
      throw new MartinToolError(
        "engine_unavailable",
        "Authorized OpenAI-compatible fallback is not authenticated.",
        {
          category: "environment",
          suggestion: "Set MARTIN_OPENAI_API_KEY, or use an explicitly local OpenAI-compatible endpoint.",
          retryable: false
        }
      );
    }
    return undefined;
  }
  if (engine === "codex") {
    const availability = resolveCliCommandAvailability("codex");
    if (!availability.available) {
      throw new MartinToolError("engine_unavailable", "Engine 'codex' is not available on PATH.", {
        category: "environment",
        suggestion: "Install/authenticate Codex before authorizing it for governed execution.",
        retryable: false
      });
    }
    const probe = probeCodexLaunch({
      workingDirectory,
      availability,
      ...(providerExecutionTimeoutMs !== undefined ? { providerExecutionTimeoutMs } : {})
    });
    if (!probe.ok) {
      throw new MartinToolError("engine_unavailable", probe.summary, {
        category: "environment",
        suggestion: "Run martin_doctor or martin_preflight with engine='codex' before retrying.",
        retryable: false
      });
    }
    return probe;
  }
  const availability = getEngineAvailability(engine);
  if (!availability.available) {
    throw new MartinToolError("engine_unavailable", `Engine '${engine}' is not available on PATH.`, {
      category: "environment",
      suggestion: "Install/authenticate every provider explicitly listed in the fallback chain.",
      retryable: false
    });
  }
  return undefined;
}

function createLiveEngineAdapter(input: {
  engine: MartinEngine;
  workingDirectory: string;
  model?: string;
  verifyTimeoutMs?: number;
  providerExecutionTimeoutMs?: number;
  codexProbe?: ReturnType<typeof probeCodexLaunch>;
}): MartinAdapter {
  if (input.engine === "codex") {
    return createCodexCliAdapter({
      workingDirectory: input.workingDirectory,
      ...(input.verifyTimeoutMs !== undefined ? { verifyTimeoutMs: input.verifyTimeoutMs } : {}),
      ...(input.providerExecutionTimeoutMs !== undefined
        ? { providerExecutionTimeoutMs: input.providerExecutionTimeoutMs }
        : {}),
      ...(input.model ? { model: input.model } : {}),
      ...(input.codexProbe
        ? {
            command: input.codexProbe.command,
            capabilityProfile: input.codexProbe.capabilityProfile,
            autonomyResolution: input.codexProbe.autonomyResolution
          }
        : {})
    });
  }
  if (input.engine === "gemini") {
    return createGeminiCliAdapter({
      workingDirectory: input.workingDirectory,
      ...(input.verifyTimeoutMs !== undefined ? { verifyTimeoutMs: input.verifyTimeoutMs } : {}),
      ...(input.providerExecutionTimeoutMs !== undefined
        ? { providerExecutionTimeoutMs: input.providerExecutionTimeoutMs }
        : {}),
      ...(input.model ? { model: input.model } : {})
    });
  }
  if (input.engine === "openai") {
    const config = resolveOpenAiCompatibleRuntimeConfig();
    const resolvedModel = input.model ?? config.model;
    return createOpenAiCompatibleAdapter({
      baseUrl: config.baseUrl,
      apiKey: config.apiKey,
      ...(resolvedModel ? { model: resolvedModel } : {}),
      workingDirectory: input.workingDirectory,
      ...(input.verifyTimeoutMs !== undefined ? { verifyTimeoutMs: input.verifyTimeoutMs } : {})
    });
  }
  return createClaudeCliAdapter({
    workingDirectory: input.workingDirectory,
    ...(input.verifyTimeoutMs !== undefined ? { verifyTimeoutMs: input.verifyTimeoutMs } : {}),
    ...(input.providerExecutionTimeoutMs !== undefined
      ? { providerExecutionTimeoutMs: input.providerExecutionTimeoutMs }
      : {}),
    ...(input.model ? { model: input.model } : {})
  });
}

export async function runLoopTool(input: RunLoopInput): Promise<RunLoopOutput> {
  const workingDirectory = resolveSafeRepoRoot(input.workingDirectory);
  const engine = input.engine ?? "claude";
  const model = input.model;
  const fallbackEngines = input.fallbackEngines ?? [];
  assertAuthorizedFallbackEngines(engine, fallbackEngines);
  const allowedPaths = normalizeSafePathPatterns(input.allowedPaths, "allowedPaths");
  const deniedPaths = normalizeSafePathPatterns(input.deniedPaths, "deniedPaths");
  const executionMode = resolveExecutionMode();
  const evidenceExecutionMode: ExecutionMode = executionMode.liveMode
    ? "governed"
    : "verification_only";
  const workspaceRoot = resolveSafeRepoRoot();
  const runsRoot = resolveRunsRoot(process.env);
  const receiptScope = {
    invocationRoot: workspaceRoot,
    workingDirectory,
    repoRoot: workingDirectory,
    runsRoot
  };
  let codexProbeOverride: ReturnType<typeof probeCodexLaunch> | undefined;
  const fallbackProbeOverrides = new Map<
    MartinEngine,
    ReturnType<typeof probeCodexLaunch> | undefined
  >();
  if (executionMode.liveMode) {
    codexProbeOverride = ensureLiveEngineReady(
      engine,
      workingDirectory,
      input.providerExecutionTimeoutMs
    );
    for (const fallbackEngine of fallbackEngines) {
      fallbackProbeOverrides.set(
        fallbackEngine,
        ensureLiveEngineReady(
          fallbackEngine,
          workingDirectory,
          input.providerExecutionTimeoutMs
        )
      );
    }
  }

  const adapter =
    !executionMode.liveMode
      ? createVerifierOnlyAdapter({
          workingDirectory,
          label: "Verification-only adapter (MARTIN_LIVE=false)",
          ...(input.verifyTimeoutMs !== undefined ? { verifyTimeoutMs: input.verifyTimeoutMs } : {}),
          ...(proofModeVerifierSpawnImpl ? { spawnImpl: proofModeVerifierSpawnImpl } : {})
        })
      : createLiveEngineAdapter({
          engine,
          workingDirectory,
          ...(model ? { model } : {}),
          ...(input.verifyTimeoutMs !== undefined ? { verifyTimeoutMs: input.verifyTimeoutMs } : {}),
          ...(input.providerExecutionTimeoutMs !== undefined
            ? { providerExecutionTimeoutMs: input.providerExecutionTimeoutMs }
            : {}),
          ...(codexProbeOverride ? { codexProbe: codexProbeOverride } : {})
        });

  if (!executionMode.liveMode && fallbackEngines.length > 0) {
    throw new MartinToolError("invalid_arguments", "fallbackEngines are available only in live governed mode.", {
      category: "invalid_input",
      retryable: false
    });
  }
  const fallbackAdapters = executionMode.liveMode
    ? fallbackEngines.map((fallbackEngine) =>
        createLiveEngineAdapter({
          engine: fallbackEngine,
          workingDirectory,
          ...(input.verifyTimeoutMs !== undefined ? { verifyTimeoutMs: input.verifyTimeoutMs } : {}),
          ...(input.providerExecutionTimeoutMs !== undefined
            ? { providerExecutionTimeoutMs: input.providerExecutionTimeoutMs }
            : {}),
          ...(fallbackEngine === "codex"
            ? {
                codexProbe: ensureLiveEngineReady(
                  fallbackEngine,
                  workingDirectory,
                  input.providerExecutionTimeoutMs
                )
              }
            : {})
        })
      )
    : [];

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

  const result = await runMartin({
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
      ...(input.providerExecutionTimeoutMs !== undefined
        ? { providerExecutionTimeoutMs: input.providerExecutionTimeoutMs }
        : {}),
      repoRoot: workingDirectory,
      ...(allowedPaths ? { allowedPaths } : {}),
      ...(deniedPaths ? { deniedPaths } : {})
    },
    budget,
    metadata: {
      executionMode: evidenceExecutionMode,
      governanceClaimEligible: evidenceExecutionMode === "governed" ? "true" : "false",
      ...(executionMode.liveMode ? { authorizedPrimaryEngine: engine } : {}),
      ...(executionMode.liveMode && fallbackEngines.length > 0
        ? { authorizedFallbackEngines: fallbackEngines.join(",") }
        : {})
    },
    adapter,
    ...(fallbackAdapters.length > 0 ? { fallbackAdapters } : {})
  });

  const lastAttempt = result.loop.attempts.at(-1);
  // D5: verificationPassed must reflect authoritative verifier execution/binding,
  // NOT merely lifecycle completion. A run can complete without a real verifier
  // (when verificationPlan is empty or binding is absent). Only report true when
  // the lifecycle is completed AND the last attempt has verifierScore === 1.
  const verificationPassed =
    lastAttempt !== undefined &&
    result.decision.lifecycleState === "completed" &&
    (lastAttempt.verifierScore ?? 0) >= 1;
  const fallbackAdapterIndex = lastAttempt
    ? fallbackAdapters.findIndex((candidate) => candidate.adapterId === lastAttempt.adapterId)
    : -1;
  const effectiveEngine =
    fallbackAdapterIndex >= 0
      ? (fallbackEngines[fallbackAdapterIndex] ?? engine)
      : engine;
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
    executionMode: evidenceExecutionMode,
    governanceClaimEligible: evidenceExecutionMode === "governed",
    loopId: result.loop.loopId,
    pressure: costState.pressure,
    shouldStop: costState.shouldStop,
    remainingBudgetUsd: costState.remainingBudgetUsd,
    remainingIterations: costState.remainingIterations,
    ...(costState.remainingTokens !== undefined
      ? { remainingTokens: costState.remainingTokens }
      : {}),
    engine: effectiveEngine,
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
