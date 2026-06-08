import { spawnSync } from "node:child_process";

import {
  type AdapterCapabilityDescriptor,
  type ApprovalPolicy,
  appendLoopEvent,
  type ChangeObservationReconciliation,
  type CircuitBreakDecision,
  cloneExecutionPolicy,
  createLoopRecord,
  type CostProvenance,
  type ExecutionPolicy,
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
  type VerifierSnapshot,
  type RollbackOutcomeArtifact,
  type TrajectoryAssessment,
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
import { captureRollbackBoundary, restoreRollbackBoundary } from "./rollback.js";
import { compilePromptPacket } from "./compiler.js";
import {
  compileAndPersistContext,
  makeLedgerEvent,
  resolveRunsRoot,
  runDir,
  type RunStore
} from "./persistence/index.js";
import {
  runContextIntegrityPrecheck,
  type ContextIntegrityPrecheck,
  type ContextIntegrityVerdict
} from "./context-integrity.js";
import {
  assessTrajectory,
  decideCircuitBreak
} from "./trajectory.js";

// ─── Public API re-exports ───────────────────────────────────────────────────
export type {
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
  resolveExecutionProfile,
  redactSecretsFromText,
  buildRepoGroundingIndex,
  loadOrBuildRepoGroundingIndex,
  queryRepoGroundingIndex,
  scanPatchForGroundingViolations,
  captureRollbackBoundary,
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
export type { ContextGraphBuildOptions } from "@martin/contracts";

// ─── Context Integrity Pre-gate ──────────────────────────────────────────────
export { runContextIntegrityPrecheck } from "./context-integrity.js";
export type { ContextIntegrityPrecheck, ContextIntegrityVerdict } from "./context-integrity.js";

// ─── Prompt packet compiler ──────────────────────────────────────────────────
export { compilePromptPacket } from "./compiler.js";
export type { PromptPacket, CompilerAdapterRequest } from "./compiler.js";
export { compileExecutionPolicy } from "./policy-compiler.js";
export type { ContextGraphHit, ContextGraphSnapshot, ContextQuery } from "@martin/contracts";
export { assessTrajectory, decideCircuitBreak } from "./trajectory.js";
export type { CircuitBreakDecision, TrajectoryAssessment } from "@martin/contracts";
export {
  createLocalIdentityAuthority,
  hasIdentityScope,
  issueIdentityToken,
  verifyIdentityToken
} from "./identity.js";
export type { LocalIdentityAuthority } from "./identity.js";
export type {
  IdentityAlgorithm,
  IdentityAttestation,
  IdentityClaims,
  IdentityRole,
  IdentityToken
} from "@martin/contracts";

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

// ─── Context Graph Foundation ────────────────────────────────────────────────
export { buildContextGraphSnapshot, queryContextGraph } from "./context-graph.js";

// ─── Adapter interfaces ──────────────────────────────────────────────────────

export interface MartinAdapterRequest {
  loopId: string;
  attemptId: string;
  context: {
    taskTitle: string;
    objective: string;
    verificationPlan: string[];
    verificationStack?: LoopTask["verificationStack"];
    mutationMode?: MutationMode;
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
  };
  previousAttempts: LoopAttempt[];
}

export interface MartinVerificationStep {
  command: string;
  launched: boolean;
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
    snapshot?: VerifierSnapshot;
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
    model: string;
    transport?: "cli" | "http" | "routed_http";
    capabilities?: AdapterCapabilityDescriptor;
    [key: string]: unknown;
  };
  execute(request: MartinAdapterRequest): Promise<MartinAdapterResult>;
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
  trajectoryAssessment?: TrajectoryAssessment;
  circuitBreakDecision?: CircuitBreakDecision;
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

  const circuitBreakDecision = decideCircuitBreak({
    objective: request.context.objective,
    verificationPlan: request.context.verificationPlan,
    attempts: request.previousAttempts,
    remainingIterations: request.context.remainingIterations
  });

  if (circuitBreakDecision.shouldStop) {
    return {
      allowed: false,
      reason: circuitBreakDecision.reason,
      ...(circuitBreakDecision.recommendedIntervention
        ? { recommendedIntervention: circuitBreakDecision.recommendedIntervention }
        : {}),
      trajectoryAssessment: circuitBreakDecision.assessment,
      circuitBreakDecision
    };
  }

  return {
    allowed: true,
    reason: "Attempt admitted.",
    trajectoryAssessment: circuitBreakDecision.assessment,
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
  executionPolicy?: ExecutionPolicy;
  adapter: MartinAdapter;
  now?: () => string;
  idFactory?: (prefix: string) => string;
  maxRecentAttempts?: number;
  fallbackModels?: string[];
  fallbackAdapters?: MartinAdapter[];
  receiptScope?: ReceiptScope;
  /** Optional persistence store. When provided, runMartin writes artifacts on each lifecycle event. */
  store?: RunStore;
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

function resolveRuntimeExecutionPolicy(input: RunMartinInput): ExecutionPolicy {
  if (input.executionPolicy) {
    return cloneExecutionPolicy(input.executionPolicy);
  }

  const policyProfile = normalizeRuntimePolicyProfile(input.metadata?.policyProfile);
  const telemetryDestination = normalizeRuntimeTelemetryDestination(
    input.metadata?.telemetryDestination
  );
  const provenance: ExecutionPolicy["provenance"] = [
    { field: "budget.maxUsd", source: "request", value: String(input.budget.maxUsd) },
    { field: "budget.softLimitUsd", source: "request", value: String(input.budget.softLimitUsd) },
    {
      field: "budget.maxIterations",
      source: "request",
      value: String(input.budget.maxIterations)
    },
    { field: "budget.maxTokens", source: "request", value: String(input.budget.maxTokens) },
    {
      field: "governance.policyProfile",
      source: input.metadata?.policyProfile ? "request" : "default",
      value: policyProfile
    },
    {
      field: "governance.telemetryDestination",
      source: input.metadata?.telemetryDestination ? "request" : "default",
      value: telemetryDestination
    },
    {
      field: "governance.destructiveActionPolicy",
      source: "default",
      value: "approval"
    },
    {
      field: "task.verificationPlan",
      source: "request",
      value: input.task.verificationPlan.join(", ")
    }
  ];

  if (input.task.mutationMode) {
    provenance.push({
      field: "task.mutationMode",
      source: "request",
      value: input.task.mutationMode
    });
  }
  if (input.task.repoRoot) {
    provenance.push({
      field: "task.repoRoot",
      source: "request",
      value: input.task.repoRoot
    });
  }
  if (input.task.allowedPaths?.length) {
    provenance.push({
      field: "task.allowedPaths",
      source: "request",
      value: input.task.allowedPaths.join(", ")
    });
  }
  if (input.task.deniedPaths?.length) {
    provenance.push({
      field: "task.deniedPaths",
      source: "request",
      value: input.task.deniedPaths.join(", ")
    });
  }
  if (input.task.acceptanceCriteria?.length) {
    provenance.push({
      field: "task.acceptanceCriteria",
      source: "request",
      value: input.task.acceptanceCriteria.join(", ")
    });
  }
  if (input.task.approvalPolicy) {
    provenance.push({
      field: "task.approvalPolicy",
      source: "request",
      value: JSON.stringify(input.task.approvalPolicy)
    });
  }

  return {
    configPath: "runtime://inline",
    budget: {
      ...input.budget
    },
    governance: {
      policyProfile,
      telemetryDestination,
      destructiveActionPolicy: "approval"
    },
    task: {
      verificationPlan: [...input.task.verificationPlan],
      ...(input.task.mutationMode ? { mutationMode: input.task.mutationMode } : {}),
      ...(input.task.repoRoot ? { repoRoot: input.task.repoRoot } : {}),
      ...(input.task.allowedPaths ? { allowedPaths: [...input.task.allowedPaths] } : {}),
      ...(input.task.deniedPaths ? { deniedPaths: [...input.task.deniedPaths] } : {}),
      ...(input.task.acceptanceCriteria
        ? { acceptanceCriteria: [...input.task.acceptanceCriteria] }
        : {}),
      ...(input.task.approvalPolicy ? { approvalPolicy: { ...input.task.approvalPolicy } } : {})
    },
    provenance
  };
}

function normalizeRuntimePolicyProfile(
  value: string | undefined
): ExecutionPolicy["governance"]["policyProfile"] {
  return value === "strict" || value === "overnight" || value === "debug" || value === "balanced"
    ? value
    : "balanced";
}

function normalizeRuntimeTelemetryDestination(
  value: string | undefined
): ExecutionPolicy["governance"]["telemetryDestination"] {
  return value === "control-plane" || value === "local-only" ? value : "local-only";
}

export async function runMartin(input: RunMartinInput): Promise<RunMartinResult> {
  const now = input.now ?? (() => new Date().toISOString());
  const idFactory = input.idFactory;
  const executionPolicy = resolveRuntimeExecutionPolicy(input);

  let loop = createLoopRecord(
    {
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      task: input.task,
      budget: input.budget,
      ...(input.receiptScope ? { receiptScope: input.receiptScope } : {}),
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

  const DEFAULT_FALLBACK_MODELS = [
    "claude-haiku-4-5",
    "claude-sonnet-4-6",
    "claude-opus-4-6"
  ];
  const adapterChain = [input.adapter, ...(input.fallbackAdapters ?? [])];
  let currentAdapterIndex = 0;
  let currentAdapter = adapterChain[currentAdapterIndex] ?? input.adapter;
  let useCompressedContext = false;
  const isVerifyOnly = input.task.mutationMode === "verify_only";
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

  while (loop.attempts.length < loop.budget.maxIterations) {
    const distilled = distillContext(loop, {
      maxRecentAttempts: useCompressedContext ? 1 : (input.maxRecentAttempts ?? 3)
    });
    useCompressedContext = false;
    const attemptStartedAt = now();
    const attemptId = makeId("att", idFactory);
    const currentAttemptIndex = loop.attempts.length + 1;
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
    const contextPrecheck = await runContextIntegrityPrecheck(
      loop.loopId,
      loop.attempts.length + 1,
      runDir(resolveActiveRunsRoot(input.store), loop.loopId),
      {
        userPrompt: distilled.focus,
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
          focus: distilled.focus,
          remainingBudgetUsd: distilled.constraints.remainingBudgetUsd,
          remainingIterations: distilled.constraints.remainingIterations,
          remainingTokens: distilled.constraints.remainingTokens
        },
        previousAttempts: loop.attempts
      },
      projectedUsd: budgetPreflight.estimate.estimatedAttemptCostUsd
    });

    if (admissionDecision.trajectoryAssessment && admissionDecision.trajectoryAssessment.status !== "healthy") {
      loop = appendLoopEvent(
        loop,
        {
          type: "trajectory.assessed",
          lifecycleState: "running",
          payload: {
            attemptId,
            attemptIndex: currentAttemptIndex,
            assessment: admissionDecision.trajectoryAssessment,
            ...(admissionDecision.circuitBreakDecision
              ? { circuitBreak: admissionDecision.circuitBreakDecision }
              : {})
          }
        },
        { now: now(), idFactory }
      );

      if (input.store) {
        await input.store.appendLedger(
          loop.loopId,
          makeLedgerEvent({
            kind: "trajectory.assessed",
            runId: loop.loopId,
            attemptIndex: currentAttemptIndex,
            payload: {
              attemptId,
              assessment: admissionDecision.trajectoryAssessment,
              ...(admissionDecision.circuitBreakDecision
                ? { circuitBreak: admissionDecision.circuitBreakDecision }
                : {})
            }
          })
        );
      }
    }

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
            payload: {
              reason: admissionDecision.reason,
              ...(admissionDecision.trajectoryAssessment
                ? { trajectory: admissionDecision.trajectoryAssessment }
                : {}),
              ...(admissionDecision.circuitBreakDecision
                ? { circuitBreak: admissionDecision.circuitBreakDecision }
                : {})
            }
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
      attemptId,
      context: {
        taskTitle: loop.task.title,
        objective: loop.task.objective,
        verificationPlan: loop.task.verificationPlan,
        ...(loop.task.verificationStack ? { verificationStack: loop.task.verificationStack } : {}),
        ...(loop.task.mutationMode ? { mutationMode: loop.task.mutationMode } : {}),
        ...(loop.task.repoRoot ? { repoRoot: loop.task.repoRoot } : {}),
        ...(loop.task.allowedPaths ? { allowedPaths: loop.task.allowedPaths } : {}),
        ...(loop.task.deniedPaths ? { deniedPaths: loop.task.deniedPaths } : {}),
        ...(loop.task.acceptanceCriteria ? { acceptanceCriteria: loop.task.acceptanceCriteria } : {}),
        ...(loop.task.executionProfile ? { executionProfile: loop.task.executionProfile } : {}),
        ...(loop.task.allowedNetworkDomains
          ? { allowedNetworkDomains: loop.task.allowedNetworkDomains }
          : {}),
        ...(loop.task.approvalPolicy ? { approvalPolicy: loop.task.approvalPolicy } : {}),
        focus: distilled.focus,
        remainingBudgetUsd: distilled.constraints.remainingBudgetUsd,
        remainingIterations: distilled.constraints.remainingIterations,
        remainingTokens: distilled.constraints.remainingTokens
      },
      previousAttempts: loop.attempts
    };

    const tracksWorkspaceMutations =
      request.context.repoRoot !== undefined &&
      executingAdapter.metadata.capabilities?.sandboxExpectation !== "provider_managed" &&
      executingAdapter.metadata.capabilities?.sandboxExpectation !== "not_applicable";

    const rollbackBoundary = tracksWorkspaceMutations
      ? await captureRollbackBoundary({
          repoRoot: request.context.repoRoot,
          capturedAt: attemptStartedAt
        })
      : undefined;
    const compiledContext = input.store
      ? (
          await compileAndPersistContext(request, {
            attemptIndex: currentAttemptIndex,
            store: input.store,
            now: attemptStartedAt,
            executionPolicy
          })
        ).packet
      : compilePromptPacket(request);
    const result = await executingAdapter.execute(request);
    const attemptCompletedAt = now();
    const verification = normalizeVerificationOutcome(result);

    // PATCH → VERIFY
    currentPhase = "VERIFY";

    let failure =
      result.status === "failed"
        ? classifyFailure({ attempts: loop.attempts, result })
        : undefined;

    const attempt: LoopAttempt = {
      attemptId,
      index: currentAttemptIndex,
      adapterId: executingAdapter.adapterId,
      model: executingAdapter.metadata.model,
      startedAt: attemptStartedAt,
      completedAt: attemptCompletedAt,
      summary: result.summary,
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
        ...(result.usage.estimatedUsd !== undefined
          ? {
              estimatedUsd: roundUsd(
                (loop.cost.estimatedUsd ?? loop.cost.actualUsd) + result.usage.estimatedUsd
              )
            }
          : {}),
        provenance: getUsageProvenance(result.usage),
        ...(result.usage.providerSettlement
          ? { providerSettlement: result.usage.providerSettlement }
          : {})
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

    const previousVerifierScore = getLastVerifierScore(loop);
    const changeEvidence = tracksWorkspaceMutations
      ? collectChangeEvidence(result, request.context.repoRoot)
      : createUnavailableChangeEvidence();
    const changedFiles = changeEvidence.changedFiles;
    const effectiveDiffStats = changeEvidence.diffStats;
    const changedFileEvidenceAvailable = changeEvidence.evidenceAvailable;

    if (changeEvidence.reconciliation.status !== "unavailable") {
      loop = appendLoopEvent(
        loop,
        {
          type: "observation.reconciled",
          lifecycleState: "running",
          payload: {
            attemptId,
            attemptIndex: currentAttemptIndex,
            observation: changeEvidence.reconciliation
          }
        },
        { now: attemptCompletedAt, idFactory }
      );
    }

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

      if (failure.recommendedIntervention === "change_model" && currentAdapter.withModel) {
        const fallbackModels = input.fallbackModels ?? DEFAULT_FALLBACK_MODELS;
        const nextModel = fallbackModels[loop.attempts.length % fallbackModels.length];
        if (nextModel) {
          currentAdapter = currentAdapter.withModel(nextModel);
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

    loop = appendLoopEvent(
      loop,
      {
        type: "verification.completed",
        lifecycleState: verification.passed ? "completed" : "verifying",
        payload: {
          attemptId,
          attemptIndex: currentAttemptIndex,
          passed: verification.passed,
          summary: verification.summary,
          ...(verification.steps?.length ? { steps: verification.steps } : {}),
          ...(verification.warnings?.length ? { warnings: verification.warnings } : {}),
          ...(result.verification.snapshot ? { snapshot: result.verification.snapshot } : {})
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
        executionPolicy,
        verification,
        ...(result.verification.snapshot?.combinedOutput
          ? { verifierOutput: result.verification.snapshot.combinedOutput }
          : {}),
        ...(changeEvidence.reconciliation.status !== "unavailable"
          ? { observation: changeEvidence.reconciliation }
          : {}),
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
      if (changeEvidence.reconciliation.status !== "unavailable") {
        await input.store.appendLedger(
          loop.loopId,
          makeLedgerEvent({
            kind: "observation.reconciled",
            runId: loop.loopId,
            attemptIndex: currentAttemptIndex,
            payload: {
              observation: changeEvidence.reconciliation
            }
          })
        );
      }
      await input.store.appendLedger(
        loop.loopId,
        makeLedgerEvent({
          kind: "verification.completed",
          runId: loop.loopId,
          attemptIndex: currentAttemptIndex,
          payload: {
            attemptId,
            passed: verification.passed,
            summary: verification.summary,
            ...(verification.steps?.length ? { steps: verification.steps } : {}),
            ...(verification.warnings?.length ? { warnings: verification.warnings } : {}),
            ...(result.verification.snapshot ? { snapshot: result.verification.snapshot } : {})
          }
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

    const isVerifierOnlyAdapter = executingAdapter.adapterId === "direct:verifier:verify-only";
    const patchTruthCountsEdits =
      !isVerifyOnly && !isVerifierOnlyAdapter && changedFileEvidenceAvailable;
    if (isVerifyOnly && changedFiles.length > 0) {
      const patchDecision = evaluatePatchDecision({
        verificationPassed: verification.passed,
        previousVerifierScore,
        verifierScore: verification.passed ? 1 : 0,
        scopeViolationCount: changedFiles.length,
        changedFileCount: changedFiles.length,
        diffNovelty: 1,
        diffStats: effectiveDiffStats,
        costUsd: getUsageUsd(result.usage),
        summary: result.summary
      });
      const verifyOnlyExitDecision: ExitDecision = {
        shouldExit: true,
        lifecycleState: "human_escalation",
        status: "exited",
        reason: "Verify-only mode forbids file changes.",
        failureClass: "safety_leash_blocked",
        safetySurface: "filesystem",
        reasonCode: "verify_only_write_attempt"
      };
      const rollbackOutcome = await restoreRollbackBoundary({
        repoRoot: request.context.repoRoot,
        boundary: rollbackBoundary,
        restoredAt: attemptCompletedAt,
        decision: patchDecision.decision
      });

      if (input.store) {
        const verifyOnlyViolation: SafetyViolation = {
          kind: "path_not_allowed",
          message: `Verify-only mode forbids changed files: ${changedFiles.join(", ")}`,
          file: changedFiles[0]
        };
        await input.store.writeAttemptArtifacts(loop.loopId, currentAttemptIndex, {
          compiledContext,
          executionPolicy,
          leash: createLeashArtifact(
            {
              surface: "filesystem",
              reason: verifyOnlyExitDecision.reason,
              violations: [verifyOnlyViolation]
            },
            currentAttemptIndex
          ),
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
              violations: [
                {
                  kind: "path_not_allowed",
                  message: verifyOnlyExitDecision.reason,
                  files: changedFiles
                }
              ]
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
            payload: createRunExitPayload(verifyOnlyExitDecision)
          })
        );
      }

      const finalizedLoop = finalizeLoop(loop, verifyOnlyExitDecision, now(), idFactory);
      await persistLoopRecordIfSupported(input.store, finalizedLoop);
      return {
        loop: finalizedLoop,
        decision: verifyOnlyExitDecision
      };
    }

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
        diffStats: effectiveDiffStats,
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
          executionPolicy,
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
        diffStats: effectiveDiffStats,
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
          executionPolicy,
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

    let patchDecision: EvaluatedPatchDecision | undefined;
    if (result.status === "completed") {
      patchDecision = evaluatePatchDecision({
        verificationPassed: verification.passed,
        previousVerifierScore,
        verifierScore: verification.passed ? 1 : 0,
        groundingViolationCount: groundingScanResult?.violations.length ?? 0,
        changedFileCount: patchTruthCountsEdits ? changedFiles.length : undefined,
        diffNovelty: patchTruthCountsEdits ? (changedFiles.length > 0 ? 1 : 0) : undefined,
        diffStats: effectiveDiffStats,
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
        executionPolicy,
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
            kind: verification.passed ? "attempt.kept" : "attempt.discarded",
            runId: loop.loopId,
            attemptIndex: currentAttemptIndex,
            payload: { reason: verification.summary }
          })
        );
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
      canSwitchAdapter:
        failure?.recommendedIntervention === "switch_adapter" &&
        adapterChain[currentAdapterIndex] !== undefined &&
        currentAdapter.adapterId !== executingAdapter.adapterId
    });

    // Advance phase based on result
    currentPhase = nextPolicyPhase(currentPhase, effectiveResult, costState, phaseRetryCount);
    if (failure) phaseRetryCount++;
    else phaseRetryCount = 0;

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
      const finalizedLoop = finalizeLoop(loop, decision, now(), idFactory);
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

  const finalizedLoop = finalizeLoop(loop, decision, now(), idFactory);
  await persistLoopRecordIfSupported(input.store, finalizedLoop);
  return {
    loop: finalizedLoop,
    decision
  };
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
  idFactory?: (prefix: string) => string
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

  return {
    ...finalized,
    status: decision.status,
    lifecycleState: decision.lifecycleState,
    updatedAt: timestamp
  };
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

function createUnavailableChangeEvidence(): {
  changedFiles: string[];
  diffStats?: NonNullable<NonNullable<MartinAdapterResult["execution"]>["diffStats"]>;
  evidenceAvailable: boolean;
  reconciliation: ChangeObservationReconciliation;
} {
  return {
    changedFiles: [],
    evidenceAvailable: false,
    reconciliation: {
      status: "unavailable",
      summary: "Change observation is unavailable because the adapter does not mutate the workspace.",
      adapterReported: {
        available: false,
        changedFiles: []
      },
      repoObserved: {
        available: false,
        changedFiles: []
      },
      effectiveChangedFiles: [],
      matchedFiles: [],
      adapterOnlyFiles: [],
      repoOnlyFiles: []
    }
  };
}

function collectChangeEvidence(
  result: MartinAdapterResult,
  repoRoot?: string
): {
  changedFiles: string[];
  diffStats?: NonNullable<NonNullable<MartinAdapterResult["execution"]>["diffStats"]>;
  evidenceAvailable: boolean;
  reconciliation: ChangeObservationReconciliation;
} {
  const adapterReported = {
    available: result.execution?.changedFiles !== undefined,
    changedFiles: normalizeChangedFileList(result.execution?.changedFiles),
    ...(result.execution?.diffStats ? { diffStats: result.execution.diffStats } : {})
  };
  const repoObserved = observeRepoChanges(repoRoot);
  const matchedFiles = intersectLists(adapterReported.changedFiles, repoObserved.changedFiles);
  const adapterOnlyFiles = subtractLists(adapterReported.changedFiles, repoObserved.changedFiles);
  const repoOnlyFiles = subtractLists(repoObserved.changedFiles, adapterReported.changedFiles);
  const effectiveChangedFiles = unionLists(adapterReported.changedFiles, repoObserved.changedFiles);
  const status = determineObservationStatus(adapterReported.available, repoObserved.available, adapterOnlyFiles, repoOnlyFiles);

  return {
    changedFiles: effectiveChangedFiles,
    ...(repoObserved.diffStats
      ? { diffStats: repoObserved.diffStats }
      : adapterReported.diffStats
        ? { diffStats: adapterReported.diffStats }
        : {}),
    evidenceAvailable: adapterReported.available || repoObserved.available,
    reconciliation: {
      status,
      summary: summarizeObservationStatus(status),
      adapterReported,
      repoObserved,
      effectiveChangedFiles,
      matchedFiles,
      adapterOnlyFiles,
      repoOnlyFiles
    }
  };
}

function observeRepoChanges(repoRoot?: string): ChangeObservationReconciliation["repoObserved"] {
  if (!repoRoot) {
    return {
      available: false,
      changedFiles: []
    };
  }

  try {
    const changedFilesResult = spawnSync("git", ["diff", "--name-only", "HEAD", "--", "."], {
      cwd: repoRoot,
      encoding: "utf8"
    });
    const untrackedFilesResult = spawnSync("git", ["ls-files", "--others", "--exclude-standard"], {
      cwd: repoRoot,
      encoding: "utf8"
    });
    const diffStatsResult = spawnSync("git", ["diff", "--numstat", "HEAD", "--", "."], {
      cwd: repoRoot,
      encoding: "utf8"
    });

    if (changedFilesResult.status !== 0) {
      return {
        available: false,
        changedFiles: []
      };
    }

    const changedFiles = unionLists(
      normalizeChangedFileList(changedFilesResult.stdout),
      untrackedFilesResult.status === 0 ? normalizeChangedFileList(untrackedFilesResult.stdout) : []
    );

    return {
      available: true,
      changedFiles,
      ...(diffStatsResult.status === 0 && typeof diffStatsResult.stdout === "string"
        ? { diffStats: parseDiffStatsFromNumstat(diffStatsResult.stdout) }
        : {})
    };
  } catch {
    return {
      available: false,
      changedFiles: []
    };
  }
}

function determineObservationStatus(
  adapterAvailable: boolean,
  repoAvailable: boolean,
  adapterOnlyFiles: string[],
  repoOnlyFiles: string[]
): ChangeObservationReconciliation["status"] {
  if (adapterAvailable && repoAvailable) {
    return adapterOnlyFiles.length === 0 && repoOnlyFiles.length === 0 ? "verified" : "mismatch";
  }

  if (adapterAvailable) {
    return "adapter_only";
  }

  if (repoAvailable) {
    return "repo_only";
  }

  return "unavailable";
}

function summarizeObservationStatus(status: ChangeObservationReconciliation["status"]): string {
  switch (status) {
    case "verified":
      return "Adapter-reported changes matched repo observation.";
    case "mismatch":
      return "Adapter-reported changes differed from repo observation.";
    case "adapter_only":
      return "Only adapter-reported change evidence was available.";
    case "repo_only":
      return "Only repo-observed change evidence was available.";
    default:
      return "No change-observation evidence was available.";
  }
}

function normalizeChangedFileList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return uniqueSortedStrings(value);
  }

  if (typeof value === "string") {
    return uniqueSortedStrings(value.split(/\r?\n/u));
  }

  return [];
}

function unionLists(left: string[], right: string[]): string[] {
  return uniqueSortedStrings([...left, ...right]);
}

function intersectLists(left: string[], right: string[]): string[] {
  const rightSet = new Set(right);
  return left.filter((entry) => rightSet.has(entry));
}

function subtractLists(left: string[], right: string[]): string[] {
  const rightSet = new Set(right);
  return left.filter((entry) => !rightSet.has(entry));
}

function uniqueSortedStrings(values: unknown[]): string[] {
  return [...new Set(
    values
      .filter((value): value is string => typeof value === "string")
      .map((entry) => entry.trim())
      .filter(Boolean)
  )].sort((left, right) => left.localeCompare(right));
}

function parseDiffStatsFromNumstat(
  stdout: string
): NonNullable<NonNullable<MartinAdapterResult["execution"]>["diffStats"]> | undefined {
  const lines = stdout
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);

  if (lines.length === 0) {
    return undefined;
  }

  let filesChanged = 0;
  let addedLines = 0;
  let deletedLines = 0;

  for (const line of lines) {
    const [added, deleted] = line.split(/\s+/u);
    filesChanged += 1;
    addedLines += Number(added) || 0;
    deletedLines += Number(deleted) || 0;
  }

  return { filesChanged, addedLines, deletedLines };
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

function normalizeVerificationOutcome(result: MartinAdapterResult): MartinVerificationOutcome {
  const warnings = [...(result.verification.warnings ?? [])];
  const contradiction = detectVerificationContradiction(result);
  if (contradiction && !warnings.includes(contradiction)) {
    warnings.push(contradiction);
  }

  return {
    passed: result.verification.passed,
    summary: result.verification.summary,
    ...(result.verification.steps?.length ? { steps: result.verification.steps } : {}),
    ...(warnings.length ? { warnings } : {})
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

function classifyPatchDecisionFailure(decision: EvaluatedPatchDecision): FailureAssessment {
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
