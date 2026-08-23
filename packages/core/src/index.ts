import { spawnSync } from "node:child_process";

import {
  type ApprovalPolicy,
  DEFAULT_AGENT_EXECUTION_INTENT,
  DEFAULT_PROVIDER_EXECUTION_TIMEOUT_MS,
  normalizeProviderExecutionTimeoutMs,
  type AgentExecutionIntent,
  appendLoopEvent,
  createLoopRecord,
  type ContextHandoffReceipt,
  type CostProvenance,
  type ExecutionProfile,
  type FailureClass,
  type InterventionType,
  type LoopArtifact,
  type LoopAttempt,
  type LoopBudget,
  type ProviderUsageSettlement,
  type MutationMode,
  type LoopRecord,
  type LoopTask,
  type PatchDecisionArtifact,
  type PatchScore,
  type ReceiptScope,
  type RollbackBoundaryArtifact,
  type RollbackOutcomeArtifact,
  type PolicyPhase
} from "@martin/contracts";
import {
  classifyFailure,
  computeEvidenceVector,
  evaluatePatchDecision,
  evaluateCostGovernor,
  evaluateBudgetPreflight,
  inferExit,
  nextPolicyPhase,
  policyPhaseToLifecycleState,
  scorePatchDecision,
  selectRecoveryRecipe,
  type BudgetPreflightDecision,
  type BudgetPreflightInput,
  type CostGovernorState,
  type EvidenceVectorInput,
  type EvaluatedPatchDecision,
  type ExitDecision,
  type FailureAssessment,
  type PatchDecisionInput,
  type RecoveryDecision,
  type RecoveryRecipe
} from "./policy.js";
import {
  evaluateChangeApprovalLeash,
  evaluateFilesystemLeash,
  evaluateSecretLeash,
  redactSecretsFromText,
  resolveExecutionProfile,
  evaluateVerificationLeash,
  type SafetyViolation
} from "./leash.js";
import {
  buildRepoGroundingIndex,
  loadOrBuildRepoGroundingIndex,
  queryRepoGroundingIndex,
  scanPatchForGroundingViolations,
  type GroundingScanResult,
  type GroundingViolation,
  type GroundingViolationKind,
  type RepoGroundingHit,
  type RepoGroundingIndex
} from "./grounding.js";
import {
  captureRollbackBoundary,
  listAttemptChangedFilesSinceBoundary,
  restoreRollbackBoundary
} from "./rollback.js";
import { compilePromptPacket } from "./compiler.js";
import { makeLedgerEvent, resolveRunsRoot, runDir, type RunStore } from "./persistence/index.js";
import {
  createDefaultExitPolicy,
  evaluateExitPolicy,
  hashProgressState,
  toLegacyExitDecision,
  type ExitPolicyOverrides
} from "./exits.js";
import {
  createFileExitSignalSource,
  startExitSignalMonitor,
  type ExitSignalSource
} from "./exit-signal.js";
import { persistTerminationEnvelope } from "./termination-store.js";
import { calculateLoopAvoidedUsd } from "./savings.js";
import {
  runContextIntegrityPrecheck,
  type ContextIntegrityPrecheck,
  type ContextIntegrityVerdict
} from "./context-integrity.js";
import { decideCircuitBreak } from "./trajectory.js";
import { verifyContextHandoff, decideContextCircuitBreak } from "./context-handoff.js";
import {
  verifierActuallyPassed,
  type VerifierExecutionBinding,
} from "./verified-handoff.js";

// ─── Public API re-exports ───────────────────────────────────────────────────
export type {
  AgentExecutionIntent,
  ApprovalPolicy,
  BudgetPreflightEstimate,
  BudgetSettlement,
  CostProvenance,
  EvidenceVector,
  ExecutionProfile,
  FailureClass,
  InterventionType,
  PatchDecision,
  PatchDecisionArtifact,
  PatchDecisionReasonCode,
  PatchScore,
  MutationMode,
  RollbackBoundaryArtifact,
  RollbackBoundaryStrategy,
  RollbackFileSnapshot,
  RollbackOutcomeArtifact,
  RollbackOutcomeStatus,
  PolicyPhase,
  CallStage,
  AgentRole,
  FirstDelta,
  RoutingEconomics
} from "@martin/contracts";
export { DEFAULT_AGENT_EXECUTION_INTENT, DEFAULT_PROVIDER_EXECUTION_TIMEOUT_MS, GOVERNED_AUTONOMOUS_BOUNDARY, normalizeProviderExecutionTimeoutMs } from "@martin/contracts";
export {
  classifyFailure,
  computeEvidenceVector,
  evaluatePatchDecision,
  evaluateCostGovernor,
  evaluateBudgetPreflight,
  inferExit,
  nextPolicyPhase,
  policyPhaseToLifecycleState,
  scorePatchDecision,
  selectRecoveryRecipe,
  evaluateVerificationLeash,
  evaluateFilesystemLeash,
  evaluateChangeApprovalLeash,
  evaluateSecretLeash,
  resolveExecutionProfile,
  redactSecretsFromText,
  buildRepoGroundingIndex,
  loadOrBuildRepoGroundingIndex,
  queryRepoGroundingIndex,
  scanPatchForGroundingViolations,
  captureRollbackBoundary,
  listAttemptChangedFilesSinceBoundary,
  restoreRollbackBoundary
};
export type {
  BudgetPreflightDecision,
  BudgetPreflightInput,
  CostGovernorState,
  EvidenceVectorInput,
  EvaluatedPatchDecision,
  ExitDecision,
  FailureAssessment,
  PatchDecisionInput,
  RecoveryDecision,
  RecoveryRecipe
} from "./policy.js";
export type { ResolvedExecutionProfile, SafetyLeashDecision, SafetyViolation } from "./leash.js";
export type {
  GroundingScanResult,
  GroundingViolation,
  GroundingViolationKind,
  RepoGroundingHit,
  RepoGroundingIndex
} from "./grounding.js";
export { buildContextGraphSnapshot, queryContextGraph } from "./context-graph.js";
export {
  createLocalIdentityAuthority,
  hasIdentityScope,
  issueIdentityToken,
  verifyIdentityToken
} from "./identity.js";
export type { LocalIdentityAuthority } from "./identity.js";
export { compileExecutionPolicy } from "./policy-compiler.js";
export { assessTrajectory, decideCircuitBreak } from "./trajectory.js";
export { calculateAvoidedUsd, calculateLoopAvoidedUsd } from "./savings.js";
export type { AvoidedUsdInput } from "./savings.js";

// ─── Routing economics ─────────────────────────────────────────────────────
export { classifyRoute, evaluatePreworkBurnPolicy } from "./routing.js";
export type { RouteDecision, RouteClassificationInput } from "./routing.js";

// ─── Test Integrity Validation ──────────────────────────────────────────────
export {
  validateTestIntegrity,
  snapshotTestFiles,
  identifyNewTests,
  findTestFiles,
  isTestFile,
  extractImports,
  hasTrivialAssertionsOnly,
  importsPreExistingCode
} from "./test-integrity.js";
export type { TestIntegrityReport, TestIntegrityFinding } from "./test-integrity.js";

// ─── Repo Style Analyzer ────────────────────────────────────────────────────
export { analyzeRepoStyle, buildPromptDirectives } from "./repo-analyzer.js";
export type { RepoStyleProfile } from "./repo-analyzer.js";

// ─── Context Integrity Pre-gate ──────────────────────────────────────────────
export { runContextIntegrityPrecheck } from "./context-integrity.js";
export type { ContextIntegrityPrecheck, ContextIntegrityVerdict } from "./context-integrity.js";

// ─── Prompt packet compiler ──────────────────────────────────────────────────
export { compilePromptPacket } from "./compiler.js";
export type { PromptPacket, CompilerAdapterRequest } from "./compiler.js";

// ─── Verified Handoff builder ────────────────────────────────────────────────
export {
  buildVerifiedHandoff,
  deriveVerifiedHandoffExecutionBoundary,
  resolveVerifiedHandoffOutcome,
  toTestIntegrityVerdict,
  verifierActuallyPassed,
} from "./verified-handoff.js";
export type {
  BoundVerifierEvidence,
  BuildVerifiedHandoffInput,
  VerifierExecutionBinding,
} from "./verified-handoff.js";

// ─── Persistence (RunStore, LedgerEvent, FileRunStore) ──────────────────────
export {
  createFileRunStore,
  makeLedgerEvent,
  readAllLoopRecords,
  readLatestLoopRecord,
  readLatestLoopRecordFromFile,
  readLoopRecordsFromFile,
  resolveRunsRoot,
  resolveReceiptIntegrityPath,
  verifyReceiptIntegrityFromFiles,
  writeReceiptIntegrityMaterial
} from "./persistence/index.js";
export type {
  AttemptArtifacts,
  LedgerEvent,
  LedgerEventKind,
  LoopAttemptRecord,
  LoopRunRecord,
  ReceiptIntegrityChainEntry,
  RunContract,
  RunStore,
  StoredReceiptIntegrityMaterial
} from "./persistence/index.js";
export { compileAndPersistContext } from "./persistence/index.js";
export type { CompileResult } from "./persistence/index.js";

// ─── Context Shadow — A-CTX-0 ────────────────────────────────────────────────
export { compileContextShadow, estimateContextTokens } from "./context-shadow.js";
export type {
  CompileContextShadowInput,
  CompileContextShadowResult,
  ContextShadowSegment
} from "./context-shadow.js";

// ─── Context Compiler — A-CTX-1 ──────────────────────────────────────────────
export { compileContext, HEURISTIC_ADAPTER, MAX_RENDER_PASSES } from "./context-compiler.js";
export type {
  CompileContextInput,
  CompileContextOutput,
  ContextAdapter
} from "./context-compiler.js";

// ─── Context Handoff — A-CTX-2 ───────────────────────────────────────────────
export { verifyContextHandoff, decideContextCircuitBreak } from "./context-handoff.js";
export type { VerifyContextHandoffInput } from "./context-handoff.js";

// ─── Context Chain Gate — C1 ─────────────────────────────────────────────────
export { evaluateChainGate, renderGatePrComment } from "./context-chain-gate.js";
export type {
  ChainGateConfig,
  ChainGateCost,
  ChainGateConclusion,
  ChainGateInput,
  ChainGateResult,
  GatePrCommentOptions
} from "./context-chain-gate.js";

// ─── MartinLoop Memory Store ────────────────────────────────────────────────
export {
  appendMemory,
  readMemoryEntries,
  getPreference,
  buildMemorySummary,
  recordPreference,
  recordConsent
} from "./persistence/memory-store.js";
export type { MemoryEntry, MemoryKind, MemorySummary } from "./persistence/memory-store.js";

// ─── Trace Intelligence Store ───────────────────────────────────────────────
export {
  appendTraceEntry,
  readTraceEntries,
  aggregateTraces,
  getHistoricalDirectSuccessRate
} from "./persistence/trace-store.js";
export type { TraceEntry, TraceAggregation } from "./persistence/trace-store.js";

// ─── Adapter interfaces ──────────────────────────────────────────────────────

