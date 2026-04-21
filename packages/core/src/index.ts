import { spawnSync } from "node:child_process";

import {
  type ApprovalPolicy,
  appendLoopEvent,
  createLoopRecord,
  type CostProvenance,
  type ExecutionProfile,
  type FailureClass,
  type InterventionType,
  type LoopArtifact,
  type LoopAttempt,
  type LoopBudget,
  type LoopRecord,
  type LoopTask,
  type PatchDecisionArtifact,
  type PatchScore,
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
import { captureRollbackBoundary, restoreRollbackBoundary } from "./rollback.js";
import { compilePromptPacket } from "./compiler.js";
import { makeLedgerEvent, type RunStore } from "./persistence/index.js";

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

// ─── Prompt packet compiler ──────────────────────────────────────────────────
export { compilePromptPacket } from "./compiler.js";
export type { PromptPacket, CompilerAdapterRequest } from "./compiler.js";

// ─── Persistence (RunStore, LedgerEvent, FileRunStore) ──────────────────────
export {
  createFileRunStore,
  makeLedgerEvent,
  resolveRunsRoot
} from "./persistence/index.js";
export type {
  AttemptArtifacts,
  LedgerEvent,
  LedgerEventKind,
  RunContract,
  RunStore
} from "./persistence/index.js";
export { compileAndPersistContext } from "./persistence/index.js";
export type { CompileResult } from "./persistence/index.js";

// ─── Adapter interfaces ──────────────────────────────────────────────────────

export interface MartinAdapterRequest {
  loopId: string;
  attemptId: string;
  context: {
    taskTitle: string;
    objective: string;
    verificationPlan: string[];
    verificationStack?: LoopTask["verificationStack"];
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

export interface MartinAdapterResult {
  status: "completed" | "failed";
  summary: string;
  usage: {
    actualUsd: number;
    estimatedUsd?: number;
    tokensIn: number;
    tokensOut: number;
    provenance?: CostProvenance;
  };
  verification: {
    passed: boolean;
    summary: string;
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
        recommendedIntervention: "escalate_human"
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
          recommendedIntervention: "escalate_human"
        };
      }
    }
  }

  return {
    allowed: true,
    reason: "Attempt admitted."
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
  fallbackModels?: string[];
  fallbackAdapters?: MartinAdapter[];
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

export async function runMartin(input: RunMartinInput): Promise<RunMartinResult> {
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
            violations: serializeSafetyViolations(leashDecision)
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
    return {
      loop: finalizeLoop(loop, leashExitDecision, now(), idFactory),
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
            violations: secretDecision.violations.map((violation) => violation.match ?? violation.message)
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

    return {
      loop: finalizeLoop(loop, secretExitDecision, now(), idFactory),
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
            payload: {
              lifecycleState: preflightExitDecision.lifecycleState,
              status: preflightExitDecision.status,
              reason: preflightExitDecision.reason
            }
          })
        );
      }
      return {
        loop: finalizeLoop(loop, preflightExitDecision, now(), idFactory),
        decision: preflightExitDecision
      };
    }

    // GATHER → ADMIT: run admission control before executing
    currentPhase = "ADMIT";
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
            payload: {
              lifecycleState: exitDecision.lifecycleState,
              status: exitDecision.status,
              reason: exitDecision.reason
            }
          })
        );
      }
      return {
        loop: finalizeLoop(loop, exitDecision, now(), idFactory),
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

    const rollbackBoundary = await captureRollbackBoundary({
      repoRoot: request.context.repoRoot,
      capturedAt: attemptStartedAt
    });
    const result = await executingAdapter.execute(request);
    const attemptCompletedAt = now();
    const compiledContext = compilePromptPacket(request);

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
        tokensOut: loop.cost.tokensOut + result.usage.tokensOut
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
            patchCost: settlement.patchCost,
            verificationCost: settlement.verificationCost,
            varianceUsd: settlement.varianceUsd,
            preflightEstimateUsd: settlement.preflightEstimateUsd
          }
        })
      );
    }

    const changedFiles = resolveChangedFiles(result, request.context.repoRoot);
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
        reason: filesystemDecision.reason ?? "Safety leash blocked filesystem changes."
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
            payload: {
              lifecycleState: filesystemExitDecision.lifecycleState,
              status: filesystemExitDecision.status,
              reason: filesystemExitDecision.reason
            }
          })
        );
      }

      return {
        loop: finalizeLoop(loop, filesystemExitDecision, now(), idFactory),
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
            payload: {
              lifecycleState: approvalExitDecision.lifecycleState,
              status: approvalExitDecision.status,
              reason: approvalExitDecision.reason
            }
          })
        );
      }

      return {
        loop: finalizeLoop(loop, approvalExitDecision, now(), idFactory),
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
        verificationPassed: result.verification.passed,
        previousVerifierScore,
        verifierScore: result.verification.passed ? 1 : 0,
        groundingViolationCount: groundingScanResult?.violations.length ?? 0,
        changedFileCount: changedFileEvidenceAvailable ? changedFiles.length : undefined,
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
            kind: result.verification.passed ? "attempt.kept" : "attempt.discarded",
            runId: loop.loopId,
            attemptIndex: currentAttemptIndex,
            payload: { reason: result.verification.summary }
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
            payload: {
              lifecycleState: patchExitDecision.lifecycleState,
              status: patchExitDecision.status,
              reason: patchExitDecision.reason
            }
          })
        );
      }

      return {
        loop: finalizeLoop(loop, patchExitDecision, now(), idFactory),
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
            payload: {
              lifecycleState: decision.lifecycleState,
              status: decision.status,
              reason: decision.reason
            }
          })
        );
      }
      return {
        loop: finalizeLoop(loop, decision, now(), idFactory),
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
        payload: {
          lifecycleState: decision.lifecycleState,
          status: decision.status,
          reason: decision.reason
        }
      })
    );
  }

  return {
    loop: finalizeLoop(loop, decision, now(), idFactory),
    decision
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

function resolveChangedFiles(result: MartinAdapterResult, repoRoot?: string): string[] {
  if (result.execution?.changedFiles?.length) {
    return result.execution.changedFiles;
  }

  if (!repoRoot) {
    return [];
  }

  try {
    const diff = spawnSync("git", ["diff", "--name-only", "HEAD"], {
      cwd: repoRoot,
      encoding: "utf8"
    });

    if (diff.status !== 0 || typeof diff.stdout !== "string") {
      return [];
    }

    return diff.stdout
      .split(/\r?\n/u)
      .map((entry) => entry.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
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
