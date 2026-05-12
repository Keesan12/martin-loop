import { spawnSync } from "node:child_process";

import {
  type ApprovalPolicy,
  appendLoopEvent,
  createLoopRecord,
  type CostProvenance,
  type ExecutionProfile,
  type FailureClass,
  type HeadlessContextTask,
  type InterventionType,
  type LoopArtifact,
  type LoopAttempt,
  type LoopBudget,
  type LoopRecord,
  type LoopTask,
  type MachineState,
  type PatchDecisionArtifact,
  type PatchScore,
  type RollbackOutcomeArtifact,
  type PolicyPhase
} from "@martin/contracts";
import {
  classifyFailure,
  computeEvidenceVector,
  evaluateBudgetPreflight,
  evaluateCostGovernor,
  evaluatePatchDecision,
  evaluateScopeDrift,
  inferExit,
  nextPolicyPhase,
  policyPhaseToLifecycleState,
  scorePatchDecision,
  selectRecoveryRecipe,
  containsPositive,
  detectOscillation,
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
  runContextIntegrityPrecheck,
  type ContextIntegrityVerdict
} from "./truth-spine.js";
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
  applyPolicyToLeashDecision,
  type PolicyLeashOptions,
  type PolicyLeashVerdict
} from "./leash/policy-leash.js";
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
import { scanStreamsForTraps } from "./verifier-pyramid.js";
import {
  captureRepoMutationEvidence,
  captureRollbackBoundary,
  restoreRollbackBoundary
} from "./rollback.js";
import { scanDiffForCves as _scanDiffForCves } from "./security/cve-scanner.js";
import { detectStagnation } from "./sentinel/progress-guard.js";
import {
  detectStreamingAnomalies,
  type LoopPatternId
} from "./pattern-detection.js";
import {
  compilePromptPacket,
  type HeadlessContextPromptEnvelope
} from "./compiler.js";
import { auditClaimEvidence } from "./evidence/claim-audit.js";
import {
  resolveMartinHome,
  signFileAttestation,
  verifyFileAttestation,
  verifyLoopRecordAttestation
} from "./attestation/sign.js";
import { probePhase, type EntryProbeOutcome } from "./probe/probe.js";

import { analyzeLoopSurface, buildSurfaceGuidance } from "./surface-signals.js";
import {
  buildAttemptFocus,
  evaluateRetryEconomics
} from "./strategy/attempt-brief.js";
import { estimateBlastRadius, type BlastRadiusResult } from "./leash/blast-radius.js";
import {
  buildRiskTierVerificationPlan,
  type RiskTierVerificationPlan
} from "./verification/tiered-verify.js";
import {
  calibrateTrust,
  shouldDeprioritize,
  type ModelTrustProfile
} from "./router/trust-calibration.js";
import {
  compileContext as compileHeadlessContext,
  createMartinLoopHeadlessHooks
} from "@martin/headlessos-core";
import type { LoopMemoryStore, MemoryBrief } from "./memory/palace.js";
import type { AuditEvent, AuditExporter } from "@martin/audit-exporter";

// ─── Public API re-exports ───────────────────────────────────────────────────
export type {
  ApprovalPolicy,
  BudgetPreflightEstimate,
  BudgetSettlement,
  CostProvenance,
  EvidenceVector,
  ExecutionProfile,
  FailureClass,
  HeadlessContextTask,
  InterventionType,
  PatchDecision,
  PatchDecisionArtifact,
  PatchDecisionReasonCode,
  PatchScore,
  RollbackBoundaryArtifact,
  RollbackBoundaryStrategy,
  RollbackFileSnapshot,
  RollbackOutcomeArtifact,
  RollbackOutcomeStatus,
  PolicyPhase
} from "@martin/contracts";
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
  applyPolicyToLeashDecision,
  resolveExecutionProfile,
  redactSecretsFromText,
  buildRepoGroundingIndex,
  loadOrBuildRepoGroundingIndex,
  queryRepoGroundingIndex,
  scanPatchForGroundingViolations,
  analyzeLoopSurface,
  buildSurfaceGuidance,
  captureRollbackBoundary,
  restoreRollbackBoundary
};
export { scanDiffForCves, extractPackageCandidates } from "./security/cve-scanner.js";
export type { CveMatch, CveScanResult, CveSeverity, PackageCandidate } from "./security/cve-scanner.js";
export { detectStreamingAnomalies } from "./pattern-detection.js";
export type {
  DetectStreamingAnomaliesInput,
  LoopPatternDetection,
  LoopPatternId
} from "./pattern-detection.js";
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
  PolicyBackedSafetyLeashDecision,
  PolicyLeashOptions,
  PolicyLeashVerdict
} from "./leash/policy-leash.js";
export type {
  GroundingScanResult,
  GroundingViolation,
  GroundingViolationKind,
  RepoGroundingHit,
  RepoGroundingIndex
} from "./grounding.js";
export { resolveSessionId } from "./grounding.js";
export type { SurfaceSignalInput, SurfaceSignals } from "./surface-signals.js";
export {
  compileHeadlessContext,
  createMartinLoopHeadlessHooks
};
export type {
  HeadlessContextPromptEnvelope
} from "./compiler.js";

// ─── Prompt packet compiler ──────────────────────────────────────────────────
export { compilePromptPacket } from "./compiler.js";
export type { PromptPacket, CompilerAdapterRequest } from "./compiler.js";

// ─── Prior learning API ─────────────────────────────────────────────────────
export {
  createPriorSet,
  getPriorSet,
  listPriorSets,
  loadPriorStore,
  promotePriorSet,
  rollbackPriorSet,
  savePriorStore
} from "./learning/prior-sets.js";
export { evaluateGuardedPromotion } from "./learning/promotion-gate.js";
export type {
  CreatePriorSetInput,
  PriorSet,
  PriorStore,
  PromotionGate
} from "./learning/prior-sets.js";
export type {
  GuardedPromotionDecision,
  GuardedPromotionInput
} from "./learning/promotion-gate.js";

// ─── Phase 23 production claim gates ────────────────────────────────────────
export { runFailureModeRecoverySuite } from "./recovery/failure-mode-runner.js";
export type {
  FailureModeRecoveryCase,
  FailureModeRecoverySuiteInput,
  FailureModeRecoverySuiteReport
} from "./recovery/failure-mode-runner.js";
export { evaluateStaleProofGate } from "./drift/stale-proof-gate.js";
export type {
  ProofBoundClaim,
  ProofGateArtifact,
  StaleProofGateInput,
  StaleProofGateReport
} from "./drift/stale-proof-gate.js";
export { evaluateAutonomyEnvelope } from "./autonomy/envelope.js";
export type {
  AutonomyEnvelopeDecision,
  AutonomyEnvelopeInput
} from "./autonomy/envelope.js";
export {
  buildAttemptFocus,
  detectRepeatedVerifierSignature,
  evaluateRetryEconomics,
  normalizeVerifierSignature
} from "./strategy/attempt-brief.js";
export type {
  AttemptFocusInput,
  RetryEconomicsDecision,
  RetryEconomicsInput
} from "./strategy/attempt-brief.js";

// ─── Persistence (RunStore, LedgerEvent, FileRunStore) ──────────────────────
import {
  createFileRunStore,
  makeLedgerEvent,
  readAllLoopRecords,
  readLatestLoopRecord,
  readLatestLoopRecordFromFile,
  readLoopRecordsFromFile,
  resolveRunsRoot,
  runDir
} from "./persistence/index.js";

export {
  createFileRunStore,
  makeLedgerEvent,
  readAllLoopRecords,
  readLatestLoopRecord,
  readLatestLoopRecordFromFile,
  readLoopRecordsFromFile,
  resolveRunsRoot,
  runDir,
  resolveMartinHome,
  signFileAttestation,
  verifyFileAttestation,
  verifyLoopRecordAttestation
};

import type {
  AttemptArtifacts,
  LedgerEvent,
  LedgerEventKind,
  LoopAttemptRecord,
  LoopRunRecord,
  RunContract,
  RunStore
} from "./persistence/index.js";

export type {
  AttemptArtifacts,
  LoopAttemptRecord,
  LedgerEvent,
  LedgerEventKind,
  LoopRunRecord,
  RunContract,
  RunStore
};
export { compileAndPersistContext } from "./persistence/index.js";
export type { CompileResult } from "./persistence/index.js";

// ─── Session cleanup (zombie run TTL) ────────────────────────────────────────
export {
  cleanStaleRuns,
  resolveActiveRuns,
  ensureRunsRoot
} from "./persistence/cleanup.js";
export type { CleanupResult } from "./persistence/cleanup.js";

// ─── Circuit breakers ────────────────────────────────────────────────────────
export { detectStagnation } from "./sentinel/progress-guard.js";
export type { StagnationInput, StagnationResult } from "./sentinel/progress-guard.js";

// ─── Composable cost pipeline ─────────────────────────────────────────────────
export {
  MODEL_HAIKU,
  MODEL_SONNET,
  selectModel,
  createCostTracker,
  addCostRecord,
  callWithRetry,
  buildCachedMessages,
  runCostAwarePipeline,
  BudgetExceededError
} from "./cost/pipeline.js";
export type {
  SupportedModel,
  CostRecord,
  CostTracker,
  RetryOptions,
  LlmCallResult,
  LlmClient,
  PipelineConfig,
  PipelineInput,
  PipelineOutput,
  CachedMessageArray,
  SystemMessage,
  UserMessage
} from "./cost/pipeline.js";

// ─── Checkpoint / resumable loops (SLICE-23) ─────────────────────────────────
export {
  assertSafeLoopId,
  cleanupOldCheckpoints,
  getCheckpointStorageDir,
  hashFiles,
  readCheckpoint,
  validateWorkspaceHashes,
  WorkspaceModifiedError,
  writeCheckpoint
} from "./persistence/checkpoint.js";
export type { Checkpoint, CheckpointPhase } from "./persistence/checkpoint.js";

// ─── Explain / formatter (SLICE-25) ──────────────────────────────────────────
export { formatRunExplanation } from "./explain/formatter.js";
export { formatRunTimeline } from "./explain/timeline.js";
export type {
  ExplainOptions,
  ExplainOutput,
  ExplainJson,
  ExplainAttempt
} from "./explain/formatter.js";
export type {
  FormatRunTimelineInput,
  RunTimelineEntry,
  RunTimelineJson,
  RunTimelineOutput
} from "./explain/timeline.js";
export type { StoredAttemptArtifact } from "./replay/replay.js";

// ─── Digital Twin & Risk-Tiered Verification (Phase 31+) ─────────────────────
export { runDigitalTwinSimulation } from "./digital-twin/index.js";
export type {
  DigitalTwinSimulationInput,
  DigitalTwinSimulationReport
} from "./digital-twin/index.js";
export {
  buildRiskTierVerificationPlan,
  type RiskTierVerificationInput,
  type RiskTierVerificationPlan
} from "./verification/tiered-verify.js";

// ─── Autonomy V2 & Escalation Ledger (Phase 30-31) ───────────────────────────
export {
  evaluateAutonomyEnvelopeV2,
  type AutonomyEnvelopeV2Input,
  type AutonomyEnvelopeV2Decision
} from "./autonomy/envelope-v2.js";
export {
  buildAutonomyEscalationLedger,
  type AutonomyEscalationLedger,
  type AutonomyEscalationLedgerEntry
} from "./autonomy/escalation-ledger.js";
export {
  evaluateAutonomyResume,
  type AutonomyResumeInput,
  type AutonomyResumeDecision
} from "./autonomy/resume.js";
export {
  buildAutonomousPromotionArtifact,
  classifyAutonomySurface,
  classifyAutonomySurfaceSet,
  evaluateAutonomousPromotion,
  evaluateAutonomyTripwires,
  persistAutonomousPromotionArtifact
} from "./autonomy/autonomous-promotion.js";
export type {
  AutonomousPromotionArtifact,
  AutonomousPromotionArtifactInput,
  AutonomousPromotionDecision,
  AutonomousPromotionEvidence,
  AutonomousPromotionInput,
  AutonomousPromotionSignatureMetadata,
  AutonomousPromotionVerdict,
  AutonomyBudgetPressure,
  AutonomySurface,
  AutonomySurfaceClassification,
  AutonomySurfaceSetClassification,
  AutonomyTripwireEvent,
  AutonomyTripwireInput,
  AutonomyTripwireReasonCode,
  AutonomyTripwireVerdict,
  PersistAutonomousPromotionArtifactInput,
  PersistedAutonomousPromotionArtifact
} from "./autonomy/autonomous-promotion.js";

// ─── Context Flow (HeadlessOS OSS tier) ─────────────────────────────────────
export * from "./context-flow/index.js";

// ─── Adapter interfaces ──────────────────────────────────────────────────────

export interface MartinAdapterRequest {
  loopId: string;
  attemptId: string;
  context: {
    taskTitle: string;
    objective: string;
    verificationPlan: string[];
    verificationStack?: LoopTask["verificationStack"];
    metadata?: Record<string, string>;
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
    focus: string;
    remainingBudgetUsd: number;
    remainingIterations: number;
    remainingTokens: number;
    memoryBrief?: MemoryBrief;
    headlessContext?: HeadlessContextPromptEnvelope;
  };
  previousAttempts: LoopAttempt[];
}