export interface MartinAdapterRequest {
  loopId: string;
  workspaceId: string;
  attemptId: string;
  context: {
    taskTitle: string;
    objective: string;
    verificationPlan: string[];
    verificationStack?: LoopTask["verificationStack"];
    mutationMode?: MutationMode;
    definitionOfDonePreSatisfied?: boolean;
    /** Absolute path to the repository root. */
    repoRoot?: string;
    /** Glob patterns for files the agent may modify. Empty = no restriction. */
    allowedPaths?: string[];
    /** Glob patterns for files the agent must never modify. */
    deniedPaths?: string[];
    /** Human-readable acceptance criteria injected into the prompt. */
    acceptanceCriteria?: string[];
    executionProfile?: ExecutionProfile;
    allowedNetworkDomains?: string[];
    approvalPolicy?: ApprovalPolicy;
    agentExecutionIntent?: AgentExecutionIntent;
    providerExecutionTimeoutMs?: number;
    focus: string;
    remainingBudgetUsd: number;
    remainingIterations: number;
    remainingTokens: number;
  };
  previousAttempts: LoopAttempt[];
  /** Abort signal propagated from the harness — adapters should honour it. */
  signal?: AbortSignal;
}

export interface MartinVerificationStep {
  command: string;
  launched: boolean;
  completed?: boolean;
  crashed?: boolean;
  exitCode?: number;
  timedOut: boolean;
  fastFail?: boolean;
  detail?: string;
}

export interface MartinVerificationOutcome {
  passed: boolean;
  summary: string;
  steps?: MartinVerificationStep[];
  warnings?: string[];
  binding?: VerifierExecutionBinding;
}

export interface MartinAdapterResult {
  status: "completed" | "failed";
  summary: string;
  usage: {
    actualUsd: number;
    estimatedUsd?: number;
    tokensIn: number;
    tokensOut: number;
    cachedInputTokens?: number;
    reasoningTokensOut?: number;
    provenance?: CostProvenance;
    providerSettlement?: ProviderUsageSettlement;
  };
  verification: {
    passed: boolean;
    summary: string;
    steps?: MartinVerificationStep[];
    warnings?: string[];
    binding?: VerifierExecutionBinding;
  };
  execution?: {
    changedFiles?: string[];
    diffStats?: {
      filesChanged: number;
      addedLines: number;
      deletedLines: number;
    };
    structuredErrors?: Array<{
      file: string;
      line?: number;
      col?: number;
      code?: string;
      message: string;
    }>;
  };
  artifacts?: LoopArtifact[];
  failure?: {
    message: string;
    classHint?: FailureClass;
  };
}

export interface MartinAdapter {
  adapterId: string;
  kind: "direct-provider" | "agent-cli";
  label: string;
  metadata: {
    providerId: string;
    model?: string;
    transport?: "cli" | "http" | "routed_http";
    capabilities?: {
      preflight?: boolean;
      usageSettlement?: boolean;
      diffArtifacts?: boolean;
      structuredErrors?: boolean;
      cachingSignals?: boolean;
      workspaceMutations?: boolean;
    };
    [key: string]: unknown;
  };
  execute(request: MartinAdapterRequest): Promise<MartinAdapterResult>;
}

export interface DistilledContext {
  focus: string;
  recentAttempts: LoopAttempt[];
  constraints: {
    remainingBudgetUsd: number;
    remainingIterations: number;
    remainingTokens: number;
  };
}

// ─── Admission control ───────────────────────────────────────────────────────

export interface AttemptPolicyDecision {
  allowed: boolean;
  reason: string;
  recommendedIntervention?: InterventionType;
  trajectoryAssessment?: import("@martin/contracts").TrajectoryAssessment;
  circuitBreakDecision?: import("@martin/contracts").CircuitBreakDecision;
}

/**
 * Admission gate — must pass before any attempt is executed.
 * Evaluates budget headroom, oscillation, and repetitive failure patterns.
 * PolicyPhase remains explicit: attempts are only admitted in ADMIT phase.
 */
export function evaluateAttemptPolicy(input: {
  request: MartinAdapterRequest;
  projectedUsd: number;
}): AttemptPolicyDecision {
  const { request, projectedUsd } = input;
  const trajectoryAttempts = request.previousAttempts.map((attempt) => ({
    index: attempt.index,
    summary: attempt.summary,
    failureClass: attempt.failureClass
  }));
  const circuitBreakDecision = decideCircuitBreak({
    objective: request.context.objective,
    verificationPlan: request.context.verificationPlan,
    attempts: trajectoryAttempts,
    remainingIterations: request.context.remainingIterations
  });
  const trajectoryAssessment = circuitBreakDecision.assessment;

  if (circuitBreakDecision.shouldStop) {
    return {
      allowed: false,
      reason: circuitBreakDecision.reason,
      recommendedIntervention: circuitBreakDecision.recommendedIntervention,
      trajectoryAssessment,
      circuitBreakDecision
    };
  }

  // Budget gate: reject if projected cost exceeds remaining
  if (projectedUsd > request.context.remainingBudgetUsd) {
    return {
      allowed: false,
      reason: `Projected cost $${projectedUsd} exceeds remaining budget $${request.context.remainingBudgetUsd}.`,
      recommendedIntervention: "stop_loop",
      trajectoryAssessment,
      circuitBreakDecision
    };
  }

  // Iteration gate
  if (request.context.remainingIterations <= 0) {
    return {
      allowed: false,
      reason: "No remaining iterations in the budget.",
      recommendedIntervention: "stop_loop",
      trajectoryAssessment,
      circuitBreakDecision
    };
  }

  // Oscillation detection: A/B/A pattern in failure classes
  const failures = request.previousAttempts
    .map((a) => a.failureClass)
    .filter((fc): fc is FailureClass => Boolean(fc));

  if (failures.length >= 3) {
    const last3 = failures.slice(-3);
    const isOscillating = last3[0] !== last3[1] && last3[0] === last3[2];
    if (isOscillating) {
      return {
        allowed: false,
        reason: "Oscillating failure pattern detected. Escalating to human.",
        recommendedIntervention: "escalate_human",
        trajectoryAssessment,
        circuitBreakDecision
      };
    }
  }

  // Materially repetitive detection: same summary content pattern 3x
  if (request.previousAttempts.length >= 3) {
    const lastThree = request.previousAttempts.slice(-3);
    const summaries = lastThree
      .map((a) => a.summary?.toLowerCase() ?? "")
      .filter((s) => s.length > 10);

    if (summaries.length === 3) {
      // Compute rough similarity: shared significant tokens
      const tokenize = (s: string) =>
        new Set(s.match(/[a-z]{4,}/g) ?? []);
      const tokens0 = tokenize(summaries[0] ?? "");
      const tokens2 = tokenize(summaries[2] ?? "");
      const shared = [...tokens0].filter((t) => tokens2.has(t));
      const similarity = shared.length / Math.max(tokens0.size, 1);

      if (similarity > 0.5) {
        return {
          allowed: false,
          reason: "Materially repetitive attempts detected. Escalating to human.",
          recommendedIntervention: "escalate_human",
          trajectoryAssessment,
          circuitBreakDecision
        };
      }
    }
  }

  return {
    allowed: true,
    reason: "Attempt admitted.",
    trajectoryAssessment,
    circuitBreakDecision
  };
}

// ─── Runtime orchestration ───────────────────────────────────────────────────

export interface RunMartinInput {
  workspaceId: string;
  projectId: string;
  teamId?: string;
  task: LoopTask;
  budget: LoopBudget;
  metadata?: Record<string, string>;
  adapter: MartinAdapter;
  now?: () => string;
  idFactory?: (prefix: string) => string;
  maxRecentAttempts?: number;
  fallbackAdapters?: MartinAdapter[];
  receiptScope?: ReceiptScope;
  /** Optional persistence store. When provided, runMartin writes artifacts on each lifecycle event. */
  store?: RunStore;
  /** Overrides for the default eight-exit policy derived from budget. */
  exitPolicy?: ExitPolicyOverrides;
  /** Source for durable cancellation/external-event signals. */
  exitSignalSource?: ExitSignalSource;
  /** Poll interval for the signal monitor in ms (default 250). */
  exitSignalPollIntervalMs?: number;
  /** Clock override for testing (default Date.now). */
  nowMs?: () => number;
  // ── A-CTX-2 context handoff gate ─────────────────────────────────────────
  /** When provided, runMartin verifies the handoff before invoking the adapter. */
  contextHandoff?: ContextHandoffReceipt;
  /** true when the producer receipt file hash has been independently confirmed. */
  producerReceiptVerified?: boolean;
  /** Map of sha256 → true for every artifact available to the verifier. */
  availableArtifacts?: ReadonlyMap<string, true>;
}

export interface RunMartinResult {
  loop: LoopRecord;
  decision: ExitDecision;
}

export function distillContext(
  loop: Pick<LoopRecord, "task" | "budget" | "cost" | "attempts">,
  options: { maxRecentAttempts?: number } = {}
): DistilledContext {
  const maxRecentAttempts = options.maxRecentAttempts ?? 3;
  const recentAttempts = loop.attempts.slice(-maxRecentAttempts);

  return {
    focus: `${loop.task.objective} Follow the verification plan and stay inside the configured budget.`,
    recentAttempts,
    constraints: {
      remainingBudgetUsd: roundUsd(loop.budget.maxUsd - loop.cost.actualUsd),
      remainingIterations: Math.max(loop.budget.maxIterations - loop.attempts.length, 0),
      remainingTokens: Math.max(
        loop.budget.maxTokens - loop.cost.tokensIn - loop.cost.tokensOut,
        0
      )
    }
  };
}

