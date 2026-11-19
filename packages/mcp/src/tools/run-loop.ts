import {
  createClaudeCliAdapter,
  createCodexCliAdapter,
  createGeminiCliAdapter,
  createOpenAiCompatibleAdapter,
  resolveOpenAiCompatibleRuntimeConfig,
  probeCodexLaunch,
  probeCodexLaunchAsync,
  resolveCliCommandAvailability,
  createVerifierOnlyAdapter,
  type CodexLaunchProbeAsyncResult,
  type SpawnLike
} from "@martin/adapters";

import {
  createFileRunStore,
  deniesAllWritablePaths,
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
  resolveProviderNeutralEngine,
  resolveExecutionMode,
  type MartinEngine
} from "./tool-support.js";
import { normalizeLoopBudget } from "./workflow-governance.js";
import { createFileRunControlSource } from "./run-controls.js";

export interface RunLoopInput {
  objective: string;
  workingDirectory?: string;
  engine?: MartinEngine;
  model?: string;
  pricePerMTokenUsd?: number;
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

export interface RunLoopExecutionContext {
  signal?: AbortSignal;
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
  engine: MartinEngine | "auto";
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
type LiveEngineReadinessProbe = (input: {
  engine: MartinEngine;
  workingDirectory: string;
  providerExecutionTimeoutMs?: number;
  model?: string;
  pricePerMTokenUsd?: number;
  signal?: AbortSignal;
}) => Promise<CodexLaunchProbeAsyncResult | ReturnType<typeof probeCodexLaunch> | undefined>;
let liveEngineReadinessProbeForTests: LiveEngineReadinessProbe | undefined;

export function __setLiveEngineReadinessProbeForTests(probe?: LiveEngineReadinessProbe): void {
  liveEngineReadinessProbeForTests = probe;
}

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

async function ensureLiveEngineReady(
  engine: MartinEngine,
  workingDirectory: string,
  providerExecutionTimeoutMs?: number,
  model?: string,
  pricePerMTokenUsd?: number,
  signal?: AbortSignal
): Promise<CodexLaunchProbeAsyncResult | ReturnType<typeof probeCodexLaunch> | undefined> {
  if (liveEngineReadinessProbeForTests) {
    const probe = await liveEngineReadinessProbeForTests({
      engine,
      workingDirectory,
      ...(providerExecutionTimeoutMs !== undefined ? { providerExecutionTimeoutMs } : {}),
      ...(model !== undefined ? { model } : {}),
      ...(pricePerMTokenUsd !== undefined ? { pricePerMTokenUsd } : {}),
      ...(signal !== undefined ? { signal } : {})
    });
    assertReadinessCleanupCompleted(probe);
    return probe;
  }
  if (engine === "openai") {
    const availability = getEngineAvailability(engine, model, pricePerMTokenUsd);
    if (!availability.available) {
      throw new MartinToolError("engine_unavailable", availability.detail, {
        category: "environment",
        suggestion: "Configure the OpenAI-compatible endpoint, model, and required authentication before live execution.",
        retryable: false
      });
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
    const probe = await probeCodexLaunchAsync({
      workingDirectory,
      availability,
      ...(providerExecutionTimeoutMs !== undefined ? { providerExecutionTimeoutMs } : {}),
      ...(model !== undefined ? { model } : {}),
      ...(signal !== undefined ? { signal } : {})
    });
    assertReadinessCleanupCompleted(probe);
    if (signal?.aborted) return undefined;
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

function assertReadinessCleanupCompleted(
  probe: CodexLaunchProbeAsyncResult | ReturnType<typeof probeCodexLaunch> | undefined
): void {
  if (probe && "processCleanup" in probe && probe.processCleanup.state === "failed") {
    throw new MartinToolError("engine_unavailable", probe.summary, {
      category: "environment",
      suggestion: "Inspect and terminate the surviving readiness process tree before retrying.",
      retryable: false,
      details: { processCleanup: probe.processCleanup }
    });
  }
}

function createLiveEngineAdapter(input: {
  engine: MartinEngine;
  workingDirectory: string;
  model?: string;
  pricePerMTokenUsd?: number;
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
    const config = resolveOpenAiCompatibleRuntimeConfig(
      process.env,
      undefined,
      undefined,
      input.pricePerMTokenUsd
    );
    const resolvedModel = input.model ?? config.model;
    return createOpenAiCompatibleAdapter({
      baseUrl: config.baseUrl,
      apiKey: config.apiKey,
      ...(resolvedModel ? { model: resolvedModel } : {}),
      ...(input.pricePerMTokenUsd !== undefined ? { pricePerMTokenUsd: input.pricePerMTokenUsd } : {}),
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

export async function runLoopTool(
  input: RunLoopInput,
  context: RunLoopExecutionContext = {}
): Promise<RunLoopOutput> {
  const workingDirectory = resolveSafeRepoRoot(input.workingDirectory);
  const executionMode = resolveExecutionMode();
  const neutralResolution = !input.engine && executionMode.liveMode
    ? resolveProviderNeutralEngine()
    : undefined;
  if (executionMode.liveMode && !input.engine && !neutralResolution?.engine) {
    throw new MartinToolError("engine_unavailable", neutralResolution?.detail ?? "Pass engine explicitly.", {
      category: neutralResolution?.availableEngines.length ? "invalid_input" : "environment",
      suggestion: "Pass engine explicitly after configuring and authenticating the intended provider.",
      retryable: false
    });
  }
  const engine = input.engine ?? neutralResolution?.engine ?? "auto";
  const selectedEngine = engine === "auto" ? undefined : engine;
  if (executionMode.liveMode && !selectedEngine) {
    throw new MartinToolError("engine_unavailable", "Live execution requires a resolved provider.", {
      category: "environment",
      suggestion: "Pass engine explicitly after configuring and authenticating the intended provider.",
      retryable: false
    });
  }
  const model = input.model;
  const fallbackEngines = input.fallbackEngines ?? [];
  if (engine !== "auto") assertAuthorizedFallbackEngines(engine, fallbackEngines);
  const allowedPaths = normalizeSafePathPatterns(input.allowedPaths, "allowedPaths");
  const deniedPaths = normalizeSafePathPatterns(input.deniedPaths, "deniedPaths");
  const deniesAllWrites = deniesAllWritablePaths(deniedPaths);
  const effectiveAllowedPaths = deniesAllWrites ? [] : allowedPaths;
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
  if (executionMode.liveMode && !deniesAllWrites && !context.signal?.aborted) {
    codexProbeOverride = await ensureLiveEngineReady(
      selectedEngine!,
      workingDirectory,
      input.providerExecutionTimeoutMs,
      model,
      input.pricePerMTokenUsd,
      context.signal
    );
    for (const fallbackEngine of fallbackEngines) {
      if (context.signal?.aborted) break;
      fallbackProbeOverrides.set(
        fallbackEngine,
        await ensureLiveEngineReady(
          fallbackEngine,
          workingDirectory,
          input.providerExecutionTimeoutMs,
          undefined,
          input.pricePerMTokenUsd,
          context.signal
        )
      );
    }
  }

  const providerPreparationSkipped = deniesAllWrites || context.signal?.aborted === true;
  const noLaunchAdapter: MartinAdapter = {
    adapterId: `policy:no-launch:${selectedEngine ?? "unresolved"}`,
    kind: "agent-cli",
    label: "Policy no-launch adapter",
    metadata: {
      providerId: selectedEngine ?? "policy",
      capabilities: { workspaceMutations: true }
    },
    async execute() {
      throw new Error("Policy no-launch adapter must never execute.");
    }
  };
  const adapter =
    !executionMode.liveMode
      ? createVerifierOnlyAdapter({
          workingDirectory,
          label: "Verification-only adapter (MARTIN_LIVE=false)",
          ...(input.verifyTimeoutMs !== undefined ? { verifyTimeoutMs: input.verifyTimeoutMs } : {}),
          ...(proofModeVerifierSpawnImpl ? { spawnImpl: proofModeVerifierSpawnImpl } : {})
        })
      : providerPreparationSkipped
        ? noLaunchAdapter
        : createLiveEngineAdapter({
          engine: selectedEngine!,
          workingDirectory,
          ...(model ? { model } : {}),
          ...(input.pricePerMTokenUsd !== undefined ? { pricePerMTokenUsd: input.pricePerMTokenUsd } : {}),
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
  const fallbackAdapters = executionMode.liveMode && !providerPreparationSkipped
    ? fallbackEngines.map((fallbackEngine) =>
        createLiveEngineAdapter({
          engine: fallbackEngine,
          workingDirectory,
          ...(input.pricePerMTokenUsd !== undefined ? { pricePerMTokenUsd: input.pricePerMTokenUsd } : {}),
          ...(input.verifyTimeoutMs !== undefined ? { verifyTimeoutMs: input.verifyTimeoutMs } : {}),
          ...(input.providerExecutionTimeoutMs !== undefined
            ? { providerExecutionTimeoutMs: input.providerExecutionTimeoutMs }
            : {}),
          ...(fallbackProbeOverrides.get(fallbackEngine)
            ? { codexProbe: fallbackProbeOverrides.get(fallbackEngine) }
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
    // The in-memory store override is a verification-only composition with no
    // durable run directory to serialize. Production always couples the file
    // store and file control source over the same runs root.
    runControlSource: runStoreOverrideForTests
      ? undefined
      : createFileRunControlSource(runsRoot),
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
      ...(effectiveAllowedPaths ? { allowedPaths: effectiveAllowedPaths } : {}),
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
    ...(context.signal ? { signal: context.signal } : {}),
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
    shouldStop: result.decision.shouldExit || costState.shouldStop,
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