export interface MartinUsage {
  actualUsd: number;
  estimatedUsd?: number;
  tokensIn: number;
  tokensOut: number;
  /** Extended-thinking tokens billed at output rate. 0 when extended thinking is off. */
  thinkingTokensOut?: number;
  provenance?: CostProvenance;
}

export type ProbeTier = "trivial" | "standard" | "hard";

export interface MartinProbeRequest {
  objective: string;
  fileHints: string[];
  primaryModel: string;
  probeModel: string;
  remainingBudgetUsd: number;
}

export type MartinProbeResult =
  | {
      status: "completed";
      tier: ProbeTier;
      reason: string;
      usage: MartinUsage;
    }
  | {
      status: "failed";
      reason: string;
      usage: MartinUsage;
      failure?: {
        message: string;
      };
    };

export interface MartinAdapterResult {
  status: "completed" | "failed";
  summary: string;
  usage: MartinUsage;
  verification: {
    passed: boolean;
    summary: string;
  };
  execution?: {
    changedFiles?: string[];
    patchDiff?: string;
    diffStats?: {
      filesChanged: number;
      addedLines: number;
      deletedLines: number;
    };
    stdout?: string;
    stderr?: string;
    exitCode?: number;
    baseline?: {
      startHeadSha: string;
      startTrackedStatus: string;
      startUntrackedSet: string[];
      startTimestamp: string;
      worktreeClean: boolean;
      pilotRepoClass: string | null;
    };
    gitNormalization?: {
      startHeadSha: string;
      endHeadShaBeforeNormalization: string;
      normalizationApplied: boolean;
      normalizationMode: "reset_mixed_to_start_head" | "none";
      normalizationSucceeded: boolean;
      headAfterNormalization: string;
    };
    scopeSurface?: {
      trackedChangedPaths: string[];
      deletedPaths: string[];
      newUntrackedPaths: string[];
      allChangedPaths: string[];
      baselineWasClean: boolean;
      noCodeChange: boolean;
      diffStats?: {
        filesChanged: number;
        addedLines: number;
        deletedLines: number;
      };
    };
    structuredErrors?: Array<{
      file: string;
      line?: number;
      col?: number;
      code?: string;
      message: string;
    }>;
    timeoutRecovery?: {
      attempted: boolean;
      strategy: string;
      timedOut: boolean;
      exitCode: number;
      summary: string;
    };
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
    model: string;
    transport?: "cli" | "http" | "routed_http";
    capabilities?: {
      preflight?: boolean;
      usageSettlement?: boolean;
      diffArtifacts?: boolean;
      structuredErrors?: boolean;
      cachingSignals?: boolean;
    };
    [key: string]: unknown;
  };
  execute(request: MartinAdapterRequest): Promise<MartinAdapterResult>;
  probe?(request: MartinProbeRequest): Promise<MartinProbeResult>;
  withModel?(model: string): MartinAdapter;
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
}

/**
 * Admission gate — must pass before any attempt is executed.
 * Evaluates budget headroom, oscillation, and repetitive failure patterns.
 * PolicyPhase remains explicit: attempts are only admitted in ADMIT phase.
 */
export function evaluateAttemptPolicy(input: {
  request: MartinAdapterRequest;
  projectedUsd: number;
  novelRecoveryPath?: boolean;
}): AttemptPolicyDecision {
  const { request, projectedUsd, novelRecoveryPath } = input;

  // Budget gate: reject if projected cost exceeds remaining
  if (projectedUsd > request.context.remainingBudgetUsd) {
    return {
      allowed: false,
      reason: `Projected cost $${projectedUsd} exceeds remaining budget $${request.context.remainingBudgetUsd}.`,
      recommendedIntervention: "stop_loop"
    };
  }

  // Iteration gate
  if (request.context.remainingIterations <= 0) {
    return {
      allowed: false,
      reason: "No remaining iterations in the budget.",
      recommendedIntervention: "stop_loop"
    };
  }

  // Oscillation detection: A/B/A pattern in failure classes
  const failures = request.previousAttempts
    .map((a) => a.failureClass)
    .filter((fc): fc is FailureClass => Boolean(fc));

  if (!novelRecoveryPath && failures.length >= 3) {
    const last3 = failures.slice(-3);
    const isOscillating = last3[0] !== last3[1] && last3[0] === last3[2];
    if (isOscillating) {
      return {
        allowed: false,
        reason: "Oscillating failure pattern detected. Escalating to human.",
        recommendedIntervention: "escalate_human"
      };
    }
  }

  // Materially repetitive detection: same summary content pattern 3x
  if (!novelRecoveryPath && request.previousAttempts.length >= 3) {
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
          recommendedIntervention: "escalate_human"
        };
      }
    }
  }

  const recentAttempts = request.previousAttempts.slice(-2);
  const repeatedSurface =
    recentAttempts.length === 2 &&
    recentAttempts[0]?.failureClass &&
    recentAttempts[0].failureClass === recentAttempts[1]?.failureClass;

  if (!novelRecoveryPath && repeatedSurface) {
    const highRiskSurface = analyzeLoopSurface({
      objective: request.context.objective,
      verificationPlan: request.context.verificationPlan,
      previousAttempts: recentAttempts
    });

    if (
      highRiskSurface.mergeConflictSignalCount > 0 ||
      highRiskSurface.workspaceGraphRiskScore >= 0.5 ||
      highRiskSurface.crossBoundaryRiskScore >= 0.5
    ) {
      return {
        allowed: false,
        reason:
          "High-risk cross-boundary loop detected. Escalate instead of burning another broad retry.",
        recommendedIntervention: "escalate_human"
      };
    }
  }

  const retryEconomics = evaluateRetryEconomics({
    previousAttempts: request.previousAttempts,
    projectedUsd,
    remainingBudgetUsd: request.context.remainingBudgetUsd,
    remainingIterations: request.context.remainingIterations,
    novelRecoveryPath
  });

  if (!retryEconomics.allowRetry) {
    return {
      allowed: false,
      reason: retryEconomics.reason ?? "Retry economics rejected another near-identical attempt.",
      recommendedIntervention: "stop_loop"
    };
  }

  return {
    allowed: true,
    reason: "Attempt admitted."
  };
}

// ─── Stream detector signal ──────────────────────────────────────────────────

/** Emitted after each attempt outcome. Consumed by stream detectors in @martin/trace-intelligence. */
export interface AttemptSignal {
  attemptIndex: number;
  /** undefined when attempt was kept (successful) */
  failureClass?: string;
  /** Cumulative run cost including this attempt */
  costUsdSoFar: number;
  groundingViolations: number;
  kept: boolean;
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
  fallbackModels?: string[];
  fallbackAdapters?: MartinAdapter[];
  /** Precomputed blast radius result or score. If omitted, runMartin computes it best-effort. */
  blastRadius?: BlastRadiusResult | number;
  /** Precomputed trust profiles. If omitted, runMartin calibrates from the run store best-effort. */
  trustProfiles?: ModelTrustProfile[];
  /** Explicit policy path. Must be compiled WASM; raw Rego fails closed with guidance. */
  policyPath?: string;
  /** Explicit compiled policy WASM path. Takes precedence over policyPath. */
  policyWasmPath?: string;
  /** Optional persistence store. When provided, runMartin writes artifacts on each lifecycle event. */
  store?: RunStore;
  /** Optional memory store. When provided, prior loop lessons are injected and terminal outcomes are recorded. */
  memoryStore?: LoopMemoryStore;
  /** Optional audit exporter. When provided with a store, ledger events are mirrored to it. */
  auditExporter?: AuditExporter;
  /** Advisory callback fired after each attempt outcome. Never throws, never blocks the loop. */
  onAttemptSignal?: (signal: AttemptSignal) => void;
}

export interface RoutingEvidence {
  selectedModel: string;
  selectedAdapterId: string;
  selectionSource:
    | "primary"
    | "probe"
    | "blast_radius"
    | "trust_calibration"
    | "deprioritized_model";
  rationale: string;
  blastRadiusScore?: number;
  trustProfile?: {
    model: string;
    runsObserved: number;
    completionRate: number;
    efficiencyScore: number;
    avgCostPerIteration: number;
  };
}

export interface RunMartinResult {
  loop: LoopRecord;
  decision: ExitDecision;
  routingEvidence?: RoutingEvidence;
}

export function previewInitialRouting(input: {
  adapter: MartinAdapter;
  fallbackAdapters?: MartinAdapter[];
  fallbackModels?: string[];
  blastRadius?: BlastRadiusResult | number;
  trustProfiles?: ModelTrustProfile[];
}): RoutingEvidence {
  const DEFAULT_FALLBACK_MODELS = [
    "claude-haiku-4-5",
    "claude-sonnet-4-6",
    "claude-opus-4-6"
  ];
  const recoveryMatrix = buildRecoveryMatrix({
    adapterChain: [input.adapter, ...(input.fallbackAdapters ?? [])],
    fallbackModels: input.fallbackModels ?? DEFAULT_FALLBACK_MODELS
  });
  const currentPath =
    recoveryMatrix[0] ??
    createRecoveryPath({
      adapter: input.adapter,
      adapterIndex: 0,
      matrixIndex: 0,
      model: input.adapter.metadata.model
    });

  return selectInitialRecoveryPath({
    recoveryMatrix,
    currentPath,
    blastRadius:
      input.blastRadius !== undefined ? normalizeBlastRadius(input.blastRadius) : undefined,
    trustProfiles: input.trustProfiles ?? []
  }).evidence;
}

type PersistStateInput = {
  loop: LoopRecord;
  phase: PolicyPhase;
  activeModel: string;
  currentAttempt: number;
  lastVerifierScore?: number;
  policyHistory: MachineState["policyHistory"];
  openAlerts?: string[];
};