export async function runMartin(input: RunMartinInput): Promise<RunMartinResult> {
  const now = input.now ?? (() => new Date().toISOString());
  const idFactory = input.idFactory;

  const providerExecutionTimeoutMs = normalizeProviderExecutionTimeoutMs(
    input.task.providerExecutionTimeoutMs
  );
  const agentExecutionIntent = input.task.agentExecutionIntent ?? DEFAULT_AGENT_EXECUTION_INTENT;
  let loop = createLoopRecord(
    {
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      task: { ...input.task, agentExecutionIntent, providerExecutionTimeoutMs },
      budget: input.budget,
      ...(input.receiptScope
        ? { receiptScope: { ...input.receiptScope, agentExecutionIntent, providerExecutionTimeoutMs } }
        : {}),
      ...(input.teamId ? { teamId: input.teamId } : {}),
      ...(input.metadata ? { metadata: input.metadata } : {})
    },
    { now: now(), idFactory }
  );

  loop = appendLoopEvent(
    loop,
    {
      type: "run.started",
      lifecycleState: "running",
      payload: {
        adapterId: input.adapter.adapterId,
        providerId: input.adapter.metadata.providerId,
        model: input.adapter.metadata.model,
        transport: getAdapterTransport(input.adapter)
      }
    },
    { now: now(), idFactory }
  );

  if (input.store) {
    await input.store.initRun({
      runId: loop.loopId,
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      task: input.task,
      budget: input.budget,
      createdAt: loop.createdAt,
      ...(input.metadata ? { metadata: input.metadata } : {})
    });
    await input.store.appendLedger(
      loop.loopId,
      makeLedgerEvent({
        kind: "contract.created",
        runId: loop.loopId,
        payload: { workspaceId: input.workspaceId, projectId: input.projectId }
      })
    );
    await persistLoopRecordIfSupported(input.store, loop);
  }

  // ── A-CTX-2 context handoff gate ─────────────────────────────────────────
  // The gate runs before ANY adapter call. A blocked handoff hard-stops the run
  // and emits ledger evidence — the adapter is never invoked.
  if (input.contextHandoff !== undefined) {
    const handoffVerification = verifyContextHandoff({
      handoff: input.contextHandoff,
      producerReceiptVerified: input.producerReceiptVerified ?? false,
      availableArtifacts: input.availableArtifacts ?? new Map()
    });

    if (input.store) {
      await input.store.appendLedger(
        loop.loopId,
        makeLedgerEvent({
          kind: "context.handoff.received",
          runId: loop.loopId,
          payload: {
            handoffId: input.contextHandoff.handoffId,
            chainId: input.contextHandoff.chainId,
            producerRunId: input.contextHandoff.producerRunId,
            upstreamIntegrity: input.contextHandoff.upstreamIntegrity
          }
        })
      );
    }

    const handoffGate = decideContextCircuitBreak(handoffVerification);

    if (handoffGate.shouldStop) {
      if (input.store) {
        await input.store.appendLedger(
          loop.loopId,
          makeLedgerEvent({
            kind: "context.handoff.blocked",
            runId: loop.loopId,
            payload: {
              reasonCode: handoffGate.reasonCode,
              message: handoffGate.message,
              integrity: handoffVerification.integrity,
              reasons: handoffVerification.reasons
            }
          })
        );
        await input.store.appendLedger(
          loop.loopId,
          makeLedgerEvent({
            kind: "run.exited",
            runId: loop.loopId,
            payload: {
              status: "exited",
              lifecycleState: "human_escalation",
              reason: handoffGate.message ?? "Context handoff verification failed.",
              reasonCode: handoffGate.reasonCode ?? "handoff_verification_failed"
            }
          })
        );
      }
      const handoffExitDecision: ExitDecision = {
        shouldExit: true,
        lifecycleState: "human_escalation",
        status: "exited",
        reason: handoffGate.message ?? "Context handoff verification failed.",
        reasonCode: handoffGate.reasonCode ?? "handoff_verification_failed"
      };
      const finalizedLoop = finalizeLoop(loop, handoffExitDecision, now(), idFactory);
      await persistLoopRecordIfSupported(input.store, finalizedLoop);
      return { loop: finalizedLoop, decision: handoffExitDecision };
    }

    if (input.store) {
      await input.store.appendLedger(
        loop.loopId,
        makeLedgerEvent({
          kind: "context.handoff.verified",
          runId: loop.loopId,
          payload: {
            handoffId: input.contextHandoff.handoffId,
            chainId: input.contextHandoff.chainId,
            producerRunId: input.contextHandoff.producerRunId,
            integrity: handoffVerification.integrity
          }
        })
      );
    }
  }

  const adapterChain = [input.adapter, ...(input.fallbackAdapters ?? [])];
  let currentAdapterIndex = 0;
  let currentAdapter = adapterChain[currentAdapterIndex] ?? input.adapter;
  let useCompressedContext = false;
  const executionProfile = resolveExecutionProfile({
    executionProfile: input.task.executionProfile,
    allowedNetworkDomains: input.task.allowedNetworkDomains
  });

  // Safety leash: block destructive verifier commands before any attempt
  const leashDecision = evaluateVerificationLeash({
    verificationPlan: input.task.verificationPlan,
    verificationStack: input.task.verificationStack,
    executionProfile: input.task.executionProfile,
    allowedNetworkDomains: input.task.allowedNetworkDomains
  });

  if (!leashDecision.allowed) {
    const reason = `${leashDecision.reason ?? "Safety leash blocked verifier commands."} Blocked: ${leashDecision.blockedCommands.join(", ")}`;
    const leashExitDecision: ExitDecision = {
      shouldExit: true,
      lifecycleState: "human_escalation",
      status: "exited",
      reason,
      ...classifySafetyLeashExit(leashDecision, "verifier")
    };
    if (input.store) {
      await input.store.appendLedger(
        loop.loopId,
        makeLedgerEvent({
          kind: "safety.violations_found",
          runId: loop.loopId,
          payload: {
            surface: leashDecision.surface,
            blocked: true,
            profile: leashDecision.profile ?? executionProfile.name,
            violations: serializeSafetyViolations(leashDecision)
          }
        })
      );
      await input.store.appendLedger(
        loop.loopId,
        makeLedgerEvent({
          kind: "run.exited",
          runId: loop.loopId,
          payload: createRunExitPayload(leashExitDecision)
        })
      );
    }
    const finalizedLoop = finalizeLoop(loop, leashExitDecision, now(), idFactory);
    await persistLoopRecordIfSupported(input.store, finalizedLoop);
    return {
      loop: finalizedLoop,
      decision: leashExitDecision
    };
  }

  const secretDecision = evaluateSecretLeash({
    values: [
      input.task.title,
      input.task.objective,
      ...(input.task.acceptanceCriteria ?? [])
    ]
  });

  if (!secretDecision.allowed) {
    const secretExitDecision: ExitDecision = {
      shouldExit: true,
      lifecycleState: "human_escalation",
      status: "exited",
      reason: secretDecision.reason ?? "Safety leash blocked secret-like values in the runtime context.",
      ...classifySafetyLeashExit(secretDecision, "secret")
    };

    if (input.store) {
      await input.store.appendLedger(
        loop.loopId,
        makeLedgerEvent({
          kind: "safety.violations_found",
          runId: loop.loopId,
          payload: {
            surface: "secret",
            blocked: true,
            violations: secretDecision.violations.map((violation) => violation.match ?? violation.message)
          }
        })
      );
      await input.store.appendLedger(
        loop.loopId,
        makeLedgerEvent({
          kind: "run.exited",
          runId: loop.loopId,
          payload: createRunExitPayload(secretExitDecision)
        })
      );
    }

    const finalizedLoop = finalizeLoop(loop, secretExitDecision, now(), idFactory);
    await persistLoopRecordIfSupported(input.store, finalizedLoop);
    return {
      loop: finalizedLoop,
      decision: secretExitDecision
    };
  }

  // Explicit PolicyPhase state machine — starts at GATHER, advances per attempt
  let currentPhase: PolicyPhase = "GATHER";
  let phaseRetryCount = 0;

  // Routing economics: track first meaningful workspace delta
  const runStartMs = Date.now();
  let firstDeltaDetected = false;
  let firstDeltaTimestampMs: number | undefined;
  let firstDeltaFilePath: string | undefined;
  let firstDeltaChangeType: "create" | "modify" | "delete" | "patch_proposed" | undefined;
  let preDeltaCostUsd = 0;

  // ── Eight-exit runtime control state ─────────────────────────────────────
  const nowMs = input.nowMs ?? (() => Date.now());
  const exitPolicy = createDefaultExitPolicy(input.budget, input.exitPolicy);

  let activeAttemptController: AbortController | undefined;
  let observedHumanInterrupt: import("@martin/contracts").ExitSignalV1 | undefined;
  let observedExternalEvent: import("@martin/contracts").ExternalExitEvent | undefined;
  let terminationPromise: Promise<import("@martin/contracts").TerminationEnvelopeV1> | undefined;
  const recentStateHashes: string[] = [];
  let consecutiveErrors = 0;
  // governedTurnsUsed starts from the already-completed attempt count so
  // resumed runs count correctly; incremented once per governed attempt.
  let governedTurnsUsed = loop.attempts.length;

  const runsRoot = input.store?.runsRoot ?? resolveRunsRoot();
  const exitSignalSource = input.exitSignalSource ?? createFileExitSignalSource(runsRoot);

  // Diagnostic writes fire from sync callbacks — track them so the finally
  // block can await completion before the run tears down.
  const pendingControlWrites: Promise<void>[] = [];

  // Non-null when the signal monitor itself fails — rethrown at the next
  // evaluateCheckpoint so the run surfaces the error rather than silently
  // losing cancellation.
  let signalMonitorError: Error | undefined;

  function observeSignals(signals: readonly import("@martin/contracts").ExitSignalV1[]): void {
    for (const s of signals) {
      if (s.kind === "human_interrupt") observedHumanInterrupt = s;
      else if (s.kind === "external_event" && s.externalEvent !== undefined)
        observedExternalEvent = s.externalEvent;
    }
  }

  function queueControlDiagnostic(code: string, details: unknown): void {
    if (!input.store) return;
    pendingControlWrites.push(
      input.store.appendLedger(
        loop.loopId,
        makeLedgerEvent({
          kind: "run.diagnostic",
          runId: loop.loopId,
          payload: { code, details }
        })
      )
    );
  }

  const runController = new AbortController();

  const wallTimer =
    exitPolicy.wallClock.maxElapsedMs > 0
      ? setTimeout(() => {
          activeAttemptController?.abort(new Error("MartinLoop wall-clock exit reached"));
        }, exitPolicy.wallClock.maxElapsedMs)
      : undefined;
  (wallTimer as NodeJS.Timeout | undefined)?.unref?.();

  const disposeSignalMonitor = startExitSignalMonitor({
    source: exitSignalSource,
    runId: loop.loopId,
    controller: runController,
    pollIntervalMs: input.exitSignalPollIntervalMs,
    onSignal: (signals) => {
      observeSignals(signals);
      activeAttemptController?.abort(signals);
    },
    onDiagnostic: (diagnostics) => {
      queueControlDiagnostic(
        "exit_signal_invalid",
        diagnostics.map(({ kind, error }) => ({ kind, error }))
      );
    },
    onError: (err) => {
      signalMonitorError = err instanceof Error ? err : new Error(String(err));
      activeAttemptController?.abort(err);
    }
  });

  // Snapshot of the current run state for eight-exit evaluation
  function currentExitSnapshot(
    phase: import("@martin/contracts").ExitEvaluationPhase,
    result?: { status: "completed" | "failed"; verificationPassed: boolean }
  ): import("@martin/contracts").ExitSnapshotV1 {
    return {
      phase,
      evaluatedAt: now(),
      runStartedAtMs: runStartMs,
      nowMs: nowMs(),
      turnsUsed: governedTurnsUsed,
      actualUsd: loop.cost.actualUsd,
      tokensUsed: loop.cost.tokensIn + loop.cost.tokensOut,
      recentStateHashes: [...recentStateHashes],
      consecutiveErrors,
      ...(result !== undefined
        ? {
            result: {
              status: result.status,
              verificationPassed: result.verificationPassed,
              verifierScore: result.verificationPassed ? 1 : 0
            }
          }
        : {}),
      ...(observedHumanInterrupt !== undefined ? { humanInterrupt: observedHumanInterrupt } : {}),
      ...(observedExternalEvent !== undefined ? { externalEvent: observedExternalEvent } : {})
    };
  }

  // Idempotent termination: only the first caller writes the envelope (A1 fix)
  function finishFromEvaluation(
    evaluation: import("@martin/contracts").ExitEvaluationV1
  ): Promise<import("@martin/contracts").TerminationEnvelopeV1> {
    if (terminationPromise !== undefined) return terminationPromise;
    const envelope: import("@martin/contracts").TerminationEnvelopeV1 = {
      schemaVersion: "termination/1",
      class: "operational_exit",
      exit: evaluation
    };
    terminationPromise = (async () => {
      if (input.store) {
        // persistTerminationEnvelope is atomic and returns the winning envelope
        // (may differ from ours if another path won the race — that's fine).
        await persistTerminationEnvelope(runDir(runsRoot, loop.loopId), envelope);
        await input.store.appendLedger(
          loop.loopId,
          makeLedgerEvent({
            kind: "run.terminated",
            runId: loop.loopId,
            payload: {
              selectedExit: evaluation.primary,
              matchedExits: evaluation.matched,
              policyVersion: evaluation.policyVersion,
              evaluationVersion: evaluation.schemaVersion,
              terminationPhase: evaluation.phase
            }
          })
        );
      }
      return envelope;
    })();
    return terminationPromise;
  }

  async function evaluateCheckpoint(
    phase: import("@martin/contracts").ExitEvaluationPhase,
    result?: { status: "completed" | "failed"; verificationPassed: boolean }
  ): Promise<import("@martin/contracts").TerminationEnvelopeV1 | undefined> {
    // Surface signal-monitor failures immediately rather than silently losing cancellation
    if (signalMonitorError !== undefined) throw signalMonitorError;
    const evaluation = evaluateExitPolicy(exitPolicy, currentExitSnapshot(phase, result));
    return evaluation.shouldExit ? finishFromEvaluation(evaluation) : undefined;
  }

  async function terminateRun(
    envelope: import("@martin/contracts").TerminationEnvelopeV1
  ): Promise<RunMartinResult> {
    if (envelope.class !== "operational_exit") {
      throw new Error("terminateRun: unexpected non-operational envelope");
    }
    const legacyDecision = toLegacyExitDecision(
      envelope.exit,
      observedExternalEvent?.disposition
    );
    const exitDecision: ExitDecision = {
      shouldExit: legacyDecision.shouldExit,
      lifecycleState: legacyDecision.lifecycleState,
      status: legacyDecision.status,
      reason: legacyDecision.reason,
      ...(legacyDecision.reasonCode ? { reasonCode: legacyDecision.reasonCode } : {}),
      ...(legacyDecision.failureClass
        ? { failureClass: legacyDecision.failureClass as ExitDecision["failureClass"] }
        : {})
    };
    if (input.store) {
      await input.store.appendLedger(
        loop.loopId,
        makeLedgerEvent({
          kind: "run.exited",
          runId: loop.loopId,
          payload: createRunExitPayload(exitDecision)
        })
      );
    }
    const routingInput = {
      runStartMs,
      firstDeltaDetected,
      firstDeltaTimestampMs,
      firstDeltaFilePath,
      firstDeltaChangeType,
      preDeltaCostUsd
    };
    // Drain all pending diagnostic ledger writes BEFORE signing the receipt.
    // persistLoopRecordIfSupported reads ledger.jsonl to compute the integrity hash;
    // any write that lands after that read produces a false ledger_hash_mismatch on verify.
    if (pendingControlWrites.length > 0) {
      await Promise.all(pendingControlWrites.splice(0));
    }
    const finalizedLoop = finalizeLoop(loop, exitDecision, now(), idFactory, routingInput);
    const finalizedWithEnvelope: LoopRecord = { ...finalizedLoop, terminationEnvelope: envelope };
    await persistLoopRecordIfSupported(input.store, finalizedWithEnvelope);
    return { loop: finalizedWithEnvelope, decision: exitDecision };
  }

  try {
    // Poll once synchronously before the first attempt so any signal written
    // before the run started is observed immediately (not after the first poll interval).
    const initial = await exitSignalSource.poll(loop.loopId);
    observeSignals(initial.signals);
    if (initial.diagnostics.length > 0) {
      queueControlDiagnostic("exit_signal_invalid", initial.diagnostics);
    }

    // Pre-run check — catches signals written before the first attempt starts
    const preRunTerminal = await evaluateCheckpoint("pre_run");
    if (preRunTerminal !== undefined) return await terminateRun(preRunTerminal);

  while (loop.attempts.length < loop.budget.maxIterations) {
    const distilled = distillContext(loop, {
      maxRecentAttempts: useCompressedContext ? 1 : (input.maxRecentAttempts ?? 3)
    });
    useCompressedContext = false;
    const attemptStartedAt = now();
    const attemptId = makeId("att", idFactory);
    const executingAdapter = currentAdapter;

    const budgetPreflight = evaluateBudgetPreflight({
      promptCharCount: distilled.focus.length + loop.task.objective.length * 3,
      attemptCount: loop.attempts.length,
      remainingBudgetUsd: distilled.constraints.remainingBudgetUsd,
      perAttemptCapUsd: loop.budget.maxUsd * 0.25
    });

    if (!budgetPreflight.allowed) {
      const preflightExitDecision: ExitDecision = {
        shouldExit: true,
        lifecycleState: "budget_exit",
        status: "exited",
        reason: budgetPreflight.reason
      };
      if (input.store) {
        await input.store.appendLedger(
          loop.loopId,
          makeLedgerEvent({
            kind: "attempt.rejected",
            runId: loop.loopId,
            attemptIndex: loop.attempts.length + 1,
            payload: { reason: budgetPreflight.reason, source: "budget_preflight" }
          })
        );
        await input.store.appendLedger(
          loop.loopId,
          makeLedgerEvent({
            kind: "run.exited",
            runId: loop.loopId,
            payload: createRunExitPayload(preflightExitDecision)
          })
        );
      }
      if (pendingControlWrites.length > 0) {
        await Promise.all(pendingControlWrites.splice(0));
      }
      const finalizedLoop = finalizeLoop(loop, preflightExitDecision, now(), idFactory);
      await persistLoopRecordIfSupported(input.store, finalizedLoop);
      return {
        loop: finalizedLoop,
        decision: preflightExitDecision
      };
    }

    // GATHER → ADMIT: run admission control before executing
    currentPhase = "ADMIT";

    // T05: Context Integrity Pre-gate — blocks authority inversion / injection before reasoning
    //
    // Untrusted "tool output" re-entering the loop is verifier command output from prior
    // attempts (e.g. test runners echoing attacker-controlled strings). Pull that text from
    // already-persisted verification.completed events so the gate scans what actually
    // re-enters subsequent prompts, matching the documented "tool output / test output" scope.
    const priorVerifierOutput = loop.events
      .filter((event): event is typeof event & { payload: { steps?: Array<{ detail?: string }> } } =>
        event.type === "verification.completed"
      )
      .flatMap((event) => event.payload?.steps ?? [])
      .map((step) => step.detail)
      .filter((detail): detail is string => Boolean(detail))
      .join("\n---\n");

    const contextPrecheck = await runContextIntegrityPrecheck(
      loop.loopId,
      loop.attempts.length + 1,
      runDir(resolveActiveRunsRoot(input.store), loop.loopId),
      {
        userPrompt: distilled.focus,
        toolOutput: priorVerifierOutput || undefined,
        history: loop.attempts.map(a => a.summary).join("\n")
      }
    );

    if (contextPrecheck.verdict === "context_poisoning_block") {
      currentPhase = "ABORT";
      const poisoningExitDecision: ExitDecision = {
        shouldExit: true,
        lifecycleState: "human_escalation",
        status: "exited",
        reason: "Context Integrity Pre-gate: context poisoning attempt detected.",
        failureClass: "safety_leash_blocked",
        safetySurface: "context_integrity",
        reasonCode: "context_poisoning_blocked"
      };
      if (input.store) {
        await input.store.appendLedger(
          loop.loopId,
          makeLedgerEvent({
            kind: "safety.violations_found",
            runId: loop.loopId,
            payload: {
              verdict: contextPrecheck.verdict,
              signals: contextPrecheck.detectedSignals,
              source: "context_integrity_pregate"
            }
          })
        );
      }
      if (pendingControlWrites.length > 0) {
        await Promise.all(pendingControlWrites.splice(0));
      }
      const finalizedLoop = finalizeLoop(loop, poisoningExitDecision, now(), idFactory);
      await persistLoopRecordIfSupported(input.store, finalizedLoop);
      return {
        loop: finalizedLoop,
        decision: poisoningExitDecision
      };
    }

    const admissionDecision = evaluateAttemptPolicy({
      request: {
        loopId: loop.loopId,
        workspaceId: loop.workspaceId,
        attemptId,
        context: {
          taskTitle: loop.task.title,
          objective: loop.task.objective,
          verificationPlan: loop.task.verificationPlan,
          ...(loop.task.verificationStack ? { verificationStack: loop.task.verificationStack } : {}),
          ...(loop.task.definitionOfDonePreSatisfied !== undefined
            ? { definitionOfDonePreSatisfied: loop.task.definitionOfDonePreSatisfied }
            : {}),
          ...(loop.task.repoRoot ? { repoRoot: loop.task.repoRoot } : {}),
          ...(loop.task.allowedPaths ? { allowedPaths: loop.task.allowedPaths } : {}),
          ...(loop.task.deniedPaths ? { deniedPaths: loop.task.deniedPaths } : {}),
          ...(loop.task.acceptanceCriteria ? { acceptanceCriteria: loop.task.acceptanceCriteria } : {}),
          ...(loop.task.executionProfile ? { executionProfile: loop.task.executionProfile } : {}),
          ...(loop.task.allowedNetworkDomains
            ? { allowedNetworkDomains: loop.task.allowedNetworkDomains }
            : {}),
          ...(loop.task.approvalPolicy ? { approvalPolicy: loop.task.approvalPolicy } : {}),
          agentExecutionIntent: loop.task.agentExecutionIntent ?? DEFAULT_AGENT_EXECUTION_INTENT,
          providerExecutionTimeoutMs: normalizeProviderExecutionTimeoutMs(loop.task.providerExecutionTimeoutMs),
          focus: distilled.focus,
          remainingBudgetUsd: distilled.constraints.remainingBudgetUsd,
          remainingIterations: distilled.constraints.remainingIterations,
          remainingTokens: distilled.constraints.remainingTokens
        },
        previousAttempts: loop.attempts
      },
      projectedUsd: budgetPreflight.estimate.estimatedAttemptCostUsd
    });

    if (!admissionDecision.allowed) {
      const exitReason = admissionDecision.reason;
      const exitDecision: ExitDecision = {
        shouldExit: true,
        lifecycleState:
          admissionDecision.recommendedIntervention === "escalate_human"
            ? "human_escalation"
            : "budget_exit",
        status: "exited",
        reason: exitReason
      };
      if (input.store) {
        await input.store.appendLedger(
          loop.loopId,
          makeLedgerEvent({
            kind: "attempt.rejected",
            runId: loop.loopId,
            attemptIndex: loop.attempts.length + 1,
            payload: { reason: admissionDecision.reason }
          })
        );
        await input.store.appendLedger(
          loop.loopId,
          makeLedgerEvent({
            kind: "run.exited",
            runId: loop.loopId,
            payload: createRunExitPayload(exitDecision)
          })
        );
      }
      if (pendingControlWrites.length > 0) {
        await Promise.all(pendingControlWrites.splice(0));
      }
      const finalizedLoop = finalizeLoop(loop, exitDecision, now(), idFactory);
      await persistLoopRecordIfSupported(input.store, finalizedLoop);
      return {
        loop: finalizedLoop,
        decision: exitDecision
      };
    }

    if (input.store) {
      await input.store.appendLedger(
        loop.loopId,
        makeLedgerEvent({
          kind: "attempt.admitted",
          runId: loop.loopId,
          attemptIndex: loop.attempts.length + 1,
          payload: {
            attemptId,
            adapterId: executingAdapter.adapterId,
            providerId: executingAdapter.metadata.providerId,
            model: executingAdapter.metadata.model,
            transport: getAdapterTransport(executingAdapter)
          }
        })
      );
    }

    // ADMIT → PATCH
    currentPhase = "PATCH";

    loop = appendLoopEvent(
      loop,
      {
        type: "attempt.started",
        lifecycleState: "running",
        payload: {
          attemptId,
          adapterId: executingAdapter.adapterId,
          model: executingAdapter.metadata.model,
          policyPhase: currentPhase
        }
      },
      { now: attemptStartedAt, idFactory }
    );

    const request: MartinAdapterRequest = {
      loopId: loop.loopId,
      workspaceId: loop.workspaceId,
      attemptId,
      context: {
        taskTitle: loop.task.title,
        objective: loop.task.objective,
        verificationPlan: loop.task.verificationPlan,
        ...(loop.task.verificationStack ? { verificationStack: loop.task.verificationStack } : {}),
        ...(loop.task.mutationMode ? { mutationMode: loop.task.mutationMode } : {}),
        ...(loop.task.definitionOfDonePreSatisfied !== undefined
          ? { definitionOfDonePreSatisfied: loop.task.definitionOfDonePreSatisfied }
          : {}),
        ...(loop.task.repoRoot ? { repoRoot: loop.task.repoRoot } : {}),
        ...(loop.task.allowedPaths ? { allowedPaths: loop.task.allowedPaths } : {}),
        ...(loop.task.deniedPaths ? { deniedPaths: loop.task.deniedPaths } : {}),
        ...(loop.task.acceptanceCriteria ? { acceptanceCriteria: loop.task.acceptanceCriteria } : {}),
        ...(loop.task.executionProfile ? { executionProfile: loop.task.executionProfile } : {}),
        ...(loop.task.allowedNetworkDomains
          ? { allowedNetworkDomains: loop.task.allowedNetworkDomains }
          : {}),
        ...(loop.task.approvalPolicy ? { approvalPolicy: loop.task.approvalPolicy } : {}),
        agentExecutionIntent: loop.task.agentExecutionIntent ?? DEFAULT_AGENT_EXECUTION_INTENT,
        providerExecutionTimeoutMs: normalizeProviderExecutionTimeoutMs(loop.task.providerExecutionTimeoutMs),
        focus: distilled.focus,
        remainingBudgetUsd: distilled.constraints.remainingBudgetUsd,
        remainingIterations: distilled.constraints.remainingIterations,
        remainingTokens: distilled.constraints.remainingTokens
      },
      previousAttempts: loop.attempts
    };

    const tracksWorkspaceMutations =
      request.context.repoRoot !== undefined &&
      executingAdapter.metadata.capabilities?.workspaceMutations !== false;

    // Pre-attempt: check signals that arrived during guard evaluation
    const preAttemptTerminal = await evaluateCheckpoint("pre_attempt");
    if (preAttemptTerminal !== undefined) return await terminateRun(preAttemptTerminal);

    activeAttemptController = new AbortController();
    governedTurnsUsed += 1;

    const rollbackBoundary = tracksWorkspaceMutations
      ? await captureRollbackBoundary({
          repoRoot: request.context.repoRoot,
          capturedAt: attemptStartedAt
        })
      : undefined;

    let result: MartinAdapterResult;
    try {
      result = await executingAdapter.execute({
        ...request,
        signal: activeAttemptController.signal
      });
    } catch (execError) {
      // Convert an abort (wall-clock or signal-driven) into the correct exit
      // rather than letting it propagate as an unhandled exception.
      const abortTerminal = await evaluateCheckpoint("post_attempt");
      if (abortTerminal !== undefined) return await terminateRun(abortTerminal);
      throw execError;
    } finally {
      activeAttemptController = undefined;
    }
    const attemptCompletedAt = now();
    const compiledContext = compilePromptPacket(request);
    const expectedVerifierBinding = resolveExpectedVerifierBinding(request);
    const verifierConfigured = expectedVerifierBinding.commands.length > 0;
    const verification = normalizeVerificationOutcome(result, expectedVerifierBinding);

    // PATCH → VERIFY
    currentPhase = "VERIFY";

    let failure =
      result.status === "failed"
        ? classifyFailure({ attempts: loop.attempts, result })
        : undefined;

    const currentAttemptIndex = loop.attempts.length + 1;
    const attempt: LoopAttempt = {
      attemptId,
      index: currentAttemptIndex,
      adapterId: executingAdapter.adapterId,
      ...(executingAdapter.metadata.model ? { model: executingAdapter.metadata.model } : {}),
      startedAt: attemptStartedAt,
      completedAt: attemptCompletedAt,
      summary: result.summary,
      ...(failure?.failureClass ? { failureClass: failure.failureClass } : {}),
      ...(failure?.recommendedIntervention
        ? { intervention: failure.recommendedIntervention }
        : {}),
      ...(failure?.diagnosticHint ? { diagnosticHint: failure.diagnosticHint } : {})
    };

    loop = {
      ...loop,
      attempts: [...loop.attempts, attempt],
      cost: {
        actualUsd: roundUsd(loop.cost.actualUsd + getUsageUsd(result.usage)),
        avoidedUsd: loop.cost.avoidedUsd,
        tokensIn: loop.cost.tokensIn + result.usage.tokensIn,
        tokensOut: loop.cost.tokensOut + result.usage.tokensOut,
        ...(result.usage.estimatedUsd !== undefined
          ? {
              estimatedUsd: roundUsd(
                (loop.cost.estimatedUsd ?? loop.cost.actualUsd) + result.usage.estimatedUsd
              )
            }
          : {}),
        provenance: mergeCostProvenance(loop.cost.provenance, getUsageProvenance(result.usage)),
        ...(result.usage.providerSettlement
          ? { providerSettlement: result.usage.providerSettlement }
          : {})
      },
      updatedAt: attemptCompletedAt
    };

    // ── Eight-exit state tracking ─────────────────────────────────────────
    consecutiveErrors = result.status === "failed" ? consecutiveErrors + 1 : 0;
    const stateHash = hashProgressState({
      summary: result.summary,
      verificationPassed: verification.passed,
      status: result.status
    });
    if (recentStateHashes.length >= exitPolicy.progress.windowSize) recentStateHashes.shift();
    recentStateHashes.push(stateHash);

    loop = appendLoopEvent(
      loop,
      {
        type: "attempt.completed",
        lifecycleState: "running",
        payload: { attemptId, status: result.status, summary: result.summary }
      },
      { now: attemptCompletedAt, idFactory }
    );

    // post_attempt check is deferred until after verification.completed and all
    // per-attempt ledger writes — see the check just before before_retry below.

    const previousVerifierScore = getLastVerifierScore(loop);

    if (failure) {
      if (failure.recommendedIntervention === "compress_context") {
        useCompressedContext = true;
      }

      let adapterSwitched = false;
      if (failure.recommendedIntervention === "switch_adapter") {
        const nextAdapter = adapterChain[currentAdapterIndex + 1];
        if (nextAdapter) {
          currentAdapterIndex += 1;
          currentAdapter = nextAdapter;
          adapterSwitched = true;
        }
      }

      loop = appendLoopEvent(
        loop,
        {
          type: "failure.classified",
          lifecycleState: "running",
          payload: {
            attemptId,
            failureClass: failure.failureClass,
            rationale: failure.rationale
          }
        },
        { now: attemptCompletedAt, idFactory }
      );

      loop = appendLoopEvent(
        loop,
        {
          type: "intervention.selected",
          lifecycleState: "running",
          payload: { attemptId, intervention: failure.recommendedIntervention }
        },
        { now: attemptCompletedAt, idFactory }
      );

      if (adapterSwitched) {
        loop = appendLoopEvent(
          loop,
          {
            type: "intervention.selected",
            lifecycleState: "running",
            payload: {
              attemptId,
              intervention: "switch_adapter",
              nextAdapterId: currentAdapter.adapterId,
              transport: getAdapterTransport(currentAdapter)
            }
          },
          { now: attemptCompletedAt, idFactory }
        );
      }
    }

    const costState = evaluateCostGovernor({
      budget: loop.budget,
      cost: loop.cost,
      attemptsUsed: loop.attempts.length
    });

    loop = appendLoopEvent(
      loop,
      {
        type: "budget.updated",
        lifecycleState: costState.shouldStop ? "budget_exit" : "running",
        payload: {
          actualUsd: loop.cost.actualUsd,
          remainingBudgetUsd: costState.remainingBudgetUsd,
          pressure: costState.pressure,
          provenance: loop.cost.provenance
        }
      },
      { now: now(), idFactory }
    );

    if (input.store) {
      const settlement = createBudgetSettlement({
        runId: loop.loopId,
        attemptIndex: currentAttemptIndex,
        usage: result.usage,
        estimate: budgetPreflight.estimate,
        settledAt: attemptCompletedAt
      });
      await input.store.writeAttemptArtifacts(loop.loopId, currentAttemptIndex, {
        compiledContext,
        verification,
        ...(rollbackBoundary ? { rollbackBoundary } : {})
      });
      await input.store.appendLedger(
        loop.loopId,
        makeLedgerEvent({
          kind: "patch.generated",
          runId: loop.loopId,
          attemptIndex: currentAttemptIndex,
          payload: { status: result.status, summary: result.summary }
        })
      );
      await input.store.appendLedger(
        loop.loopId,
        makeLedgerEvent({
          kind: "budget.settled",
          runId: loop.loopId,
          attemptIndex: currentAttemptIndex,
          payload: {
            actualUsd: settlement.totalActualUsd,
            estimatedUsd: result.usage.estimatedUsd,
            tokensIn: result.usage.tokensIn,
            tokensOut: result.usage.tokensOut,
            cachedInputTokens: result.usage.cachedInputTokens,
            reasoningTokensOut: result.usage.reasoningTokensOut,
            provenance: getUsageProvenance(result.usage),
            transport: getAdapterTransport(executingAdapter),
            providerId: executingAdapter.metadata.providerId,
            model: executingAdapter.metadata.model,
            providerSettlement: result.usage.providerSettlement,
            patchCost: settlement.patchCost,
            verificationCost: settlement.verificationCost,
            varianceUsd: settlement.varianceUsd,
            preflightEstimateUsd: settlement.preflightEstimateUsd
          }
        })
      );
    }

    const changedFiles = tracksWorkspaceMutations
      ? resolveChangedFiles(result, request.context.repoRoot, rollbackBoundary)
      : [];

    // Routing economics: detect first meaningful workspace delta
    if (!firstDeltaDetected && changedFiles.length > 0) {
      const meaningfulFile = changedFiles.find(
        (f) => !isMartinLoopMetadata(f)
      );
      if (meaningfulFile) {
        firstDeltaDetected = true;
        firstDeltaTimestampMs = Date.now();
        firstDeltaFilePath = meaningfulFile;
        firstDeltaChangeType = "modify";
        preDeltaCostUsd = roundUsd(loop.cost.actualUsd - getUsageUsd(result.usage));
      }
    }
    if (!firstDeltaDetected) {
      preDeltaCostUsd = loop.cost.actualUsd;
    }

    // Evidence is only reliable when the adapter explicitly reported files OR git actually
    // returned a non-empty list. A repoRoot alone is insufficient — git may fail (e.g. not
    // a git repo) and silently return [], which would falsely trigger no_code_change.
    const changedFileEvidenceAvailable =
      result.execution?.changedFiles !== undefined || changedFiles.length > 0;

    const filesystemDecision = evaluateFilesystemLeash({
      repoRoot: request.context.repoRoot,
      changedFiles,
      allowedPaths: request.context.allowedPaths,
      deniedPaths: request.context.deniedPaths
    });

    if (!filesystemDecision.allowed) {
      const patchDecision = evaluatePatchDecision({
        verificationPassed: result.verification.passed,
        previousVerifierScore,
        verifierScore: result.verification.passed ? 1 : 0,
        scopeViolationCount: filesystemDecision.violations.length,
        changedFileCount: changedFiles.length,
        diffNovelty: changedFiles.length > 0 ? 1 : 0,
        diffStats: result.execution?.diffStats,
        costUsd: getUsageUsd(result.usage),
        summary: result.summary
      });
      const filesystemExitDecision: ExitDecision = {
        shouldExit: true,
        lifecycleState: "human_escalation",
        status: "exited",
        reason: filesystemDecision.reason ?? "Safety leash blocked filesystem changes.",
        ...classifySafetyLeashExit(filesystemDecision, "filesystem")
      };
      const rollbackOutcome = await restoreRollbackBoundary({
        repoRoot: request.context.repoRoot,
        boundary: rollbackBoundary,
        restoredAt: attemptCompletedAt,
        decision: patchDecision.decision
      });

      if (input.store) {
        await input.store.writeAttemptArtifacts(loop.loopId, currentAttemptIndex, {
          compiledContext,
          leash: createLeashArtifact(filesystemDecision, currentAttemptIndex),
          patchScore: patchDecision.score,
          patchDecision: toPatchDecisionArtifact(patchDecision),
          ...(rollbackBoundary ? { rollbackBoundary } : {}),
          ...(rollbackOutcome ? { rollbackOutcome } : {})
        });
        await input.store.appendLedger(
          loop.loopId,
          makeLedgerEvent({
            kind: "safety.violations_found",
            runId: loop.loopId,
            attemptIndex: currentAttemptIndex,
            payload: {
              surface: "filesystem",
              blocked: true,
              attemptIndex: currentAttemptIndex,
              violations: filesystemDecision.violations
            }
          })
        );
        await input.store.appendLedger(
          loop.loopId,
          makeLedgerEvent({
            kind: "attempt.discarded",
            runId: loop.loopId,
            attemptIndex: currentAttemptIndex,
            payload: {
              decision: patchDecision.decision,
              reason: patchDecision.summary,
              reasonCodes: patchDecision.reasonCodes,
              score: patchDecision.score.score
            }
          })
        );
        await input.store.appendLedger(
          loop.loopId,
          makeLedgerEvent({
            kind: "run.exited",
            runId: loop.loopId,
            payload: createRunExitPayload(filesystemExitDecision)
          })
        );
      }

      if (pendingControlWrites.length > 0) {
        await Promise.all(pendingControlWrites.splice(0));
      }
      const finalizedLoop = finalizeLoop(loop, filesystemExitDecision, now(), idFactory);
      await persistLoopRecordIfSupported(input.store, finalizedLoop);
      return {
        loop: finalizedLoop,
        decision: filesystemExitDecision
      };
    }

    const changeApprovalDecision = evaluateChangeApprovalLeash({
      changedFiles,
      executionProfile: request.context.executionProfile,
      approvalPolicy: request.context.approvalPolicy
    });

    if (!changeApprovalDecision.allowed) {
      const patchDecision = evaluatePatchDecision({
        verificationPassed: result.verification.passed,
        previousVerifierScore,
        verifierScore: result.verification.passed ? 1 : 0,
        safetyViolationCount: changeApprovalDecision.violations.length,
        changedFileCount: changedFiles.length,
        diffNovelty: changedFiles.length > 0 ? 1 : 0,
        diffStats: result.execution?.diffStats,
        costUsd: getUsageUsd(result.usage),
        humanApprovalRequired: true,
        summary: result.summary
      });
      const approvalExitDecision: ExitDecision = {
        shouldExit: true,
        lifecycleState: "human_escalation",
        status: "exited",
        reason:
          changeApprovalDecision.reason ??
          "Safety leash blocked dependency or migration changes that require approval.",
        ...classifySafetyLeashExit(changeApprovalDecision, "dependency")
      };
      const rollbackOutcome = await restoreRollbackBoundary({
        repoRoot: request.context.repoRoot,
        boundary: rollbackBoundary,
        restoredAt: attemptCompletedAt,
        decision: patchDecision.decision
      });

      if (input.store) {
        await input.store.writeAttemptArtifacts(loop.loopId, currentAttemptIndex, {
          compiledContext,
          leash: createLeashArtifact(changeApprovalDecision, currentAttemptIndex),
          patchScore: patchDecision.score,
          patchDecision: toPatchDecisionArtifact(patchDecision),
          ...(rollbackBoundary ? { rollbackBoundary } : {}),
          ...(rollbackOutcome ? { rollbackOutcome } : {})
        });
        await input.store.appendLedger(
          loop.loopId,
          makeLedgerEvent({
            kind: "safety.violations_found",
            runId: loop.loopId,
            attemptIndex: currentAttemptIndex,
            payload: {
              surface: "dependency",
              blocked: true,
              profile: changeApprovalDecision.profile ?? executionProfile.name,
              attemptIndex: currentAttemptIndex,
              violations: changeApprovalDecision.violations
            }
          })
        );
        await input.store.appendLedger(
          loop.loopId,
          makeLedgerEvent({
            kind: "attempt.discarded",
            runId: loop.loopId,
            attemptIndex: currentAttemptIndex,
            payload: {
              decision: patchDecision.decision,
              reason: patchDecision.summary,
              reasonCodes: patchDecision.reasonCodes,
              score: patchDecision.score.score
            }
          })
        );
        await input.store.appendLedger(
          loop.loopId,
          makeLedgerEvent({
            kind: "run.exited",
            runId: loop.loopId,
            payload: createRunExitPayload(approvalExitDecision)
          })
        );
      }

      if (pendingControlWrites.length > 0) {
        await Promise.all(pendingControlWrites.splice(0));
      }
      const finalizedLoop = finalizeLoop(loop, approvalExitDecision, now(), idFactory);
      await persistLoopRecordIfSupported(input.store, finalizedLoop);
      return {
        loop: finalizedLoop,
        decision: approvalExitDecision
      };
    }

    // VERIFY: Run grounding scan on patch diff if available
    // Uses the task's repoRoot to build/load the grounding index, then scans any diff
    let groundingScanResult: GroundingScanResult | undefined;
    const patchDiff = buildPatchDiff(result, changedFiles);
    if (patchDiff && input.task.repoRoot) {
      try {
        const groundingIndex = await loadOrBuildRepoGroundingIndex(input.task.repoRoot);
        groundingScanResult = scanPatchForGroundingViolations(patchDiff, groundingIndex, {
          allowedPaths: input.task.allowedPaths
        });

        if (input.store && groundingScanResult.violations.length > 0) {
          await input.store.appendLedger(
            loop.loopId,
            makeLedgerEvent({
              kind: "grounding.violations_found",
              runId: loop.loopId,
              attemptIndex: currentAttemptIndex,
              payload: {
                violationCount: groundingScanResult.violations.length,
                resolvedFiles: groundingScanResult.resolvedFiles,
                contentOnly: groundingScanResult.contentOnly,
                violations: groundingScanResult.violations.slice(0, 10)
              }
            })
          );
        }
      } catch {
        // Grounding scan is best-effort — never fail the loop because of a scan error
      }
    }

    const shouldEvaluatePatchTruth =
      result.status === "completed" && tracksWorkspaceMutations && verifierConfigured;

    let patchDecision: EvaluatedPatchDecision | undefined;
    if (shouldEvaluatePatchTruth) {
      patchDecision = evaluatePatchDecision({
        verificationPassed: verification.passed,
        previousVerifierScore,
        verifierScore: verification.passed ? 1 : 0,
        groundingViolationCount: groundingScanResult?.violations.length ?? 0,
        changedFileCount: changedFileEvidenceAvailable ? changedFiles.length : undefined,
        mutationRequired: request.context.mutationMode === "edit",
        definitionOfDonePreSatisfied: request.context.definitionOfDonePreSatisfied,
        diffNovelty: changedFileEvidenceAvailable ? (changedFiles.length > 0 ? 1 : 0) : undefined,
        diffStats: result.execution?.diffStats,
        costUsd: getUsageUsd(result.usage),
        summary: result.summary
      });
    }

    let rollbackOutcome: RollbackOutcomeArtifact | undefined;
    if (patchDecision && patchDecision.decision !== "KEEP") {
      rollbackOutcome = await restoreRollbackBoundary({
        repoRoot: request.context.repoRoot,
        boundary: rollbackBoundary,
        restoredAt: attemptCompletedAt,
        decision: patchDecision.decision
      });
    } else if (result.status === "failed") {
      rollbackOutcome = await restoreRollbackBoundary({
        repoRoot: request.context.repoRoot,
        boundary: rollbackBoundary,
        restoredAt: attemptCompletedAt,
        decision: "DISCARD"
      });
    }

    if (input.store) {
      await input.store.writeAttemptArtifacts(loop.loopId, currentAttemptIndex, {
        compiledContext,
        ...(patchDiff ? { diff: patchDiff } : {}),
        ...(groundingScanResult ? { groundingScan: groundingScanResult } : {}),
        ...(patchDecision ? { patchScore: patchDecision.score } : {}),
        ...(patchDecision ? { patchDecision: toPatchDecisionArtifact(patchDecision) } : {}),
        ...(rollbackBoundary ? { rollbackBoundary } : {}),
        ...(rollbackOutcome ? { rollbackOutcome } : {})
      });
    }

    if (input.store) {
      if (patchDecision) {
        await input.store.appendLedger(
          loop.loopId,
          makeLedgerEvent({
            kind: patchDecision.decision === "KEEP" ? "attempt.kept" : "attempt.discarded",
            runId: loop.loopId,
            attemptIndex: currentAttemptIndex,
            payload: {
              decision: patchDecision.decision,
              reason: patchDecision.summary,
              reasonCodes: patchDecision.reasonCodes,
              score: patchDecision.score.score
            }
          })
        );
      } else {
        await input.store.appendLedger(
          loop.loopId,
          makeLedgerEvent({
            kind: verification.passed || !verifierConfigured ? "attempt.kept" : "attempt.discarded",
            runId: loop.loopId,
            attemptIndex: currentAttemptIndex,
            payload: { reason: verification.summary }
          })
        );
      }
    }

    if (patchDecision && patchDecision.decision !== "KEEP" && !failure) {
      failure = classifyPatchDecisionFailure(patchDecision, result);
      loop = applyPatchFailureToLoop(loop, {
        attemptId,
        summary: patchDecision.summary,
        failure
      });

      if (failure.recommendedIntervention === "compress_context") {
        useCompressedContext = true;
      }

      loop = appendLoopEvent(
        loop,
        {
          type: "failure.classified",
          lifecycleState: "running",
          payload: {
            attemptId,
            failureClass: failure.failureClass,
            rationale: failure.rationale
          }
        },
        { now: attemptCompletedAt, idFactory }
      );

      loop = appendLoopEvent(
        loop,
        {
          type: "intervention.selected",
          lifecycleState: "running",
          payload: { attemptId, intervention: failure.recommendedIntervention }
        },
        { now: attemptCompletedAt, idFactory }
      );
    }

    if (patchDecision?.decision === "ESCALATE" || patchDecision?.decision === "HANDOFF") {
      const patchExitDecision: ExitDecision = {
        shouldExit: true,
        lifecycleState: "human_escalation",
        status: "exited",
        reason: patchDecision.summary
      };

      if (input.store) {
        await input.store.appendLedger(
          loop.loopId,
          makeLedgerEvent({
            kind: "run.exited",
            runId: loop.loopId,
            payload: createRunExitPayload(patchExitDecision)
          })
        );
      }

      if (pendingControlWrites.length > 0) {
        await Promise.all(pendingControlWrites.splice(0));
      }
      const finalizedLoop = finalizeLoop(loop, patchExitDecision, now(), idFactory);
      await persistLoopRecordIfSupported(input.store, finalizedLoop);
      return {
        loop: finalizedLoop,
        decision: patchExitDecision
      };
    }

    const effectiveResult =
      patchDecision && patchDecision.decision !== "KEEP"
        ? {
            ...result,
            status: "failed" as const,
            summary: patchDecision.summary,
            verification: {
              ...result.verification,
              passed: false,
              summary: patchDecision.summary
            },
            failure: {
              message: patchDecision.summary,
              ...(failure?.failureClass ? { classHint: failure.failureClass } : {})
            }
          }
        : result;

    const decision = inferExit({
      loop,
      lastResult: effectiveResult,
      lastFailure: failure,
      costState,
      verificationRequired: verifierConfigured,
      canSwitchAdapter:
        failure?.recommendedIntervention === "switch_adapter" &&
        adapterChain[currentAdapterIndex] !== undefined &&
        currentAdapter.adapterId !== executingAdapter.adapterId
    });

    // Advance phase based on result
    currentPhase = nextPolicyPhase(currentPhase, effectiveResult, costState, phaseRetryCount);
    if (failure) phaseRetryCount++;
    else phaseRetryCount = 0;

    // Post-attempt: persisted verification and exit decisions must use the same
    // authoritative outcome. effectiveResult reflects any grounding/leash override,
    // so verification.completed is written here — never from the raw adapter result.
    const effectiveVerification = normalizeVerificationOutcome(effectiveResult, expectedVerifierBinding);

    loop = appendLoopEvent(
      loop,
      {
        type: "verification.completed",
        lifecycleState: effectiveVerification.passed ? "completed" : "verifying",
        payload: {
          attemptId,
          attemptIndex: currentAttemptIndex,
          passed: effectiveVerification.passed,
          summary: effectiveVerification.summary,
          ...(effectiveVerification.steps?.length ? { steps: effectiveVerification.steps } : {}),
          ...(effectiveVerification.warnings?.length ? { warnings: effectiveVerification.warnings } : {}),
          ...(effectiveVerification.binding ? { binding: effectiveVerification.binding } : {}),
          changedFiles,
        }
      },
      { now: attemptCompletedAt, idFactory }
    );

    if (input.store) {
      await input.store.appendLedger(
        loop.loopId,
        makeLedgerEvent({
          kind: "verification.completed",
          runId: loop.loopId,
          attemptIndex: currentAttemptIndex,
          payload: {
            attemptId,
            passed: effectiveVerification.passed,
            summary: effectiveVerification.summary,
            ...(effectiveVerification.steps?.length ? { steps: effectiveVerification.steps } : {}),
            ...(effectiveVerification.warnings?.length ? { warnings: effectiveVerification.warnings } : {}),
            ...(effectiveVerification.binding ? { binding: effectiveVerification.binding } : {}),
            changedFiles,
          }
        })
      );
    }

    const postAttemptTerminal = await evaluateCheckpoint("post_attempt", {
      status: effectiveResult.status === "completed" ? "completed" : "failed",
      verificationPassed: effectiveVerification.passed
    });
    if (postAttemptTerminal !== undefined) return await terminateRun(postAttemptTerminal);

    // Before-retry: check signals before scheduling the next attempt
    const preRetryTerminal = await evaluateCheckpoint("before_retry");
    if (preRetryTerminal !== undefined) return await terminateRun(preRetryTerminal);

    if (decision.shouldExit) {
      if (input.store) {
        await input.store.appendLedger(
          loop.loopId,
          makeLedgerEvent({
            kind: "run.exited",
            runId: loop.loopId,
            payload: createRunExitPayload(decision)
          })
        );
      }
      // Drain pending diagnostic ledger writes before receipt signing.
      if (pendingControlWrites.length > 0) {
        await Promise.all(pendingControlWrites.splice(0));
      }
      const routingInput = { runStartMs, firstDeltaDetected, firstDeltaTimestampMs, firstDeltaFilePath, firstDeltaChangeType, preDeltaCostUsd };
      const finalizedLoop = finalizeLoop(loop, decision, now(), idFactory, routingInput);
      await persistLoopRecordIfSupported(input.store, finalizedLoop);
      return {
        loop: finalizedLoop,
        decision
      };
    }
  }

  const decision: ExitDecision = {
    shouldExit: true,
    lifecycleState: "budget_exit",
    status: "exited",
    reason: "Martin exited because the loop exhausted its configured iteration budget."
  };

  if (input.store) {
    await input.store.appendLedger(
      loop.loopId,
      makeLedgerEvent({
        kind: "run.exited",
        runId: loop.loopId,
        payload: createRunExitPayload(decision)
      })
    );
  }

  // Drain pending diagnostic ledger writes before receipt signing.
  if (pendingControlWrites.length > 0) {
    await Promise.all(pendingControlWrites.splice(0));
  }
  const routingInput = { runStartMs, firstDeltaDetected, firstDeltaTimestampMs, firstDeltaFilePath, firstDeltaChangeType, preDeltaCostUsd };
  const finalizedLoop = finalizeLoop(loop, decision, now(), idFactory, routingInput);
  await persistLoopRecordIfSupported(input.store, finalizedLoop);
  return {
    loop: finalizedLoop,
    decision
  };
  } finally {
    if (wallTimer !== undefined) clearTimeout(wallTimer);
    disposeSignalMonitor();
    runController.abort();
    activeAttemptController?.abort();
    // Flush any diagnostic ledger writes queued from signal callbacks
    await Promise.all(pendingControlWrites);
  }
}

