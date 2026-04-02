import {
  appendLoopEvent,
  createLoopRecord,
  type FailureClass,
  type InterventionType,
  type LoopAttempt,
  type LoopBudget,
  type LoopRecord,
  type LoopTask,
  type PolicyPhase
} from "@martin/contracts";
import {
  classifyFailure,
  evaluateCostGovernor,
  inferExit,
  nextPolicyPhase,
  policyPhaseToLifecycleState,
  type CostGovernorState,
  type ExitDecision,
  type FailureAssessment
} from "./policy.js";
import { evaluateVerificationLeash } from "./leash.js";
import {
  buildRepoGroundingIndex,
  loadOrBuildRepoGroundingIndex,
  queryRepoGroundingIndex,
  type RepoGroundingHit,
  type RepoGroundingIndex
} from "./grounding.js";
import { compilePromptPacket } from "./compiler.js";
import { makeLedgerEvent, type RunStore } from "./persistence/index.js";

// ─── Public API re-exports ───────────────────────────────────────────────────
export type { FailureClass, InterventionType, PolicyPhase } from "@martin/contracts";
export {
  classifyFailure,
  evaluateCostGovernor,
  inferExit,
  nextPolicyPhase,
  policyPhaseToLifecycleState,
  evaluateVerificationLeash,
  buildRepoGroundingIndex,
  loadOrBuildRepoGroundingIndex,
  queryRepoGroundingIndex
};
export type { CostGovernorState, ExitDecision, FailureAssessment } from "./policy.js";
export type { SafetyLeashDecision } from "./leash.js";
export type { RepoGroundingHit, RepoGroundingIndex } from "./grounding.js";

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
    tokensIn: number;
    tokensOut: number;
  };
  verification: {
    passed: boolean;
    summary: string;
  };
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
        model: input.adapter.metadata.model
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
  let currentAdapter = input.adapter;
  let useCompressedContext = false;

  // Safety leash: block destructive verifier commands before any attempt
  const leashDecision = evaluateVerificationLeash({
    verificationPlan: input.task.verificationPlan,
    verificationStack: input.task.verificationStack
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
          focus: distilled.focus,
          remainingBudgetUsd: distilled.constraints.remainingBudgetUsd,
          remainingIterations: distilled.constraints.remainingIterations,
          remainingTokens: distilled.constraints.remainingTokens
        },
        previousAttempts: loop.attempts
      },
      projectedUsd: distilled.constraints.remainingBudgetUsd * 0.25 // conservative estimate
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
          payload: { attemptId, model: currentAdapter.metadata.model }
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
          adapterId: currentAdapter.adapterId,
          model: currentAdapter.metadata.model,
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
        focus: distilled.focus,
        remainingBudgetUsd: distilled.constraints.remainingBudgetUsd,
        remainingIterations: distilled.constraints.remainingIterations,
        remainingTokens: distilled.constraints.remainingTokens
      },
      previousAttempts: loop.attempts
    };

    const result = await currentAdapter.execute(request);
    const attemptCompletedAt = now();

    // PATCH → VERIFY
    currentPhase = "VERIFY";

    const failure =
      result.status === "failed"
        ? classifyFailure({ attempts: loop.attempts, result })
        : undefined;

    const currentAttemptIndex = loop.attempts.length + 1;
    const attempt: LoopAttempt = {
      attemptId,
      index: currentAttemptIndex,
      adapterId: currentAdapter.adapterId,
      model: currentAdapter.metadata.model,
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
        actualUsd: roundUsd(loop.cost.actualUsd + result.usage.actualUsd),
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

    if (failure) {
      if (failure.recommendedIntervention === "compress_context") {
        useCompressedContext = true;
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
      await input.store.writeAttemptArtifacts(loop.loopId, currentAttemptIndex, {
        compiledContext: compilePromptPacket(request)
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
            actualUsd: result.usage.actualUsd,
            tokensIn: result.usage.tokensIn,
            tokensOut: result.usage.tokensOut
          }
        })
      );
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

    const decision = inferExit({
      loop,
      lastResult: result,
      lastFailure: failure,
      costState
    });

    // Advance phase based on result
    currentPhase = nextPolicyPhase(currentPhase, result, costState, phaseRetryCount);
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

function roundUsd(value: number): number {
  return Math.round(value * 100) / 100;
}

function makeId(prefix: string, idFactory?: (prefix: string) => string): string {
  if (idFactory) return idFactory(prefix);
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}`;
}