export function distillContext(
  loop: Pick<LoopRecord, "task" | "budget" | "cost" | "attempts">,
  options: { maxRecentAttempts?: number } = {}
): DistilledContext {
  const maxRecentAttempts = options.maxRecentAttempts ?? 3;
  const recentAttempts = loop.attempts.slice(-maxRecentAttempts);

  return {
    focus: buildAttemptFocus({
      task: loop.task,
      attempts: loop.attempts,
      remainingBudgetUsd: roundUsd(loop.budget.maxUsd - loop.cost.actualUsd)
    }),
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
  input = withAuditedRunStore(input);
  const now = input.now ?? (() => new Date().toISOString());
  const idFactory = input.idFactory;

  let loop = createLoopRecord(
    {
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      task: input.task,
      budget: input.budget,
      ...(input.teamId ? { teamId: input.teamId } : {}),
      ...(input.metadata ? { metadata: input.metadata } : {})
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
  }

  const DEFAULT_FALLBACK_MODELS = [
    "claude-haiku-4-5",
    "claude-sonnet-4-6",
    "claude-opus-4-6"
  ];
  const adapterChain = [input.adapter, ...(input.fallbackAdapters ?? [])];
  const recoveryMatrix = buildRecoveryMatrix({
    adapterChain,
    fallbackModels: input.fallbackModels ?? DEFAULT_FALLBACK_MODELS
  });
  const attemptedRecoveryPathKeys = new Set<string>();
  let currentRecoveryPath =
    recoveryMatrix[0] ??
    createRecoveryPath({
      adapter: input.adapter,
      adapterIndex: 0,
      matrixIndex: 0,
      model: input.adapter.metadata.model
    });
  const routingSignals = await resolveRoutingSignals(input);
  const initialRoutingDecision = selectInitialRecoveryPath({
    recoveryMatrix,
    currentPath: currentRecoveryPath,
    blastRadius: routingSignals.blastRadius,
    trustProfiles: routingSignals.trustProfiles
  });
  currentRecoveryPath = initialRoutingDecision.path;
  let currentAdapter = currentRecoveryPath.adapter;
  let activeRoutingEvidence = initialRoutingDecision.evidence;
  let currentPhase: PolicyPhase = "GATHER";
  let useCompressedContext = false;
  let openAlerts: string[] = [];
  let policyHistory: MachineState["policyHistory"] = [
    {
      phase: "GATHER",
      reason: "Run initialized and waiting for admission checks.",
      timestamp: loop.createdAt
    }
  ];
  const executionProfile = resolveExecutionProfile({
    executionProfile: input.task.executionProfile,
    allowedNetworkDomains: input.task.allowedNetworkDomains
  });
  const policyLeashOptions = buildPolicyLeashOptions(input);

  // Safety leash: block destructive verifier commands before any attempt
  const leashDecision = await applyPolicyToLeashDecision(
    evaluateVerificationLeash({
      verificationPlan: input.task.verificationPlan,
      verificationStack: input.task.verificationStack,
      executionProfile: input.task.executionProfile,
      allowedNetworkDomains: input.task.allowedNetworkDomains
    }),
    buildVerificationPolicyInputs(input.task),
    policyLeashOptions
  );

  if (!leashDecision.allowed) {
    currentPhase = "ESCALATE";
    openAlerts = ["requires_human_review", "safety:command"];
    policyHistory = appendPolicyHistory(
      policyHistory,
      currentPhase,
      "Verification leash blocked unsafe verifier commands before execution.",
      now()
    );
    const reason = `${leashDecision.reason ?? "Safety leash blocked verifier commands."} Blocked: ${leashDecision.blockedCommands.join(", ")}`;
    const leashExitDecision: ExitDecision = {
      shouldExit: true,
      lifecycleState: "human_escalation",
      status: "exited",
      reason
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
            violations: serializeSafetyViolations(leashDecision),
            ...serializePolicyVerdict(leashDecision)
          }
        })
      );
      await input.store.appendLedger(
        loop.loopId,
        makeLedgerEvent({
          kind: "run.exited",
          runId: loop.loopId,
          payload: {
            lifecycleState: leashExitDecision.lifecycleState,
            status: leashExitDecision.status,
            reason: leashExitDecision.reason
          }
        })
      );
    }
    const finalizedLoop = finalizeLoop(loop, leashExitDecision, now(), idFactory);
    await persistMachineState(input.store, finalizedLoop.loopId, {
      loop: finalizedLoop,
      phase: currentPhase,
      activeModel: currentAdapter.metadata.model,
      currentAttempt: loop.attempts.length,
      policyHistory,
      openAlerts
    });
    return {
      loop: finalizedLoop,
      decision: leashExitDecision
    };
  }

  const secretValues = [
    input.task.title,
    input.task.objective,
    ...(input.task.acceptanceCriteria ?? [])
  ];
  const secretDecision = await applyPolicyToLeashDecision(
    evaluateSecretLeash({
      values: secretValues
    }),
    secretValues.map((value) => ({
      surface: "secret",
      command: null,
      value
    })),
    policyLeashOptions
  );

  if (!secretDecision.allowed) {
    currentPhase = "ESCALATE";
    openAlerts = ["requires_human_review", "safety:secret"];
    policyHistory = appendPolicyHistory(
      policyHistory,
      currentPhase,
      "Secret leash blocked runtime context before execution.",
      now()
    );
    const secretExitDecision: ExitDecision = {
      shouldExit: true,
      lifecycleState: "human_escalation",
      status: "exited",
      reason: secretDecision.reason ?? "Safety leash blocked secret-like values in the runtime context."
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
            violations: secretDecision.violations.map((violation) => violation.match ?? violation.message),
            ...serializePolicyVerdict(secretDecision)
          }
        })
      );
      await input.store.appendLedger(
        loop.loopId,
        makeLedgerEvent({
          kind: "run.exited",
          runId: loop.loopId,
          payload: {
            lifecycleState: secretExitDecision.lifecycleState,
            status: secretExitDecision.status,
            reason: secretExitDecision.reason
          }
        })
      );
    }
    const finalizedLoop = finalizeLoop(loop, secretExitDecision, now(), idFactory);
    await persistMachineState(input.store, finalizedLoop.loopId, {
      loop: finalizedLoop,
      phase: currentPhase,
      activeModel: currentAdapter.metadata.model,
      currentAttempt: loop.attempts.length,
      policyHistory,
      openAlerts
    });

    return {
      loop: finalizedLoop,
      decision: secretExitDecision
    };
  }

  const entryProbe = await probePhase({
    adapter: currentAdapter,
    fallbackModels: input.fallbackModels ?? DEFAULT_FALLBACK_MODELS,
    objective: loop.task.objective,
    fileHints: buildProbeFileHints(loop.task),
    remainingBudgetUsd: roundUsd(loop.budget.maxUsd - loop.cost.actualUsd),
    primaryModel: currentRecoveryPath.model,
    now
  });
  const entryProbeExecutionPath =
    activeRoutingEvidence.selectionSource === "blast_radius"
      ? undefined
      : createEntryProbeExecutionPath({
          recoveryMatrix,
          currentPath: currentRecoveryPath,
          probe: entryProbe
        });

  if (entryProbe.status !== "skipped") {
    loop = {
      ...loop,
      cost: {
        actualUsd: roundUsd(loop.cost.actualUsd + getUsageUsd(entryProbe.usage)),
        avoidedUsd: loop.cost.avoidedUsd,
        tokensIn: loop.cost.tokensIn + entryProbe.usage.tokensIn,
        tokensOut: loop.cost.tokensOut + entryProbe.usage.tokensOut,
        thinkingTokensOut: (loop.cost.thinkingTokensOut ?? 0) + (entryProbe.usage.thinkingTokensOut ?? 0),
        childCostUsd: loop.cost.childCostUsd ?? 0
      },
      updatedAt: entryProbe.completedAt
    };
  }

  const initialExecutionPath = entryProbeExecutionPath ?? currentRecoveryPath;
  if (entryProbeExecutionPath) {
    activeRoutingEvidence = {
      selectedModel: initialExecutionPath.model,
      selectedAdapterId: initialExecutionPath.adapter.adapterId,
      selectionSource: "probe",
      rationale: "Entry probe classified the task as trivial and selected the cheapest eligible model.",
      ...(routingSignals.blastRadius
        ? { blastRadiusScore: routingSignals.blastRadius.score }
        : {})
    };
  }
  loop = {
    ...loop,
    metadata: {
      ...loop.metadata,
      routingEvidence: JSON.stringify(activeRoutingEvidence)
    }
  };
  const runStartedAt =
    entryProbe.status === "skipped" ? now() : entryProbe.completedAt;

  loop = appendLoopEvent(
    loop,
    {
      type: "run.started",
      lifecycleState: "running",
      payload: {
        adapterId: initialExecutionPath.adapter.adapterId,
        providerId: initialExecutionPath.adapter.metadata.providerId,
        model: initialExecutionPath.adapter.metadata.model,
        transport: getAdapterTransport(initialExecutionPath.adapter),
        routingEvidence: activeRoutingEvidence,
        ...(entryProbe.status !== "skipped"
          ? {
              probeStatus: entryProbe.status,
              probeRoute: entryProbe.route,
              probeModel: entryProbe.probeModel,
              probeReason: entryProbe.reason,
              selectionSource: entryProbe.route === "cheap-first" ? "probe" : "primary",
              ...(entryProbe.status === "completed" ? { probeTier: entryProbe.tier } : {})
            }
          : {})
      }
    },
    { now: runStartedAt, idFactory }
  );

  await persistMachineState(input.store, loop.loopId, {
    loop,
    phase: "GATHER",
    activeModel: initialExecutionPath.adapter.metadata.model,
    currentAttempt: 0,
    policyHistory,
    openAlerts
  });

  // Explicit PolicyPhase state machine — starts at GATHER, advances per attempt
  let phaseRetryCount = 0;

  while (loop.attempts.length < loop.budget.maxIterations) {
    // ── Wall-clock circuit breaker (slice 3.1) ────────────────────────────────
    if (loop.budget.maxWallClockMs !== undefined) {
      const elapsedMs = Date.now() - new Date(runStartedAt).getTime();
      if (elapsedMs >= loop.budget.maxWallClockMs) {
        const wallClockDecision: ExitDecision = {
          shouldExit: true,
          lifecycleState: "wall_clock_exceeded",
          status: "exited",
          reason: `Wall-clock limit ${loop.budget.maxWallClockMs}ms exceeded (elapsed: ${elapsedMs}ms). Prevents runaway infinite loops.`
        };
        const finalizedWallClock = finalizeLoop(loop, wallClockDecision, now(), idFactory);
        await persistMachineState(input.store, finalizedWallClock.loopId, {
          loop: finalizedWallClock,
          phase: currentPhase,
          activeModel: currentRecoveryPath.adapter.metadata.model,
          currentAttempt: loop.attempts.length,
          policyHistory,
          openAlerts
        });
        return { loop: finalizedWallClock, decision: wallClockDecision };
      }
    }

    const distilled = distillContext(loop, {
      maxRecentAttempts: useCompressedContext ? 1 : (input.maxRecentAttempts ?? 3)
    });
    useCompressedContext = false;
    const attemptStartedAt = now();
    const attemptId = makeId("att", idFactory);
    const executingRecoveryPath =
      loop.attempts.length === 0 && entryProbeExecutionPath
        ? entryProbeExecutionPath
        : currentRecoveryPath;
    const executingAdapter = executingRecoveryPath.adapter;

    const budgetPreflight = evaluateBudgetPreflight({
      promptCharCount: distilled.focus.length + loop.task.objective.length * 3,
      attemptCount: loop.attempts.length,
      remainingBudgetUsd: distilled.constraints.remainingBudgetUsd,
      perAttemptCapUsd: loop.budget.maxUsd * 0.25
    });

    if (!budgetPreflight.allowed) {
      currentPhase = "ABORT";
      openAlerts = ["budget:hard_limit"];
      policyHistory = appendPolicyHistory(
        policyHistory,
        currentPhase,
        "Budget preflight rejected the next attempt before execution.",
        now()
      );
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
            payload: {
              lifecycleState: preflightExitDecision.lifecycleState,
              status: preflightExitDecision.status,
              reason: preflightExitDecision.reason
            }
          })
        );
      }
      const finalizedLoop = finalizeLoop(loop, preflightExitDecision, now(), idFactory);
      await persistMachineState(input.store, finalizedLoop.loopId, {
        loop: finalizedLoop,
        phase: currentPhase,
        activeModel: executingAdapter.metadata.model,
        currentAttempt: loop.attempts.length,
        policyHistory,
        openAlerts
      });
      return {
        loop: finalizedLoop,
        decision: preflightExitDecision
      };
    }

    // GATHER → ADMIT: run admission control before executing
    currentPhase = "ADMIT";
    openAlerts = [];
    
    // T05: TruthSpine Context Integrity Pre-gate (CTO Decision 1)
    const contextPrecheck = await runContextIntegrityPrecheck(
      loop.loopId,
      loop.attempts.length + 1,
      runDir(resolveRunsRoot(), loop.loopId),
      {
        userPrompt: distilled.focus,
        history: loop.attempts.map(a => a.summary).join("\n")
      }
    );

    if (contextPrecheck.verdict === "context_poisoning_block") {
       currentPhase = "ABORT";
       openAlerts = ["safety:context_poisoning"];
       const poisoningExitDecision: ExitDecision = {
         shouldExit: true,
         lifecycleState: "human_escalation",
         status: "exited",
         reason: "TruthSpine: Context poisoning attempt detected."
       };
       if (input.store) {
         await input.store.appendLedger(loop.loopId, makeLedgerEvent({
           kind: "safety.violations_found",
           runId: loop.loopId,
           payload: { 
             verdict: contextPrecheck.verdict, 
             signals: contextPrecheck.detectedSignals,
             source: "truth_spine_pregate" 
           }
         }));
       }
       const finalizedLoop = finalizeLoop(loop, poisoningExitDecision, now(), idFactory);
       return { loop: finalizedLoop, decision: poisoningExitDecision };
    }

    policyHistory = appendPolicyHistory(
      policyHistory,
      currentPhase,
      "Budget preflight passed; evaluating admission control for the next attempt.",
      now()
    );
    await persistMachineState(input.store, loop.loopId, {
      loop,
      phase: currentPhase,
      activeModel: executingAdapter.metadata.model,
      currentAttempt: loop.attempts.length,
      policyHistory,
      openAlerts
    });

    const nextAttemptIndex = loop.attempts.length + 1;
    const memoryBrief = await recallLoopMemory({
      input,
      loop,
      focus: distilled.focus,
      attemptIndex: nextAttemptIndex
    });
    const headlessContext = buildHeadlessContextEnvelope(loop.task.headlessContext);

    const admissionDecision = evaluateAttemptPolicy({
      request: {
        loopId: loop.loopId,
        attemptId,
        context: {
          taskTitle: loop.task.title,
          objective: loop.task.objective,
          verificationPlan: loop.task.verificationPlan,
          ...(loop.task.verificationStack ? { verificationStack: loop.task.verificationStack } : {}),
          ...(loop.task.repoRoot ? { repoRoot: loop.task.repoRoot } : {}),
          ...(loop.task.allowedPaths ? { allowedPaths: loop.task.allowedPaths } : {}),
          ...(loop.task.deniedPaths ? { deniedPaths: loop.task.deniedPaths } : {}),
          ...(loop.task.acceptanceCriteria ? { acceptanceCriteria: loop.task.acceptanceCriteria } : {}),
          ...(loop.task.executionProfile ? { executionProfile: loop.task.executionProfile } : {}),
          ...(loop.task.allowedNetworkDomains
            ? { allowedNetworkDomains: loop.task.allowedNetworkDomains }
            : {}),
          ...(loop.task.approvalPolicy ? { approvalPolicy: loop.task.approvalPolicy } : {}),
          ...(input.metadata ? { metadata: input.metadata } : {}),
          focus: distilled.focus,
          remainingBudgetUsd: distilled.constraints.remainingBudgetUsd,
          remainingIterations: distilled.constraints.remainingIterations,
          remainingTokens: distilled.constraints.remainingTokens,
          ...(memoryBrief ? { memoryBrief } : {}),
          ...(headlessContext ? { headlessContext } : {})
        },
        previousAttempts: loop.attempts
      },
      projectedUsd: budgetPreflight.estimate.estimatedAttemptCostUsd,
      novelRecoveryPath: !attemptedRecoveryPathKeys.has(executingRecoveryPath.key)
    });

    if (!admissionDecision.allowed) {
      currentPhase =
        admissionDecision.recommendedIntervention === "escalate_human" ? "ESCALATE" : "ABORT";
      openAlerts =
        currentPhase === "ESCALATE"
          ? ["requires_human_review", "admission:rejected"]
          : ["budget:admission_rejected"];
      policyHistory = appendPolicyHistory(
        policyHistory,
        currentPhase,
        "Attempt admission control rejected the next attempt.",
        now()
      );
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
            payload: {
              lifecycleState: exitDecision.lifecycleState,
              status: exitDecision.status,
              reason: exitDecision.reason
            }
          })
        );
      }
      const finalizedLoop = finalizeLoop(loop, exitDecision, now(), idFactory);
      await persistMachineState(input.store, finalizedLoop.loopId, {
        loop: finalizedLoop,
        phase: currentPhase,
        activeModel: executingAdapter.metadata.model,
        currentAttempt: loop.attempts.length,
        policyHistory,
        openAlerts
      });
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
            transport: getAdapterTransport(executingAdapter),
            ...(loop.attempts.length === 0 ? { routingEvidence: activeRoutingEvidence } : {}),
            ...(loop.attempts.length === 0 && entryProbe.status !== "skipped"
              ? {
                  probeStatus: entryProbe.status,
                  probeRoute: entryProbe.route,
                  probeModel: entryProbe.probeModel,
                  probeReason: entryProbe.reason,
                  selectionSource: entryProbe.route === "cheap-first" ? "probe" : "primary",
                  ...(entryProbe.status === "completed" ? { probeTier: entryProbe.tier } : {})
                }
              : {})
          }
        })
      );
    }

    // ADMIT → PATCH
    currentPhase = "PATCH";
    openAlerts = [];
    policyHistory = appendPolicyHistory(
      policyHistory,
      currentPhase,
      "Attempt admitted and ready for adapter execution.",
      attemptStartedAt
    );
    await persistMachineState(input.store, loop.loopId, {
      loop,
      phase: currentPhase,
      activeModel: executingAdapter.metadata.model,
      currentAttempt: loop.attempts.length + 1,
      policyHistory,
      openAlerts
    });

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
      attemptId,
      context: {
        taskTitle: loop.task.title,
        objective: loop.task.objective,
        verificationPlan: loop.task.verificationPlan,
        ...(loop.task.verificationStack ? { verificationStack: loop.task.verificationStack } : {}),
        ...(loop.task.repoRoot ? { repoRoot: loop.task.repoRoot } : {}),
        ...(loop.task.allowedPaths ? { allowedPaths: loop.task.allowedPaths } : {}),
        ...(loop.task.deniedPaths ? { deniedPaths: loop.task.deniedPaths } : {}),
        ...(loop.task.acceptanceCriteria ? { acceptanceCriteria: loop.task.acceptanceCriteria } : {}),
        ...(loop.task.executionProfile ? { executionProfile: loop.task.executionProfile } : {}),
        ...(loop.task.allowedNetworkDomains
          ? { allowedNetworkDomains: loop.task.allowedNetworkDomains }
          : {}),
        ...(loop.task.approvalPolicy ? { approvalPolicy: loop.task.approvalPolicy } : {}),
        ...(input.metadata ? { metadata: input.metadata } : {}),
        focus: distilled.focus,
        remainingBudgetUsd: distilled.constraints.remainingBudgetUsd,
        remainingIterations: distilled.constraints.remainingIterations,
        remainingTokens: distilled.constraints.remainingTokens,
        ...(memoryBrief ? { memoryBrief } : {}),
        ...(headlessContext ? { headlessContext } : {})
      },
      previousAttempts: loop.attempts
    };

    const rollbackBoundary = await captureRollbackBoundary({
      repoRoot: request.context.repoRoot,
      capturedAt: attemptStartedAt
    });
    let result: MartinAdapterResult;
    try {
      result = await executingAdapter.execute(request);
    } catch (error) {
      const message = toErrorMessage(error);
      result = {
        status: "failed",
        summary: "Adapter threw before completing the attempt.",
        usage: {
          actualUsd: 0,
          tokensIn: 0,
          tokensOut: 0,
          provenance: "unavailable"
        },
        verification: {
          passed: false,
          summary: "Adapter execution threw before verification could run."
        },
        failure: {
          message: `${message}. environment_mismatch`,
          classHint: "environment_mismatch"
        },
        execution: {
          stderr: message,
          exitCode: 1
        }
      };
    }
    const attemptCompletedAt = now();
    const compiledContext = compilePromptPacket(request);
    const mutationEvidence = await captureRepoMutationEvidence({
      repoRoot: request.context.repoRoot,
      boundary: rollbackBoundary
    });
    const changedFiles = resolveChangedFiles(
      result,
      request.context.repoRoot,
      mutationEvidence?.changedFiles
    );
    const patchDiff = buildPatchDiff(
      result,
      changedFiles,
      mutationEvidence?.patchDiff,
      mutationEvidence !== undefined
    );
    const previousVerifierScore = getLastVerifierScore(loop);

    // PATCH → VERIFY
    currentPhase = "VERIFY";
    const currentAttemptIndex = loop.attempts.length + 1;
    const verificationPlanArtifact = await synthesizeAttemptVerificationPlan({
      loop,
      task: loop.task,
      attemptIndex: currentAttemptIndex,
      changedFiles,
      executionProfile: executionProfile.name,
      repoRoot: request.context.repoRoot
    });
    openAlerts = result.verification.passed ? [] : ["verification:failed"];
    policyHistory = appendPolicyHistory(
      policyHistory,
      currentPhase,
      "Adapter execution completed; verifying patch, safety, and grounding evidence.",
      attemptCompletedAt
    );
    await persistMachineState(input.store, loop.loopId, {
      loop,
      phase: currentPhase,
      activeModel: executingAdapter.metadata.model,
      currentAttempt: currentAttemptIndex,
      lastVerifierScore: result.verification.passed ? 1 : 0,
      policyHistory,
      openAlerts
    });

    let failure =
      result.status === "failed"
        ? classifyFailure({ attempts: loop.attempts, result })
        : undefined;

    // Preserve the intervention from classifyFailure before selectStrongerIntervention
    // can override it. The adapter switch must be driven by the original classification
    // (environment_mismatch → switch_adapter), not by the recovery recipe's default
    // escalate_human catch-all which fires when no specific pattern matches.
    const classifiedIntervention = failure?.recommendedIntervention;

    if (failure) {
      const recoveryDecision = selectRecoveryRecipe(
        computeEvidenceVector({
          verificationPlan: request.context.verificationPlan,
          changedFiles,
          summary: result.summary,
          failureMessage: result.failure?.message,
          diff: patchDiff,
          actualUsd: getUsageUsd(result.usage),
          previousVerifierScore,
          verifierScore: result.verification.passed ? 1 : 0,
          retryCountForSurface: countPriorSurfaceRetries(loop.attempts, failure.failureClass)
        })
      );
      const recommendedIntervention =
        recoveryDecision.recipe === "escalate_human"
          ? failure.recommendedIntervention
          : selectStrongerIntervention(
              failure.recommendedIntervention,
              recoveryDecision.intervention
            );

      failure = {
        ...failure,
        recommendedIntervention,
        rationale:
          recommendedIntervention === failure.recommendedIntervention
            ? failure.rationale
            : `${failure.rationale} ${recoveryDecision.rationale}`
      };
    }

    const attempt: LoopAttempt = {
      attemptId,
      index: currentAttemptIndex,
      adapterId: executingAdapter.adapterId,
      model: executingAdapter.metadata.model,
      startedAt: attemptStartedAt,
      completedAt: attemptCompletedAt,
      summary: result.summary,
      verifierSummary: result.verification.summary,
      ...(failure?.failureClass ? { failureClass: failure.failureClass } : {}),
      ...(failure?.recommendedIntervention
        ? { intervention: failure.recommendedIntervention }
        : {})
    };

    loop = {
      ...loop,
      attempts: [...loop.attempts, attempt],
      cost: {
        actualUsd: roundUsd(loop.cost.actualUsd + getUsageUsd(result.usage)),
        avoidedUsd: loop.cost.avoidedUsd,
        tokensIn: loop.cost.tokensIn + result.usage.tokensIn,
        tokensOut: loop.cost.tokensOut + result.usage.tokensOut,
        thinkingTokensOut: (loop.cost.thinkingTokensOut ?? 0) + (result.usage.thinkingTokensOut ?? 0),
        childCostUsd: loop.cost.childCostUsd ?? 0
      },
      updatedAt: attemptCompletedAt
    };

    loop = appendLoopEvent(
      loop,
      {
        type: "attempt.completed",
        lifecycleState: "running",
        payload: { attemptId, status: result.status, summary: result.summary }
      },
      { now: attemptCompletedAt, idFactory }
    );

    const streamingPatterns = detectStreamingAnomalies({
      attemptId,
      result,
      previousAttempts: loop.attempts.slice(0, -1),
      resolvedChangedFiles: changedFiles,
      failureClass: failure?.failureClass
    });

    if (streamingPatterns.length > 0) {
      for (const pattern of streamingPatterns) {
        loop = appendLoopEvent(
          loop,
          {
            type: "pattern.detected",
            lifecycleState: "running",
            payload: {
              attemptId: pattern.attemptId,
              patternId: pattern.patternId,
              severity: pattern.severity,
              message: pattern.message,
              evidence: pattern.evidence
            }
          },
          { now: attemptCompletedAt, idFactory }
        );
      }
    }

    // ── Stagnation circuit breaker (slice 3.2) ────────────────────────────────
    const stagnation = detectStagnation({ attempts: loop.attempts });
    if (stagnation.stagnant) {
      const stagnationDecision: ExitDecision = {
        shouldExit: true,
        lifecycleState: "stagnation_detected",
        status: "exited",
        reason: stagnation.reason ?? "Stagnation detected: identical failure pattern repeated."
      };
      const finalizedStagnation = finalizeLoop(loop, stagnationDecision, now(), idFactory);
      await persistMachineState(input.store, finalizedStagnation.loopId, {
        loop: finalizedStagnation,
        phase: currentPhase,
        activeModel: executingAdapter.metadata.model,
        currentAttempt: loop.attempts.length,
        policyHistory,
        openAlerts
      });
      return { loop: finalizedStagnation, decision: stagnationDecision };
    }
    let modelChanged = false;
    let hasRecoveryPath = false;

    if (failure) {
      attemptedRecoveryPathKeys.add(executingRecoveryPath.key);

      if (failure.recommendedIntervention === "compress_context") {
        useCompressedContext = true;
      }

      let adapterSwitched = false;
      const nextRecoveryPath = selectNextRecoveryPath({
        recoveryMatrix,
        attemptedKeys: attemptedRecoveryPathKeys,
        currentPath: executingRecoveryPath,
        recommendedIntervention: failure.recommendedIntervention,
        classifiedIntervention
      });

      if (nextRecoveryPath) {
        hasRecoveryPath = true;
        currentRecoveryPath = nextRecoveryPath;
        currentAdapter = nextRecoveryPath.adapter;
        adapterSwitched = nextRecoveryPath.adapterIndex !== executingRecoveryPath.adapterIndex;
        modelChanged = nextRecoveryPath.model !== executingRecoveryPath.model;
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

    loop = appendLoopEvent(
      loop,
      {
        type: "verification.completed",
        lifecycleState: result.verification.passed ? "completed" : "verifying",
        payload: {
          attemptId,
          passed: result.verification.passed,
          summary: result.verification.summary
        }
      },
      { now: attemptCompletedAt, idFactory }
    );

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
          pressure: costState.pressure
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
        ...(verificationPlanArtifact ? { verificationPlan: verificationPlanArtifact } : {}),
        ...(currentAttemptIndex === 1 && entryProbe.status !== "skipped"
          ? { probe: serializeEntryProbe(entryProbe) }
          : {}),
        ...(result.execution?.baseline ? { baseline: result.execution.baseline } : {}),
        ...(result.execution?.gitNormalization
          ? { gitNormalization: result.execution.gitNormalization }
          : {}),
        ...(result.execution?.scopeSurface ? { scopeSurface: result.execution.scopeSurface } : {}),
        ...(rollbackBoundary ? { rollbackBoundary } : {}),
        ...(streamingPatterns.length > 0 ? { patterns: { patterns: streamingPatterns } } : {})
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
          kind: "verification.completed",
          runId: loop.loopId,
          attemptIndex: currentAttemptIndex,
          payload: { passed: result.verification.passed, summary: result.verification.summary }
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
            provenance: getUsageProvenance(result.usage),
            transport: getAdapterTransport(executingAdapter),
            providerId: executingAdapter.metadata.providerId,
            model: executingAdapter.metadata.model,
            ...(currentAttemptIndex === 1 && entryProbe.status !== "skipped"
              ? {
                  probeCost: {
                    usd: getUsageUsd(entryProbe.usage),
                    tokensIn: entryProbe.usage.tokensIn,
                    tokensOut: entryProbe.usage.tokensOut,
                    provenance: getUsageProvenance(entryProbe.usage),
                    model: entryProbe.probeModel,
                    providerId: entryProbe.providerId
                  }
                }
              : {}),
            patchCost: settlement.patchCost,
            verificationCost: settlement.verificationCost,
            varianceUsd: settlement.varianceUsd,
            preflightEstimateUsd: settlement.preflightEstimateUsd
          }
        })
      );
    }

    const changedFileEvidenceAvailable =
      result.execution?.changedFiles !== undefined || Boolean(request.context.repoRoot);
    const filesystemDecision = await applyPolicyToLeashDecision(
      evaluateFilesystemLeash({
        repoRoot: request.context.repoRoot,
        changedFiles,
        allowedPaths: request.context.allowedPaths,
        deniedPaths: request.context.deniedPaths
      }),
      changedFiles.map((path) => ({
        surface: "filesystem",
        path,
        command: null
      })),
      {
        ...policyLeashOptions,
        repoRoot: request.context.repoRoot ?? policyLeashOptions.repoRoot
      }
    );

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
        reason: filesystemDecision.reason ?? "Safety leash blocked filesystem changes."
      };
      currentPhase = "ESCALATE";
      openAlerts = ["requires_human_review", "safety:filesystem"];
      policyHistory = appendPolicyHistory(
        policyHistory,
        currentPhase,
        "Filesystem leash blocked the attempted patch scope.",
        attemptCompletedAt
      );
      const rollbackOutcome = await restoreRollbackBoundary({
        repoRoot: request.context.repoRoot,
        boundary: rollbackBoundary,
        restoredAt: attemptCompletedAt,
        decision: patchDecision.decision,
        changedFiles,
        allowedPaths: request.context.allowedPaths
      });

      if (input.store) {
        await input.store.writeAttemptArtifacts(loop.loopId, currentAttemptIndex, {
          compiledContext,
          ...(verificationPlanArtifact ? { verificationPlan: verificationPlanArtifact } : {}),
          ...(result.execution?.baseline ? { baseline: result.execution.baseline } : {}),
          ...(result.execution?.gitNormalization
            ? { gitNormalization: result.execution.gitNormalization }
            : {}),
          ...(result.execution?.scopeSurface ? { scopeSurface: result.execution.scopeSurface } : {}),
          ...(patchDiff ? { diff: patchDiff } : {}),
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
              violations: filesystemDecision.violations,
              ...serializePolicyVerdict(filesystemDecision)
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
            payload: {
              lifecycleState: filesystemExitDecision.lifecycleState,
              status: filesystemExitDecision.status,
              reason: filesystemExitDecision.reason
            }
          })
        );
      }

      const finalizedLoop = finalizeLoop(loop, filesystemExitDecision, now(), idFactory);
      await persistMachineState(input.store, finalizedLoop.loopId, {
        loop: finalizedLoop,
        phase: currentPhase,
        activeModel: executingAdapter.metadata.model,
        currentAttempt: currentAttemptIndex,
        lastVerifierScore: result.verification.passed ? 1 : 0,
        policyHistory,
        openAlerts
      });

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
          "Safety leash blocked dependency or migration changes that require approval."
      };
      currentPhase = "ESCALATE";
      openAlerts = ["requires_human_review", "safety:dependency"];
      policyHistory = appendPolicyHistory(
        policyHistory,
        currentPhase,
        "Change-approval leash blocked a dependency or migration boundary.",
        attemptCompletedAt
      );
      const rollbackOutcome = await restoreRollbackBoundary({
        repoRoot: request.context.repoRoot,
        boundary: rollbackBoundary,
        restoredAt: attemptCompletedAt,
        decision: patchDecision.decision,
        changedFiles,
        allowedPaths: request.context.allowedPaths
      });

      if (input.store) {
        await input.store.writeAttemptArtifacts(loop.loopId, currentAttemptIndex, {
          compiledContext,
          ...(verificationPlanArtifact ? { verificationPlan: verificationPlanArtifact } : {}),
          ...(result.execution?.baseline ? { baseline: result.execution.baseline } : {}),
          ...(result.execution?.gitNormalization
            ? { gitNormalization: result.execution.gitNormalization }
            : {}),
          ...(result.execution?.scopeSurface ? { scopeSurface: result.execution.scopeSurface } : {}),
          ...(patchDiff ? { diff: patchDiff } : {}),
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
            payload: {
              lifecycleState: approvalExitDecision.lifecycleState,
              status: approvalExitDecision.status,
              reason: approvalExitDecision.reason
            }
          })
        );
      }

      const finalizedLoop = finalizeLoop(loop, approvalExitDecision, now(), idFactory);
      await persistMachineState(input.store, finalizedLoop.loopId, {
        loop: finalizedLoop,
        phase: currentPhase,
        activeModel: executingAdapter.metadata.model,
        currentAttempt: currentAttemptIndex,
        lastVerifierScore: result.verification.passed ? 1 : 0,
        policyHistory,
        openAlerts
      });

      return {
        loop: finalizedLoop,
        decision: approvalExitDecision
      };
    }

    // VERIFY: Run grounding scan on patch diff if available
    // Uses the task's repoRoot to build/load the grounding index, then scans any diff
    let groundingScanResult: GroundingScanResult | undefined;
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

    // CVE scan — block attempt if patch introduces HIGH/CRITICAL vulnerabilities
    if (patchDiff) {
      try {
        const cveScan = await _scanDiffForCves(patchDiff);
        if (cveScan.blocked && cveScan.blockReason) {
          if (input.store) {
            await input.store.appendLedger(
              loop.loopId,
              makeLedgerEvent({
                kind: "safety.violations_found",
                runId: loop.loopId,
                attemptIndex: currentAttemptIndex,
                payload: {
                  source: "cve-scanner",
                  count: cveScan.matches.filter(m => m.severity === "HIGH" || m.severity === "CRITICAL").length,
                  blockReason: cveScan.blockReason
                }
              })
            );
          }
          failure = {
            failureClass: "environment_mismatch",
            rationale: cveScan.blockReason,
            retryable: false,
            recommendedIntervention: "stop_loop"
          };
        }
      } catch {
        // CVE scan is best-effort — never fail the loop on scan errors
      }
    }

    let patchDecision: EvaluatedPatchDecision | undefined;
    if (result.status === "completed") {
      const completionClaimed = containsPositive(
        result.summary?.toLowerCase() ?? "",
        ["fix", "fixed", "resolve", "resolved", "completed"]
      );
      const claimAudit = auditClaimEvidence({
        summary: result.summary,
        changedFiles: changedFileEvidenceAvailable ? changedFiles : undefined,
        patchDiff
      });
      
      const assertionPattern = /expect\(.*\)\.to/i;
      const deletedAssertions = patchDiff ? (patchDiff.match(/^\-(?!\-\-).*/gm) ?? []).filter(line => assertionPattern.test(line)).length : 0;
      const addedAssertions = patchDiff ? (patchDiff.match(/^\+(?!\+\+).*/gm) ?? []).filter(line => assertionPattern.test(line)).length : 0;
      
      const verifierScore = result.verification.passed ? 1 : 0;
      const streamTrapResult = scanStreamsForTraps(
        result.execution?.stdout ?? "",
        result.execution?.stderr ?? "",
        { exitCode: result.execution?.exitCode ?? 0, verifierPassed: result.verification.passed }
      );

      patchDecision = evaluatePatchDecision({
        verificationPassed: result.verification.passed,
        previousVerifierScore,
        verifierScore,
        groundingViolationCount: groundingScanResult?.violations.length ?? 0,
        groundingEvasionCount: groundingScanResult?.violations.filter(v => v.kind === "grounding_evasion_attempt").length ?? 0,
        untrackedFileCount: groundingScanResult?.violations.filter(v => v.kind === "untracked_file_creation").length ?? 0,
        inventedDependencyRisk: groundingScanResult?.violations.some(v => v.kind === "invented_dependency_risk"),
        severityStreamTrap: streamTrapResult.isTrap,
        deterministicRegression: (previousVerifierScore === 1 && !result.verification.passed) || (result.execution?.exitCode !== undefined && result.execution.exitCode !== 0 && (result.execution?.stdout ?? "").toLowerCase().includes("error")),
        stochasticRegression: previousVerifierScore > 0 && verifierScore < (previousVerifierScore - 0.05),
        changedFileCount: changedFileEvidenceAvailable ? changedFiles.length : undefined,
        diffNovelty: changedFileEvidenceAvailable ? (changedFiles.length > 0 ? 1 : 0) : undefined,
        diffStats: result.execution?.diffStats,
        costUsd: getUsageUsd(result.usage),
        summary: result.summary,
        substantiveLineCount: claimAudit.substantiveLineCount,
        isTestAssertionDeletion: deletedAssertions > 0 && addedAssertions === 0,
        controlDirectiveViolationCount: groundingScanResult?.violations.filter(v => v.kind === "control_directive_violation").length ?? 0,
        oscillationDetected: detectOscillation(loop.attempts),
        claimContradictsDiff:
          completionClaimed &&
          claimAudit.substantiveLineCount === 0 &&
          (patchDiff?.includes("+") ?? false),
        claimContradictsVerifier: completionClaimed && !result.verification.passed,
        claimContradictionNoEvidence:
          completionClaimed &&
          claimAudit.findings.some(
          (finding) => finding.reasonCode === "claim_contradiction_no_evidence"
        ),
        claimContradictionFileEvidence: claimAudit.findings.some(
          (finding) => finding.reasonCode === "claim_contradiction_missing_file_evidence"
        ),
        lowEvidenceResponse: claimAudit.findings.some(
          (finding) => finding.reasonCode === "low_evidence_response"
        )
      });
    }

    let rollbackOutcome: RollbackOutcomeArtifact | undefined;
    if (patchDecision && patchDecision.decision !== "KEEP") {
      rollbackOutcome = await restoreRollbackBoundary({
        repoRoot: request.context.repoRoot,
        boundary: rollbackBoundary,
        restoredAt: attemptCompletedAt,
        decision: patchDecision.decision,
        changedFiles,
        allowedPaths: request.context.allowedPaths
      });
    } else if (result.status === "failed") {
      rollbackOutcome = await restoreRollbackBoundary({
        repoRoot: request.context.repoRoot,
        boundary: rollbackBoundary,
        restoredAt: attemptCompletedAt,
        decision: "DISCARD",
        changedFiles,
        allowedPaths: request.context.allowedPaths
      });
    }

    if (input.store) {
      await input.store.writeAttemptArtifacts(loop.loopId, currentAttemptIndex, {
        compiledContext,
        ...(verificationPlanArtifact ? { verificationPlan: verificationPlanArtifact } : {}),
        ...(result.execution?.baseline ? { baseline: result.execution.baseline } : {}),
        ...(result.execution?.gitNormalization
          ? { gitNormalization: result.execution.gitNormalization }
          : {}),
        ...(result.execution?.scopeSurface ? { scopeSurface: result.execution.scopeSurface } : {}),
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
            kind: result.verification.passed ? "attempt.kept" : "attempt.discarded",
            runId: loop.loopId,
            attemptIndex: currentAttemptIndex,
            payload: { reason: result.verification.summary }
          })
        );
      }
    }

    // Stream detector hook — advisory, never blocks the loop
    if (input.onAttemptSignal) {
      try {
        const attemptKept = patchDecision
          ? patchDecision.decision === "KEEP"
          : result.verification.passed;
        input.onAttemptSignal({
          attemptIndex: currentAttemptIndex,
          failureClass: attemptKept ? undefined : failure?.failureClass,
          costUsdSoFar: loop.cost.actualUsd,
          groundingViolations: groundingScanResult?.violations.length ?? 0,
          kept: attemptKept
        });
      } catch {
        // Advisory hook — swallow errors to preserve loop stability
      }
    }

    if (patchDecision && patchDecision.decision !== "KEEP" && !failure) {
      failure = classifyPatchDecisionFailure(patchDecision);
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
      currentPhase = patchDecision.decision === "HANDOFF" ? "HANDOFF" : "ESCALATE";
      openAlerts = currentPhase === "HANDOFF" ? [] : ["requires_human_review"];
      policyHistory = appendPolicyHistory(
        policyHistory,
        currentPhase,
        "Patch truth requested terminal handoff or escalation.",
        now()
      );
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
            payload: {
              lifecycleState: patchExitDecision.lifecycleState,
              status: patchExitDecision.status,
              reason: patchExitDecision.reason
            }
          })
        );
      }

      const finalizedLoop = finalizeLoop(loop, patchExitDecision, now(), idFactory);
      await persistMachineState(input.store, finalizedLoop.loopId, {
        loop: finalizedLoop,
        phase: currentPhase,
        activeModel: currentAdapter.metadata.model,
        currentAttempt: currentAttemptIndex,
        lastVerifierScore: getLastVerifierScore(finalizedLoop),
        policyHistory,
        openAlerts
      });

      if (patchDecision.decision === "HANDOFF" && request.context.repoRoot && patchDiff) {
        const finalGate = await validateFinalHandoff({
          repoRoot: request.context.repoRoot,
          patchDiff,
          allowedPaths: request.context.allowedPaths
        });
        
        if (!finalGate.passed) {
          const semanticFailureDecision: ExitDecision = {
            shouldExit: true,
            lifecycleState: "human_escalation",
            status: "exited",
            reason: `Final-Gate Semantic Verification failed: ${finalGate.violations.length} critical grounding violations detected.`
          };
          currentPhase = "ESCALATE";
          openAlerts = ["requires_human_review", "grounding:final_gate_failed"];
          
          if (input.store) {
            await input.store.writeAttemptArtifacts(loop.loopId, currentAttemptIndex, {
              finalSemanticVerification: finalGate
            });
            await input.store.appendLedger(loop.loopId, makeLedgerEvent({
              kind: "grounding.violations_found",
              runId: loop.loopId,
              attemptIndex: currentAttemptIndex,
              payload: { 
                gate: "final",
                violationCount: finalGate.violations.length,
                violations: finalGate.violations
              }
            }));
          }
          
          const escalatedLoop = finalizeLoop(loop, semanticFailureDecision, now(), idFactory);
          await persistMachineState(input.store, escalatedLoop.loopId, {
            loop: escalatedLoop,
            phase: currentPhase,
            activeModel: currentAdapter.metadata.model,
            currentAttempt: currentAttemptIndex,
            lastVerifierScore: getLastVerifierScore(escalatedLoop),
            policyHistory,
            openAlerts
          });
          return { loop: escalatedLoop, decision: semanticFailureDecision };
        }
      }

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
      canSwitchAdapter: hasRecoveryPath && currentRecoveryPath.adapterIndex !== executingRecoveryPath.adapterIndex,
      canChangeModel: hasRecoveryPath && currentRecoveryPath.adapterIndex === executingRecoveryPath.adapterIndex && modelChanged,
      hasRecoveryPath
    });

    // Advance phase based on result
    currentPhase = nextPolicyPhase(currentPhase, effectiveResult, costState, phaseRetryCount);
    if (failure) phaseRetryCount++;
    else phaseRetryCount = 0;
    openAlerts = buildOpenAlerts({
      currentPhase,
      costState,
      failureClass: failure?.failureClass,
      verifierPassed: effectiveResult.verification.passed,
      patternIds: streamingPatterns.map((pattern) => pattern.patternId)
    });
    policyHistory = appendPolicyHistory(
      policyHistory,
      currentPhase,
      describeNextPhase(currentPhase, costState, failure),
      now()
    );
    await persistMachineState(input.store, loop.loopId, {
      loop,
      phase: currentPhase,
      activeModel: currentAdapter.metadata.model,
      currentAttempt: currentAttemptIndex,
      lastVerifierScore: getLastVerifierScore(loop),
      policyHistory,
      openAlerts
    });

    if (decision.shouldExit) {
      if (input.store) {
        await input.store.appendLedger(
          loop.loopId,
          makeLedgerEvent({
            kind: "run.exited",
            runId: loop.loopId,
            payload: {
              lifecycleState: decision.lifecycleState,
              status: decision.status,
              reason: decision.reason
            }
          })
        );
      }
      const finalizedLoop = finalizeLoop(loop, decision, now(), idFactory);
      await persistMachineState(input.store, finalizedLoop.loopId, {
        loop: finalizedLoop,
        phase: currentPhase,
        activeModel: currentAdapter.metadata.model,
        currentAttempt: currentAttemptIndex,
        lastVerifierScore: getLastVerifierScore(finalizedLoop),
        policyHistory,
        openAlerts
      });
      await recordLoopMemory({
        input,
        loop: finalizedLoop,
        decision
      });
      return {
        loop: finalizedLoop,
        decision,
        routingEvidence: activeRoutingEvidence
      };
    }
  }

  currentPhase = "ABORT";
  openAlerts = ["budget:iteration_exhausted"];
  policyHistory = appendPolicyHistory(
    policyHistory,
    currentPhase,
    "Iteration budget exhausted before the run could complete.",
    now()
  );
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
        payload: {
          lifecycleState: decision.lifecycleState,
          status: decision.status,
          reason: decision.reason
        }
      })
    );
  }

  const finalizedLoop = finalizeLoop(loop, decision, now(), idFactory);
  await persistMachineState(input.store, finalizedLoop.loopId, {
    loop: finalizedLoop,
    phase: currentPhase,
    activeModel: currentAdapter.metadata.model,
    currentAttempt: loop.attempts.length,
    lastVerifierScore: getLastVerifierScore(finalizedLoop),
    policyHistory,
    openAlerts
  });
  await recordLoopMemory({
    input,
    loop: finalizedLoop,
    decision
  });

  return {
    loop: finalizedLoop,
    decision,
    routingEvidence: activeRoutingEvidence
  };
}