function createRunExitPayload(decision: ExitDecision): Record<string, unknown> {
  return {
    lifecycleState: decision.lifecycleState,
    status: decision.status,
    reason: decision.reason,
    ...(decision.failureClass ? { failureClass: decision.failureClass } : {}),
    ...(decision.safetySurface ? { safetySurface: decision.safetySurface } : {}),
    ...(decision.reasonCode ? { reasonCode: decision.reasonCode } : {})
  };
}

function classifySafetyLeashExit(
  decision: { surface: string; violations: SafetyViolation[] },
  safetySurface = decision.surface
): Pick<ExitDecision, "failureClass" | "safetySurface" | "reasonCode"> {
  return {
    failureClass: "safety_leash_blocked",
    safetySurface,
    reasonCode: safetyLeashReasonCode(decision, safetySurface)
  };
}

function safetyLeashReasonCode(
  decision: { surface: string; violations: SafetyViolation[] },
  safetySurface: string
): string {
  const kind = decision.violations[0]?.kind;

  switch (kind) {
    case "command_blocked":
      return safetySurface === "verifier" ? "destructive_verifier_command" : "command_blocked";
    case "network_blocked":
      return safetySurface === "verifier" ? "verifier_network_blocked" : "network_access_blocked";
    case "secret_value":
      return "secret_context_value";
    case "path_denied":
    case "protected_path":
      return "protected_surface_write";
    case "path_not_allowed":
      return "surface_write_not_allowed";
    case "path_outside_repo":
      return "outside_repo_write";
    case "dependency_approval_required":
      return "dependency_approval_required";
    case "migration_approval_required":
      return "migration_approval_required";
    case "config_change_approval_required":
      return "config_change_approval_required";
    default:
      return `${safetySurface}_safety_block`;
  }
}

function finalizeLoop(
  loop: LoopRecord,
  decision: ExitDecision,
  timestamp: string,
  idFactory?: (prefix: string) => string,
  routingEconomicsInput?: {
    runStartMs: number;
    firstDeltaDetected: boolean;
    firstDeltaTimestampMs?: number;
    firstDeltaFilePath?: string;
    firstDeltaChangeType?: "create" | "modify" | "delete" | "patch_proposed";
    preDeltaCostUsd: number;
  },
): LoopRecord {
  const finalized = appendLoopEvent(
    loop,
    {
      type: "run.completed",
      lifecycleState: decision.lifecycleState,
      payload: createRunExitPayload(decision)
    },
    { now: timestamp, idFactory }
  );

  const routingEconomics = routingEconomicsInput
    ? buildRoutingEconomics(finalized, routingEconomicsInput, decision)
    : undefined;

  const avoidedUsd = calculateLoopAvoidedUsd({ loop: finalized, decision });

  return {
    ...finalized,
    status: decision.status,
    lifecycleState: decision.lifecycleState,
    updatedAt: timestamp,
    cost: { ...finalized.cost, avoidedUsd },
    ...(routingEconomics ? { routingEconomics } : {})
  };
}

function buildRoutingEconomics(
  loop: LoopRecord,
  input: {
    runStartMs: number;
    firstDeltaDetected: boolean;
    firstDeltaTimestampMs?: number;
    firstDeltaFilePath?: string;
    firstDeltaChangeType?: "create" | "modify" | "delete" | "patch_proposed";
    preDeltaCostUsd: number;
  },
  decision: ExitDecision
): import("@martin/contracts").RoutingEconomics {
  const totalCost = loop.cost.actualUsd;
  const preworkCost = roundUsd(Math.max(input.preDeltaCostUsd, 0));
  const executionCost = roundUsd(Math.max(totalCost - preworkCost, 0));
  const preworkBurnPct = totalCost > 0 ? Math.round((preworkCost / totalCost) * 100) : 0;
  const timeToFirstDeltaMs = input.firstDeltaTimestampMs
    ? input.firstDeltaTimestampMs - input.runStartMs
    : undefined;
  const accepted = decision.lifecycleState === "completed";

  // Route recommendation based on prework burn
  let routeRecommendation: import("@martin/contracts").RoutingEconomics["routeRecommendation"];
  let routeRecommendationReason: string | undefined;
  if (preworkBurnPct > 50) {
    routeRecommendation = "direct_worker";
    routeRecommendationReason = `${String(preworkBurnPct)}% of spend was pre-work coordination. Use direct execution for similar tasks.`;
  } else if (preworkBurnPct > 30) {
    routeRecommendation = "direct_worker";
    routeRecommendationReason = `${String(preworkBurnPct)}% pre-work burn is high. Consider direct execution.`;
  } else {
    routeRecommendation = "same_route";
    routeRecommendationReason = `Pre-work burn at ${String(preworkBurnPct)}% is within acceptable range.`;
  }

  return {
    preworkCostUsd: preworkCost,
    executionCostUsd: executionCost,
    verificationCostUsd: 0,
    retryCostUsd: 0,
    totalCostUsd: totalCost,
    preworkBurnPct,
    timeToFirstDeltaMs,
    firstDelta: {
      detected: input.firstDeltaDetected,
      ...(input.firstDeltaTimestampMs ? { timestampMs: input.firstDeltaTimestampMs } : {}),
      ...(input.firstDeltaFilePath ? { filePath: input.firstDeltaFilePath } : {}),
      ...(input.firstDeltaChangeType ? { changeType: input.firstDeltaChangeType } : {}),
      ...(timeToFirstDeltaMs !== undefined ? { timeToFirstDeltaMs } : {})
    },
    ...(accepted ? { costPerAcceptedChange: totalCost } : {}),
    routeRecommendation,
    routeRecommendationReason
  };
}