function withAuditedRunStore(input: RunMartinInput): RunMartinInput {
  if (!input.store || !input.auditExporter) {
    return input;
  }

  const store = input.store;
  const auditExporter = input.auditExporter;
  const auditedStore: RunStore = {
    initRun(contract) {
      return store.initRun(contract);
    },
    updateState(runId, state) {
      return store.updateState(runId, state);
    },
    async appendLedger(runId, event) {
      await store.appendLedger(runId, event);
      auditExporter.emit(toAuditEvent(event));
    },
    writeAttemptArtifacts(runId, attemptIndex, artifacts) {
      return store.writeAttemptArtifacts(runId, attemptIndex, artifacts);
    },
    linkChildRun(parentRunId, childCostUsd) {
      return store.linkChildRun(parentRunId, childCostUsd);
    }
  };
  if (store.persistLoopRecord) {
    auditedStore.persistLoopRecord = (loop) => store.persistLoopRecord?.(loop) ?? Promise.resolve();
  }

  return {
    ...input,
    store: auditedStore
  };
}

async function recallLoopMemory(input: {
  input: RunMartinInput;
  loop: LoopRecord;
  focus: string;
  attemptIndex: number;
}): Promise<MemoryBrief | undefined> {
  if (!input.input.memoryStore) {
    return undefined;
  }

  try {
    return await input.input.memoryStore.recall({
      workspaceId: input.loop.workspaceId,
      projectId: input.loop.projectId,
      objective: input.loop.task.objective,
      focus: input.focus,
      previousAttempts: input.loop.attempts,
      currentRunId: input.loop.loopId,
      currentAttemptIndex: input.attemptIndex,
      limit: 3
    });
  } catch {
    return undefined;
  }
}