const MARTINLOOP_METADATA_PATTERNS = [
  /^PROGRESS\.md$/u,
  /^\.martin\//u,
  /\.lock$/u,
  /^node_modules\//u,
  /^\.git\//u,
  /^\.cache\//u,
];

function isMartinLoopMetadata(filePath: string): boolean {
  return MARTINLOOP_METADATA_PATTERNS.some((p) => p.test(filePath));
}

async function persistLoopRecordIfSupported(
  store: RunStore | undefined,
  loop: LoopRecord
): Promise<void> {
  await store?.writeLoopRecord?.(loop.loopId, loop);
}

function getAdapterTransport(adapter: MartinAdapter): "cli" | "http" | "routed_http" {
  return adapter.metadata.transport ?? (adapter.kind === "agent-cli" ? "cli" : "http");
}

function getUsageUsd(usage: MartinAdapterResult["usage"]): number {
  return roundUsd(usage.actualUsd);
}

function getUsageProvenance(usage: MartinAdapterResult["usage"]): CostProvenance {
  if (usage.provenance) {
    return usage.provenance;
  }

  if (usage.estimatedUsd !== undefined) {
    return "estimated";
  }

  return "actual";
}

const COST_PROVENANCE_RANK: Record<CostProvenance, number> = {
  unavailable: 0,
  estimated: 1,
  calculated: 2,
  actual: 3
};

/**
 * Aggregates cost provenance across attempts. The cumulative loop provenance
 * can only be as trustworthy as its weakest attempt: if any attempt's cost was
 * estimated or unavailable, the cumulative total must reflect that, even if a
 * later attempt reports an authoritative actual cost.
 */
function mergeCostProvenance(
  previous: CostProvenance | undefined,
  current: CostProvenance
): CostProvenance {
  if (previous === undefined) {
    return current;
  }

  return COST_PROVENANCE_RANK[current] < COST_PROVENANCE_RANK[previous] ? current : previous;
}

function resolveChangedFiles(
  result: MartinAdapterResult,
  repoRoot?: string,
  rollbackBoundary?: RollbackBoundaryArtifact
): string[] {
  if (result.execution?.changedFiles !== undefined) {
    return result.execution.changedFiles;
  }

  return listAttemptChangedFilesSinceBoundary({ repoRoot, boundary: rollbackBoundary });
}

function buildPatchDiff(result: MartinAdapterResult, changedFiles: string[]): string | undefined {
  // Use structured diff stats to build a minimal diff header if no raw diff is available
  if (result.execution?.changedFiles?.length) {
    // Build a synthetic diff header from changed file list
    return result.execution.changedFiles
      .map((file) => `--- a/${file}\n+++ b/${file}\n@@ -0,0 +1 @@\n+`)
      .join("\n");
  }
  if (changedFiles.length > 0) {
    return changedFiles
      .map((file) => `--- a/${file}\n+++ b/${file}\n@@ -0,0 +1 @@\n+`)
      .join("\n");
  }
  return undefined;
}