async function recordLoopMemory(input: {
  input: RunMartinInput;
  loop: LoopRecord;
  decision: ExitDecision;
}): Promise<void> {
  if (!input.input.memoryStore) {
    return;
  }

  try {
    await input.input.memoryStore.recordLoop({
      loop: input.loop,
      status: input.decision.status,
      lifecycleState: input.decision.lifecycleState,
      reason: input.decision.reason
    });
  } catch {
    // Memory is an optimization signal; a failed write must not hide the terminal run outcome.
  }
}

function toAuditEvent(event: LedgerEvent): AuditEvent {
  return {
    eventKind: event.kind,
    runId: event.runId,
    ...(event.attemptIndex !== undefined ? { attemptIndex: event.attemptIndex } : {}),
    payload: event.payload,
    timestamp: event.timestamp
  };
}

function finalizeLoop(
  loop: LoopRecord,
  decision: ExitDecision,
  timestamp: string,
  idFactory?: (prefix: string) => string
): LoopRecord {
  const finalized = appendLoopEvent(
    loop,
    {
      type: "run.completed",
      lifecycleState: decision.lifecycleState,
      payload: { status: decision.status, reason: decision.reason }
    },
    { now: timestamp, idFactory }
  );

  return {
    ...finalized,
    status: decision.status,
    lifecycleState: decision.lifecycleState,
    updatedAt: timestamp
  };
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

function resolveChangedFiles(
  result: MartinAdapterResult,
  repoRoot?: string,
  observedChangedFiles?: string[]
): string[] {
  if (observedChangedFiles !== undefined && observedChangedFiles.length > 0) {
    return uniqueSortedPaths(observedChangedFiles);
  }

  if (result.execution?.changedFiles?.length) {
    return uniqueSortedPaths(result.execution.changedFiles);
  }

  if (observedChangedFiles !== undefined) {
    return [];
  }

  if (!repoRoot) {
    return [];
  }

  try {
    const diff = spawnSync("git", ["diff", "--name-only", "HEAD"], {
      cwd: repoRoot,
      encoding: "utf8",
      timeout: 10_000
    });
    const untracked = spawnSync("git", ["ls-files", "--others", "--exclude-standard"], {
      cwd: repoRoot,
      encoding: "utf8",
      timeout: 10_000
    });

    if (
      diff.status !== 0 ||
      typeof diff.stdout !== "string" ||
      untracked.status !== 0 ||
      typeof untracked.stdout !== "string"
    ) {
      return [];
    }

    return uniqueSortedPaths([
      ...`${diff.stdout}\n${untracked.stdout}`.split(/\r?\n/u)
    ]);
  } catch {
    return [];
  }
}

function buildPatchDiff(
  result: MartinAdapterResult,
  changedFiles: string[],
  observedPatchDiff?: string,
  observedEvidenceAvailable = false
): string | undefined {
  const normalizedObservedPatchDiff = observedPatchDiff?.trim();
  if (normalizedObservedPatchDiff) {
    return normalizedObservedPatchDiff;
  }

  if (observedEvidenceAvailable) {
    return changedFiles.length > 0
      ? changedFiles
          .map((file) => `--- a/${file}\n+++ b/${file}\n@@ -1,0 +1,0 @@`)
          .join("\n")
      : undefined;
  }

  const explicitPatchDiff = result.execution?.patchDiff?.trim();
  if (explicitPatchDiff) {
    return explicitPatchDiff;
  }

  // Use structured diff stats to build a minimal diff header if no raw diff is available
  if (result.execution?.changedFiles?.length) {
    return result.execution.changedFiles
      .map((file) => `--- a/${file}\n+++ b/${file}\n@@ -1,0 +1,0 @@`)
      .join("\n");
  }
  if (changedFiles.length > 0) {
    return changedFiles
      .map((file) => `--- a/${file}\n+++ b/${file}\n@@ -1,0 +1,0 @@`)
      .join("\n");
  }
  return undefined;
}

function uniqueSortedPaths(values: string[]): string[] {
  return [...new Set(values.map((entry) => entry.trim().replace(/\\/gu, "/")).filter(Boolean))].sort();
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
    totalActualUsd,
    preflightEstimateUsd: input.estimate.estimatedAttemptCostUsd,
    varianceUsd: roundUsd(totalActualUsd - input.estimate.estimatedAttemptCostUsd),
    settledAt: input.settledAt
  };
}