function createBudgetSettlement(input: {
  runId: string;
  attemptIndex: number;
  usage: MartinAdapterResult["usage"];
  estimate: BudgetPreflightDecision["estimate"];
  settledAt: string;
}) {
  const totalActualUsd = getUsageUsd(input.usage);

  return {
    runId: input.runId,
    attemptIndex: input.attemptIndex,
    patchCost: {
      usd: totalActualUsd,
      tokensIn: input.usage.tokensIn,
      tokensOut: input.usage.tokensOut,
      provenance: getUsageProvenance(input.usage)
    },
    verificationCost: {
      usd: 0,
      provenance: "unavailable" as CostProvenance
    },
    ...(input.usage.providerSettlement
      ? { providerSettlement: input.usage.providerSettlement }
      : {}),
    totalActualUsd,
    preflightEstimateUsd: input.estimate.estimatedAttemptCostUsd,
    varianceUsd: roundUsd(totalActualUsd - input.estimate.estimatedAttemptCostUsd),
    settledAt: input.settledAt
  };
}

function roundUsd(value: number): number {
  return Math.round(value * 100) / 100;
}

function makeId(prefix: string, idFactory?: (prefix: string) => string): string {
  if (idFactory) return idFactory(prefix);
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}`;
}

function serializeSafetyViolations(decision: {
  surface: string;
  blockedCommands: string[];
  violations: SafetyViolation[];
}): Array<string | SafetyViolation> {
  if (decision.surface === "command") {
    return decision.blockedCommands;
  }

  return decision.violations;
}

function createLeashArtifact(
  decision: {
    surface: string;
    profile?: string;
    reason?: string;
    violations: SafetyViolation[];
  },
  attemptIndex: number
): Record<string, unknown> {
  return {
    attemptIndex,
    surface: decision.surface,
    blocked: true,
    ...(decision.profile ? { profile: decision.profile } : {}),
    ...(decision.reason ? { reason: decision.reason } : {}),
    violations: decision.violations
  };
}

function getLastVerifierScore(loop: LoopRecord): number {
  for (let index = loop.events.length - 1; index >= 0; index -= 1) {
    const event = loop.events[index];
    if (event?.type !== "verification.completed") {
      continue;
    }

    return event.payload["passed"] === true ? 1 : 0;
  }

  return 0;
}

function truncateVerificationDetail(text: string, maxLength: number): string {
  return text.length <= maxLength ? text : `${text.slice(0, maxLength - 1)}…`;
}

function resolveExpectedVerifierBinding(request: MartinAdapterRequest): VerifierExecutionBinding {
  const commands = request.context.verificationStack?.length
    ? request.context.verificationStack.map((step) => step.command)
    : request.context.verificationPlan;
  return {
    runId: request.loopId,
    workspaceId: request.workspaceId,
    cwd: request.context.repoRoot ?? process.cwd(),
    commands,
  };
}

function normalizeVerificationOutcome(
  result: MartinAdapterResult,
  expectedBinding: VerifierExecutionBinding
): MartinVerificationOutcome {
  const warnings = [...(result.verification.warnings ?? [])];
  const contradiction = detectVerificationContradiction(result);
  if (contradiction && !warnings.includes(contradiction)) {
    warnings.push(contradiction);
  }

  const executionPassed = verifierActuallyPassed(result.verification, expectedBinding);
  if (result.verification.passed && !executionPassed && !contradiction) {
    warnings.push("Verification evidence conflicts with the configured run, workspace, cwd, command, or subprocess result.");
  }

  return {
    passed: executionPassed && !contradiction,
    summary: result.verification.summary,
    ...(result.verification.steps?.length ? { steps: result.verification.steps } : {}),
    ...(warnings.length ? { warnings } : {}),
    ...(result.verification.binding ? { binding: result.verification.binding } : {})
  };
}

function detectVerificationContradiction(result: MartinAdapterResult): string | undefined {
  if (!result.verification.passed) {
    return undefined;
  }

  const sources = [result.summary, result.failure?.message]
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0);

  const contradictionPatterns = [
    /createprocessasuserw failed:\s*\d+/iu,
    /\bverifier not run\b/iu,
    /\bfailed before verifier\b/iu,
    /\bnever launched\b/iu,
    /\bfailed to launch\b/iu,
    /\bcould not launch\b/iu
  ];

  for (const source of sources) {
    const match = contradictionPatterns.find((pattern) => pattern.test(source));
    if (!match) {
      continue;
    }

    const excerpt = truncateVerificationDetail(source.trim().replace(/\s+/gu, " "), 220);
    return `Adapter output reported a tool-launch problem before MartinLoop ran its own verifier: ${excerpt}`;
  }

  return undefined;
}

function resolveActiveRunsRoot(store: RunStore | undefined): string {
  const configuredRunsRoot = store?.runsRoot?.trim();
  return configuredRunsRoot && configuredRunsRoot.length > 0 ? configuredRunsRoot : resolveRunsRoot();
}

function toPatchDecisionArtifact(decision: EvaluatedPatchDecision): PatchDecisionArtifact {
  return {
    decision: decision.decision,
    summary: decision.summary,
    reasonCodes: decision.reasonCodes
  };
}

const SANDBOX_WRITE_BLOCKED_PATTERNS = [
  /createprocessasuserw failed:\s*\d+/iu,
  /windows sandbox: runner error/iu,
  /writing is blocked by read-only sandbox/iu,
  /read-only filesystem sandbox/iu,
  /approval is disabled/iu
];

function detectSandboxWriteBlocked(result: MartinAdapterResult): boolean {
  const sources = [result.summary, result.failure?.message]
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0);
  return sources.some((source) => SANDBOX_WRITE_BLOCKED_PATTERNS.some((pattern) => pattern.test(source)));
}

function classifyPatchDecisionFailure(
  decision: EvaluatedPatchDecision,
  result?: MartinAdapterResult
): FailureAssessment {
  if (decision.reasonCodes.includes("grounding_failure")) {
    return {
      failureClass: "repo_grounding_failure",
      rationale: "Patch truth discarded the attempt because grounding evidence contradicted the patch.",
      retryable: true,
      recommendedIntervention: "run_verifier"
    };
  }

  if (decision.reasonCodes.includes("scope_violation")) {
    return {
      failureClass: "scope_creep",
      rationale: "Patch truth discarded the attempt because it changed files outside the task scope.",
      retryable: true,
      recommendedIntervention: "tighten_task"
    };
  }

  if (
    decision.reasonCodes.includes("verifier_regressed") ||
    decision.reasonCodes.includes("large_diff_no_improvement")
  ) {
    return {
      failureClass: "test_regression",
      rationale: "Patch truth discarded the attempt because the verifier regressed or stopped improving.",
      retryable: true,
      recommendedIntervention: "run_verifier"
    };
  }

  if (decision.reasonCodes.includes("human_approval_required")) {
    return {
      failureClass: "scope_creep",
      rationale: "Patch truth escalated the attempt because it requires explicit human approval.",
      retryable: false,
      recommendedIntervention: "escalate_human"
    };
  }

  if (decision.reasonCodes.includes("safety_violation")) {
    return {
      failureClass: "scope_creep",
      rationale: "Patch truth escalated the attempt because safety evidence blocked it.",
      retryable: false,
      recommendedIntervention: "escalate_human"
    };
  }

  if (result && detectSandboxWriteBlocked(result)) {
    return {
      failureClass: "sandbox_write_blocked",
      rationale:
        "The adapter reported a completed patch but the workspace-write sandbox blocked the underlying file write, so no trustworthy code change landed on disk.",
      retryable: true,
      recommendedIntervention: "switch_adapter"
    };
  }

  return {
    failureClass: "no_progress",
    rationale: "Patch truth discarded the attempt because it did not produce a trustworthy code change.",
    retryable: true,
    recommendedIntervention: "compress_context"
  };
}

function applyPatchFailureToLoop(
  loop: LoopRecord,
  input: {
    attemptId: string;
    summary: string;
    failure: FailureAssessment;
  }
): LoopRecord {
  return {
    ...loop,
    attempts: loop.attempts.map((attempt) =>
      attempt.attemptId === input.attemptId
        ? {
            ...attempt,
            summary: input.summary,
            failureClass: input.failure.failureClass,
            intervention: input.failure.recommendedIntervention
          }
        : attempt
    )
  };
}

export {
  createDefaultExitPolicy,
  evaluateExitPolicy,
  hashProgressState,
  toLegacyExitDecision,
  validateExitPolicy
} from "./exits.js";
export type { ExitPolicyOverrides, LegacyExitDecision } from "./exits.js";
export {
  SignalDiagnosticError,
  createFileExitSignalSource,
  exitSignalPath,
  readAllExitSignals,
  readExitSignal,
  startExitSignalMonitor,
  writeExitSignal
} from "./exit-signal.js";
export type { ExitSignalSource, SignalDiagnostic, SignalReadResult } from "./exit-signal.js";

// ─── R4 Delivery ─────────────────────────────────────────────────────────────
export {
  cacheMessage,
  fetchSelectedMessage,
  getCliInstalledVersion,
  getMcpInstalledVersion,
  isCooldownExpired,
  isDismissed,
  isNewerVersion,
  loadDeliveryRecord,
  parseMessageSelectionResponse,
  recordDismissed,
  recordShown,
  resolveDefaultLedgerPath,
  saveDeliveryRecord,
} from "./delivery/index.js";
export type {
  MessageClientOptions,
  MessageSelectRequest,
  ParseFailure,
  ParseResult,
  ValidationError,
} from "./delivery/index.js";