function roundUsd(value: number): number {
  return Math.round(value * 100) / 100;
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function buildProbeFileHints(task: LoopTask): string[] {
  return [...new Set([...(task.allowedPaths ?? []), ...(task.deniedPaths ?? []).map((path) => `avoid:${path}`)])]
    .slice(0, 12);
}

function serializeEntryProbe(probe: Exclude<EntryProbeOutcome, { status: "skipped" }>): Record<string, unknown> {
  return {
    status: probe.status,
    route: probe.route,
    reason: probe.reason,
    primaryModel: probe.primaryModel,
    initialModel: probe.initialModel,
    probeModel: probe.probeModel,
    usage: probe.usage,
    startedAt: probe.startedAt,
    completedAt: probe.completedAt,
    adapterId: probe.adapterId,
    providerId: probe.providerId,
    ...(probe.status === "completed" ? { tier: probe.tier } : {})
  };
}

async function persistMachineState(
  store: RunStore | undefined,
  runId: string,
  input: PersistStateInput
): Promise<void> {
  if (!store) {
    return;
  }

  await store.updateState(runId, buildMachineState(input));
  await store.persistLoopRecord?.(input.loop);
}

function buildMachineState(input: PersistStateInput): MachineState {
  return {
    phase: input.phase,
    currentAttempt: input.currentAttempt,
    activeModel: input.activeModel,
    remainingBudgetUsd: roundUsd(input.loop.budget.maxUsd - input.loop.cost.actualUsd),
    attemptCountersBySurface: countAttemptsByFailureSurface(input.loop.attempts),
    lastFailureSurface: getLastFailureSurface(input.loop.attempts),
    lastVerifierScore: input.lastVerifierScore ?? getLastVerifierScore(input.loop),
    openAlerts: input.openAlerts ?? [],
    policyHistory: input.policyHistory
  };
}

function countAttemptsByFailureSurface(
  attempts: LoopAttempt[]
): Record<string, number> {
  const counts: Record<string, number> = {};

  for (const attempt of attempts) {
    if (!attempt.failureClass) {
      continue;
    }

    counts[attempt.failureClass] = (counts[attempt.failureClass] ?? 0) + 1;
  }

  return counts;
}

function getLastFailureSurface(
  attempts: LoopAttempt[]
): FailureClass | undefined {
  for (let index = attempts.length - 1; index >= 0; index -= 1) {
    const failureClass = attempts[index]?.failureClass;
    if (failureClass) {
      return failureClass;
    }
  }

  return undefined;
}

function appendPolicyHistory(
  history: MachineState["policyHistory"],
  phase: PolicyPhase,
  reason: string,
  timestamp: string
): MachineState["policyHistory"] {
  const lastEntry = history.at(-1);
  if (
    lastEntry?.phase === phase &&
    lastEntry.reason === reason &&
    lastEntry.timestamp === timestamp
  ) {
    return history;
  }

  return [...history, { phase, reason, timestamp }];
}

function buildOpenAlerts(input: {
  currentPhase: PolicyPhase;
  costState: CostGovernorState;
  failureClass?: FailureClass;
  verifierPassed: boolean;
  patternIds?: LoopPatternId[];
}): string[] {
  const alerts = new Set<string>();

  if (input.costState.pressure !== "healthy") {
    alerts.add(`budget:${input.costState.pressure}`);
  }
  if (!input.verifierPassed) {
    alerts.add("verification:failed");
  }
  if (input.failureClass) {
    alerts.add(`failure:${input.failureClass}`);
  }
  if (input.currentPhase === "ESCALATE") {
    alerts.add("requires_human_review");
  }
  if (input.currentPhase === "ABORT") {
    alerts.add("loop_aborted");
  }
  for (const patternId of input.patternIds ?? []) {
    alerts.add(`pattern:${patternId}`);
  }

  return [...alerts];
}

function describeNextPhase(
  phase: PolicyPhase,
  costState: CostGovernorState,
  failure?: FailureAssessment
): string {
  if (phase === "HANDOFF") {
    return "Verification passed and the loop is ready to hand off a completed result.";
  }
  if (phase === "ABORT") {
    return costState.shouldStop
      ? "Budget pressure reached a hard stop and aborted the loop."
      : "Loop transitioned into abort after exhausting the allowed recovery path.";
  }
  if (phase === "ESCALATE") {
    return "Loop requires human review after repeated failures or conflicting evidence.";
  }
  if (phase === "RECOVER") {
    return failure
      ? `Preparing a recovery attempt after ${failure.failureClass}.`
      : "Preparing a recovery attempt after verification did not complete cleanly.";
  }
  if (phase === "PATCH") {
    return "Recovered context is ready for the next bounded patch attempt.";
  }
  if (phase === "VERIFY") {
    return "Patch attempt finished and Martin is evaluating verification evidence.";
  }
  if (phase === "ADMIT") {
    return "Martin is evaluating whether the next attempt should be admitted.";
  }

  return "Martin is gathering the next bounded attempt.";
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
  if (decision.surface === "command" && decision.violations.length === 0) {
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
    policyVerdict?: PolicyLeashVerdict;
  },
  attemptIndex: number
): Record<string, unknown> {
  return {
    attemptIndex,
    surface: decision.surface,
    blocked: true,
    ...(decision.profile ? { profile: decision.profile } : {}),
    ...(decision.reason ? { reason: decision.reason } : {}),
    ...serializePolicyVerdict(decision),
    violations: decision.violations
  };
}

function serializePolicyVerdict(decision: { policyVerdict?: PolicyLeashVerdict }): {
  policyVerdict?: PolicyLeashVerdict;
} {
  if (!decision.policyVerdict) {
    return {};
  }

  return {
    policyVerdict: decision.policyVerdict
  };
}

function buildPolicyLeashOptions(input: RunMartinInput): PolicyLeashOptions {
  return {
    ...(input.policyPath ? { policyPath: input.policyPath } : {}),
    ...(input.policyWasmPath ? { policyWasmPath: input.policyWasmPath } : {}),
    ...(input.task.repoRoot ? { repoRoot: input.task.repoRoot } : {})
  };
}

function buildVerificationPolicyInputs(task: LoopTask): Array<{
  surface: "command";
  command: string;
  path: "";
}> {
  return [
    ...(task.verificationPlan ?? []),
    ...((task.verificationStack ?? []).map((step) => step.command))
  ]
    .filter((command) => command.trim().length > 0)
    .map((command) => ({
      surface: "command" as const,
      command,
      path: ""
    }));
}

interface SynthesizedVerificationPlanArtifact extends RiskTierVerificationPlan {
  schemaVersion: "martin.verification-plan.v1";
  attemptIndex: number;
  riskTier: "low" | "medium" | "high" | "critical";
  blastRadiusScore: number;
  requiredCommands: string[];
  optionalCommands: string[];
  summary: string;
}

async function synthesizeAttemptVerificationPlan(input: {
  loop: LoopRecord;
  task: LoopTask;
  attemptIndex: number;
  changedFiles: string[];
  executionProfile: ExecutionProfile;
  repoRoot?: string;
}): Promise<SynthesizedVerificationPlanArtifact> {
  const requiredCommands = uniqueCommands([
    ...input.task.verificationPlan,
    ...((input.task.verificationStack ?? [])
      .filter((step) => step.fastFail !== false)
      .map((step) => step.command))
  ]);
  const optionalCommands = uniqueCommands(
    (input.task.verificationStack ?? [])
      .filter((step) => step.fastFail === false)
      .map((step) => step.command)
  ).filter((command) => !requiredCommands.includes(command));
  const claimSurfaceTouched = touchesClaimSurface(input.changedFiles);
  const privilegedAction = isPrivilegedAction(input.task, input.changedFiles, input.executionProfile);
  const securitySensitive = isSecuritySensitive(input.task, input.changedFiles);
  const blastRadiusScore = await resolveVerificationBlastRadiusScore({
    objective: input.task.objective,
    repoRoot: input.repoRoot,
    changedFiles: input.changedFiles,
    claimSurfaceTouched,
    privilegedAction,
    securitySensitive
  });
  const riskTier = classifyVerificationRiskTier(blastRadiusScore);
  const plan = buildRiskTierVerificationPlan({
    scenarioId: `${input.loop.loopId}:attempt-${String(input.attemptIndex).padStart(3, "0")}`,
    riskTier,
    blastRadiusScore,
    claimSurfaceTouched,
    privilegedAction,
    securitySensitive
  });

  return {
    schemaVersion: "martin.verification-plan.v1",
    attemptIndex: input.attemptIndex,
    riskTier,
    blastRadiusScore,
    ...plan,
    requiredCommands,
    optionalCommands,
    summary: [
      `${plan.tier} verification`,
      `${plan.mustPassAll ? "must pass all required checks" : "permits best-effort optional checks"}`,
      `${String(requiredCommands.length)} required command(s)`,
      `${String(optionalCommands.length)} optional command(s)`,
      `${String(plan.requiredVerifiers.length)} verifier role(s)`,
      `blast radius ${String(blastRadiusScore)}/100`
    ].join(", ")
  };
}

async function resolveVerificationBlastRadiusScore(input: {
  objective: string;
  repoRoot?: string;
  changedFiles: string[];
  claimSurfaceTouched: boolean;
  privilegedAction: boolean;
  securitySensitive: boolean;
}): Promise<number> {
  if (input.repoRoot) {
    try {
      const blastRadius = await estimateBlastRadius({
        objective: input.objective,
        repoRoot: input.repoRoot,
        currentFiles: input.changedFiles
      });
      return blastRadius.score;
    } catch {
      // Fall through to heuristic scoring below.
    }
  }

  let score = 10;
  score += Math.min(input.changedFiles.length * 8, 32);
  if (input.claimSurfaceTouched) score += 18;
  if (input.securitySensitive) score += 22;
  if (input.privilegedAction) score += 28;
  return Math.max(0, Math.min(100, score));
}

function classifyVerificationRiskTier(score: number): SynthesizedVerificationPlanArtifact["riskTier"] {
  if (score >= 80) return "critical";
  if (score >= 60) return "high";
  if (score >= 35) return "medium";
  return "low";
}

function touchesClaimSurface(changedFiles: string[]): boolean {
  return changedFiles.some((file) =>
    /^(readme\.md|docs\/|benchmarks\/results\/|claims\/|audit-report\.md|external_audit\.md|gate-check-results\.json|known-bad-world-results\.json|case-study-results\.json)/iu.test(
      file.replace(/\\/g, "/")
    )
  );
}

function isPrivilegedAction(
  task: LoopTask,
  changedFiles: string[],
  executionProfile: ExecutionProfile
): boolean {
  if (executionProfile !== "strict_local") {
    return true;
  }

  if (
    task.approvalPolicy?.dependencyAdds ||
    task.approvalPolicy?.migrations ||
    task.approvalPolicy?.configChanges ||
    task.approvalPolicy?.externalWrites
  ) {
    return true;
  }

  return changedFiles.some((file) =>
    /(^|\/)(package\.json|pnpm-lock\.yaml|bun\.lockb|bun\.lock|vercel\.json|dockerfile|docker-compose|compose\.ya?ml|.*\.sql|migrations?\/|\.github\/workflows\/)/iu.test(
      file.replace(/\\/g, "/")
    )
  );
}

function isSecuritySensitive(task: LoopTask, changedFiles: string[]): boolean {
  if (/\b(auth|security|policy|billing|vault|telemetry|token|receipt|mandate)\b/iu.test(task.objective)) {
    return true;
  }

  return changedFiles.some((file) =>
    /(^|\/)(auth|security|policy|billing|vault|telemetry|receipts?|mandates?)(\/|$)/iu.test(
      file.replace(/\\/g, "/")
    )
  );
}

function uniqueCommands(commands: string[]): string[] {
  return [...new Set(commands.map((command) => command.trim()).filter((command) => command.length > 0))];
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

function toPatchDecisionArtifact(decision: EvaluatedPatchDecision): PatchDecisionArtifact {
  return {
    decision: decision.decision,
    summary: decision.summary,
    reasonCodes: decision.reasonCodes
  };
}

function classifyPatchDecisionFailure(decision: EvaluatedPatchDecision): FailureAssessment {
  if (
    decision.reasonCodes.includes("claim_contradiction_comment_only") ||
    decision.reasonCodes.includes("claim_contradiction_hidden_failure") ||
    decision.reasonCodes.includes("claim_contradiction_no_evidence") ||
    decision.reasonCodes.includes("claim_contradiction_missing_file_evidence")
  ) {
    return {
      failureClass: "claim_contradiction",
      rationale:
        "Patch truth discarded the attempt because the completion claim contradicted repo-backed change evidence.",
      retryable: true,
      recommendedIntervention: "tighten_task"
    };
  }

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

function countPriorSurfaceRetries(attempts: LoopAttempt[], failureClass: FailureClass): number {
  return attempts.filter((attempt) => attempt.failureClass === failureClass).length;
}

/**
 * Tier 2 Semantic Verification (Final-Gate).
 * Performs a deep, full-index grounding scan before terminal acceptance.
 */
async function validateFinalHandoff(input: {
  repoRoot: string;
  patchDiff: string;
  allowedPaths?: string[];
}): Promise<{ passed: boolean; violations: GroundingViolation[] }> {
  try {
    const index = await loadOrBuildRepoGroundingIndex(input.repoRoot);
    const result = scanPatchForGroundingViolations(input.patchDiff, index, {
      allowedPaths: input.allowedPaths
    });
    
    // Final gate is stricter: any symbol_not_found or file_not_found is a hard block
    const criticalViolations = result.violations.filter(v => 
      v.kind === "symbol_not_found" || 
      v.kind === "file_not_found" ||
      v.kind === "control_directive_violation" ||
      v.kind === "test_assertion_deletion"
    );
    
    return {
      passed: criticalViolations.length === 0,
      violations: criticalViolations
    };
  } catch {
    // Best-effort if index fails, but in H2 we want to be cautious
    return { passed: true, violations: [] };
  }
}

function selectStrongerIntervention(
  primary: InterventionType,
  candidate: InterventionType
): InterventionType {
  const priority: Record<InterventionType, number> = {
    compress_context: 0,
    run_verifier: 1,
    tighten_task: 2,
    change_model: 3,
    switch_adapter: 4,
    escalate_human: 5,
    stop_loop: 6
  };

  return priority[candidate] > priority[primary] ? candidate : primary;
}

interface RecoveryPath {
  key: string;
  adapterIndex: number;
  matrixIndex: number;
  adapter: MartinAdapter;
  model: string;
}

function buildRecoveryMatrix(input: {
  adapterChain: MartinAdapter[];
  fallbackModels: string[];
}): RecoveryPath[] {
  const recoveryPaths: RecoveryPath[] = [];

  input.adapterChain.forEach((adapter, adapterIndex) => {
    const supportedModels = adapter.withModel
      ? uniqueModels([adapter.metadata.model, ...input.fallbackModels])
      : [adapter.metadata.model];

    supportedModels.forEach((model) => {
      recoveryPaths.push(
        createRecoveryPath({
          adapter,
          adapterIndex,
          matrixIndex: recoveryPaths.length,
          model
        })
      );
    });
  });

  return recoveryPaths;
}

function createRecoveryPath(input: {
  adapter: MartinAdapter;
  adapterIndex: number;
  matrixIndex: number;
  model: string;
}): RecoveryPath {
  return {
    key: `${input.adapterIndex}::${input.model}`,
    adapterIndex: input.adapterIndex,
    matrixIndex: input.matrixIndex,
    adapter:
      input.adapter.metadata.model === input.model || !input.adapter.withModel
        ? input.adapter
        : input.adapter.withModel(input.model),
    model: input.model
  };
}

interface RoutingSignals {
  blastRadius?: BlastRadiusResult;
  trustProfiles: ModelTrustProfile[];
}

const trustCalibrationCache = new Map<string, Promise<ModelTrustProfile[]>>();

async function resolveRoutingSignals(input: RunMartinInput): Promise<RoutingSignals> {
  const blastRadius =
    input.blastRadius !== undefined
      ? normalizeBlastRadius(input.blastRadius)
      : input.task.repoRoot
        ? await withTimeout(
            estimateBlastRadius({
              objective: input.task.objective,
              repoRoot: input.task.repoRoot
            }),
            undefined,
            2_000
          )
        : undefined;

  const trustProfiles =
    input.trustProfiles ?? (blastRadius && blastRadius.score > 70
      ? []
      : await getCachedTrustProfiles(resolveRunsRoot()));

  return {
    ...(blastRadius ? { blastRadius } : {}),
    trustProfiles
  };
}

function getCachedTrustProfiles(runsRoot: string): Promise<ModelTrustProfile[]> {
  const cached = trustCalibrationCache.get(runsRoot);
  if (cached) return cached;

  const next = withTimeout(
    calibrateTrust(runsRoot).then((result) => result.profiles),
    [],
    2_000
  );
  trustCalibrationCache.set(runsRoot, next);
  return next;
}

function selectInitialRecoveryPath(input: {
  recoveryMatrix: RecoveryPath[];
  currentPath: RecoveryPath;
  blastRadius?: BlastRadiusResult;
  trustProfiles: ModelTrustProfile[];
}): { path: RecoveryPath; evidence: RoutingEvidence } {
  const candidates = input.recoveryMatrix.length > 0
    ? input.recoveryMatrix
    : [input.currentPath];
  const defaultEvidence = createRoutingEvidence(
    input.currentPath,
    "primary",
    "Selected the configured primary route.",
    input.blastRadius
  );

  const evidenceBackedCandidates = candidates.filter((path) => {
    const profile = findTrustProfileForModel(input.trustProfiles, path.model);
    return !profile || !shouldDeprioritize(profile);
  });
  const viableCandidates =
    evidenceBackedCandidates.length > 0 ? evidenceBackedCandidates : candidates;

  if (input.blastRadius && input.blastRadius.score > 70) {
    const highTrust = viableCandidates.filter((path) => trustTierForModel(path.model) === "high");
    const selected = cheapestPath(highTrust.length > 0 ? highTrust : viableCandidates);
    return {
      path: selected,
      evidence: createRoutingEvidence(
        selected,
        "blast_radius",
        `Selected high-trust route because blast radius is ${String(input.blastRadius.score)}/100.`,
        input.blastRadius
      )
    };
  }

  const currentProfile = findTrustProfileForModel(input.trustProfiles, input.currentPath.model);
  if (currentProfile && shouldDeprioritize(currentProfile)) {
    const selected = bestNominalPath(viableCandidates);
    return {
      path: selected,
      evidence: createRoutingEvidence(
        selected,
        "deprioritized_model",
        `Skipped ${input.currentPath.model} because historical completion rate is ${String(Math.round(currentProfile.completionRate * 100))}% across ${String(currentProfile.runsObserved)} runs.`,
        input.blastRadius,
        currentProfile
      )
    };
  }

  const currentCost = estimatedPathCost(input.currentPath);
  const trustedCheaper = viableCandidates
    .map((path) => ({
      path,
      profile: findTrustProfileForModel(input.trustProfiles, path.model)
    }))
    .filter((item): item is { path: RecoveryPath; profile: ModelTrustProfile } => {
      const profile = item.profile;
      return (
        profile !== undefined &&
        profile.runsObserved >= 3 &&
        profile.efficiencyScore > 0.85 &&
        estimatedPathCost(item.path) < currentCost
      );
    })
    .sort((a, b) => estimatedPathCost(a.path) - estimatedPathCost(b.path))[0];

  if (trustedCheaper) {
    return {
      path: trustedCheaper.path,
      evidence: createRoutingEvidence(
        trustedCheaper.path,
        "trust_calibration",
        `Auto-selected cheaper route ${trustedCheaper.path.model} based on ${String(trustedCheaper.profile.runsObserved)} historical runs.`,
        input.blastRadius,
        trustedCheaper.profile
      )
    };
  }

  return { path: input.currentPath, evidence: defaultEvidence };
}

function createEntryProbeExecutionPath(input: {
  recoveryMatrix: RecoveryPath[];
  currentPath: RecoveryPath;
  probe: EntryProbeOutcome;
}): RecoveryPath | undefined {
  if (input.probe.status !== "completed" || input.probe.route !== "cheap-first") {
    return undefined;
  }

  const probeModel = "probeModel" in input.probe ? input.probe.probeModel : undefined;
  if (!probeModel) {
    return undefined;
  }

  const matchingPath = input.recoveryMatrix.find(
    (path) =>
      path.adapterIndex === input.currentPath.adapterIndex &&
      path.model === probeModel
  );

  if (!matchingPath) {
    return undefined;
  }

  return {
    ...matchingPath,
    matrixIndex: -1
  };
}

function uniqueModels(models: string[]): string[] {
  return [...new Set(models.filter((model) => model.trim().length > 0))];
}

function selectNextRecoveryPath(input: {
  recoveryMatrix: RecoveryPath[];
  attemptedKeys: ReadonlySet<string>;
  currentPath: RecoveryPath;
  recommendedIntervention: InterventionType;
  classifiedIntervention?: InterventionType;
}): RecoveryPath | undefined {
  const remainingPaths = input.recoveryMatrix
    .slice(input.currentPath.matrixIndex + 1)
    .filter((path) => !input.attemptedKeys.has(path.key));

  if (remainingPaths.length === 0) {
    return undefined;
  }

  const preferredIntervention = input.classifiedIntervention ?? input.recommendedIntervention;

  if (preferredIntervention === "switch_adapter") {
    return remainingPaths.find((path) => path.adapterIndex !== input.currentPath.adapterIndex);
  }

  if (input.recommendedIntervention === "change_model") {
    return (
      remainingPaths.find(
        (path) =>
          path.adapterIndex === input.currentPath.adapterIndex &&
          path.model !== input.currentPath.model
      ) ?? remainingPaths[0]
    );
  }

  return undefined;
}

function createRoutingEvidence(
  path: RecoveryPath,
  selectionSource: RoutingEvidence["selectionSource"],
  rationale: string,
  blastRadius?: BlastRadiusResult,
  trustProfile?: ModelTrustProfile
): RoutingEvidence {
  return {
    selectedModel: path.model,
    selectedAdapterId: path.adapter.adapterId,
    selectionSource,
    rationale,
    ...(blastRadius ? { blastRadiusScore: blastRadius.score } : {}),
    ...(trustProfile
      ? {
          trustProfile: {
            model: trustProfile.model,
            runsObserved: trustProfile.runsObserved,
            completionRate: trustProfile.completionRate,
            efficiencyScore: trustProfile.efficiencyScore,
            avgCostPerIteration: trustProfile.avgCostPerIteration
          }
        }
      : {})
  };
}

function normalizeBlastRadius(value: BlastRadiusResult | number): BlastRadiusResult {
  if (typeof value !== "number") return value;
  const score = Math.max(0, Math.min(100, value));
  return {
    score,
    filesAtRisk: [],
    hotspotsInPath: [],
    regressionRisk: score >= 70 ? "high" : score >= 40 ? "medium" : "low",
    rationale: "Precomputed blast radius score provided."
  };
}

function buildHeadlessContextEnvelope(
  task: HeadlessContextTask | undefined
): HeadlessContextPromptEnvelope | undefined {
  if (!task) {
    return undefined;
  }

  const pack = compileHeadlessContext({
    text: task.sourceText,
    sourceName: task.sourceName,
    recordType: task.recordType,
    metadata: task.metadata,
    profile: task.profile,
    options: task.options
  });

  return {
    profile: pack.profile,
    compiledContext: pack.compiledContext,
    recordType: pack.canonicalRecord.recordType,
    recordSummary: pack.canonicalRecord.summary,
    qcWarnings: pack.qcReport.warnings,
    policy: {
      recommendedMode: pack.trace.policyDecision.recommendedMode,
      severity: pack.trace.policyDecision.severity,
      requiresApproval: pack.trace.policyDecision.requiresApproval,
      reasons: pack.trace.policyDecision.reasons
    }
  };
}

function findTrustProfileForModel(
  profiles: ModelTrustProfile[],
  model: string
): ModelTrustProfile | undefined {
  const normalizedModel = normalizeModelKey(model);
  return profiles.find((profile) => {
    const normalizedProfile = normalizeModelKey(profile.model);
    return (
      normalizedModel === normalizedProfile ||
      normalizedModel.includes(normalizedProfile) ||
      normalizedProfile.includes(normalizedModel)
    );
  });
}

function bestNominalPath(paths: RecoveryPath[]): RecoveryPath {
  const mediumOrHigher = paths.filter((path) => trustTierForModel(path.model) !== "low");
  return cheapestPath(mediumOrHigher.length > 0 ? mediumOrHigher : paths);
}

function cheapestPath(paths: RecoveryPath[]): RecoveryPath {
  return paths.reduce((best, path) =>
    estimatedPathCost(path) < estimatedPathCost(best) ? path : best
  );
}

function trustTierForModel(model: string): "high" | "medium" | "low" {
  const key = normalizeModelKey(model);
  if (key.includes("opus") || key.includes("o3") || key.includes("gpt-5")) {
    return key.includes("mini") ? "low" : "high";
  }
  if (key.includes("sonnet") || key.includes("codex") || key.includes("gpt-4o")) {
    return "medium";
  }
  return "low";
}

function estimatedPathCost(path: RecoveryPath): number {
  const key = normalizeModelKey(path.model);
  if (key.includes("haiku")) return 0.003;
  if (key.includes("mini")) return 0.004;
  if (key.includes("sonnet")) return 0.02;
  if (key.includes("codex")) return 0.025;
  if (key.includes("opus")) return 0.08;
  if (key.includes("gpt-5")) return 0.03;
  if (key.includes("gpt-4o")) return 0.015;
  return 0.02;
}

function normalizeModelKey(model: string): string {
  return model.toLowerCase().replace(/[^a-z0-9]+/g, "-");
}

async function withTimeout<T>(
  promise: Promise<T>,
  fallback: T,
  timeoutMs: number
): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((resolve) => {
        timeout = setTimeout(() => resolve(fallback), timeoutMs);
      })
    ]);
  } catch {
    return fallback;
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

// ─── Memory Palace (Phase 31) ────────────────────────────────────────────────
export { resolveMemoryRoot, createFileLoopMemoryStore } from "./memory/palace.js";
export type {
  LoopMemoryStore,
  MemoryBrief,
  MemoryRecallEntry,
  PalaceMemoryRecall,
  PalaceMemoryRoom,
  PalaceMemoryDrawer
} from "./memory/palace.js";

// ─── Memory Learning Pipeline (Phase 30) ─────────────────────────────────────
export {
  DEFAULT_ACTIVE_LEARNING_HEURISTICS,
  DEFAULT_PROTECTED_LEARNING_PATHS,
  evaluateApprovalGate,
  loadActiveLearningHeuristics,
  runHoldoutValidation,
  runPromotionPipeline,
  runShadowTest,
  summarizeLearningPipeline
} from "./memory/learning-pipeline.js";
export type {
  ActiveLearningHeuristics,
  LearningCandidate,
  LearningCandidateProvenance,
  LearningCandidateRollbackPlan,
  LearningPipelineSummary,
  LearningPipelineSummaryEntry,
  CandidateStatus,
  ShadowTestResult,
  HoldoutResult,
  ApprovalGateConfig,
  PromotionResult
} from "./memory/learning-pipeline.js";

// ─── MCP Gateway (Phase 32) ───────────────────────────────────────────────────
export { createGateway } from "./gateway/index.js";
export { McpServerRegistry } from "./gateway/registry.js";
export type {
  McpServerConfig,
  ToolPolicyDecision,
  ToolExecutionAttempt
} from "./gateway/registry.js";
export { McpHttpTransport, McpTransportError } from "./gateway/transport.js";
export type { JsonRpcRequest, JsonRpcResponse } from "./gateway/transport.js";
export { StaticTokenVault, OAuthProxyVault } from "./gateway/vault.js";
export type { McpTokenVault } from "./gateway/vault.js";

// ─── Agent receipts (MartinLoop360) ───────────────────────────────────────────
export { signAgentReceipt, verifyAgentReceipt } from "./agent/receipts.js";
export { signAgentMandate, verifyAgentMandate } from "./agent/mandates.js";
export {
  buildWorkflowHandoffArtifact,
  compactWorkflowHandoffSources,
  computeLedgerHash,
  persistWorkflowArtifacts,
  renderWorkflowHandoffMarkdown,
  resolveWorkflowArtifactPaths,
  verifyWorkflowHandoffForResume
} from "./workflow-artifacts.js";
export { computeContextUtilityScore } from "./context-utility.js";
export type {
  AgentReceiptPayload,
  AgentReceiptSignature,
  AgentReceiptSignOptions,
  AgentReceiptVerificationResult,
  AgentReceiptVerifyOptions,
  SignedAgentReceipt
} from "./agent/receipts.js";
export type {
  PersistedWorkflowArtifacts,
  WorkflowArtifactPaths,
  WorkflowHandoffArtifact,
  WorkflowHandoffCompaction,
  WorkflowHandoffSourceDigest,
  WorkflowHandoffVerificationResult
} from "./workflow-artifacts.js";
export type {
  ComputeContextUtilityScoreInput,
  ContextUtilityAction,
  ContextUtilityActionType,
  ContextUtilityBand,
  ContextUtilityEvidenceCounts,
  ContextUtilityScoreArtifact,
  ContextUtilitySectionScores
} from "./context-utility.js";
export type {
  AgentMandatePayload,
  AgentMandateSignature,
  AgentMandateSignOptions,
  AgentMandateVerificationResult,
  AgentMandateVerifyOptions,
  SignedAgentMandate
} from "./agent/mandates.js";

// ─── Model Router (Phase 31) ──────────────────────────────────────────────────
export { MartinRouter } from "./router/engine.js";
export type {
  RouterAdapterRef,
  RouteConfig,
  RouteEvaluationContext,
  RouteDecision
} from "./router/engine.js";

// ─── Graph Hotspots (Phase 31) ────────────────────────────────────────────────
export { MartinGraph } from "./graph/hotspots.js";
export { AbstractGraphStore, JsonAdjacencyGraphAdapter, GitBlameGraphAdapter } from "./graph/adapters.js";
export type { MartinGraphAdapter } from "./graph/adapters.js";
export type { RepoHotspot, GraphContextAssembly } from "./graph/hotspots.js";

// ─── Blast Radius Estimator ────────────────────────────────────────────────────
export { estimateBlastRadius } from "./leash/blast-radius.js";
export type { BlastRadiusInput, BlastRadiusResult } from "./leash/blast-radius.js";

// ─── Trust Calibration Engine ─────────────────────────────────────────────────
export { calibrateTrust, shouldDeprioritize } from "./router/trust-calibration.js";
export type { ModelTrustProfile, TrustCalibrationResult } from "./router/trust-calibration.js";
