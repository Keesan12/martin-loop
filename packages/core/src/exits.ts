/**
 * Eight-Exit Runtime — pure deterministic evaluator.
 *
 * EXIT_PRECEDENCE rationale (product decision — see contracts/exits.ts for rationale;
 * any change to this array requires updating that paragraph in the same commit):
 *   human_interrupt > external_event > wall_clock > budget_cap > turn_cap >
 *   goal_met > error_threshold > no_progress
 */

import { createHash } from "node:crypto";
import type {
  ExitEvaluationPhase,
  ExitEvaluationV1,
  ExitKind,
  ExitMatchV1,
  ExitPolicyV1,
  ExitSignalV1,
  ExitSnapshotV1,
  LoopBudget,
  LoopLifecycleState,
  LoopStatus
} from "@martin/contracts";

// Precedence: human authority first, resource limits before goal success,
// resource exits ranked by urgency (wall_clock > budget_cap > turn_cap).
// Note: turn_cap is suppressed at signal-generation time when goalMet is true
// so goal_met and turn_cap cannot co-occur in practice.
const EXIT_PRECEDENCE: readonly ExitKind[] = [
  "human_interrupt",
  "external_event",
  "wall_clock",
  "budget_cap",
  "turn_cap",
  "goal_met",
  "error_threshold",
  "no_progress"
];

export interface LegacyExitDecision {
  shouldExit: boolean;
  lifecycleState: LoopLifecycleState;
  status: LoopStatus;
  reason: string;
  reasonCode?: string;
  failureClass?: string;
  safetySurface?: string;
  exitEvaluation: ExitEvaluationV1;
}

export interface ExitPolicyOverrides {
  goal?: Partial<ExitPolicyV1["goal"]>;
  turns?: Partial<ExitPolicyV1["turns"]>;
  budget?: Partial<ExitPolicyV1["budget"]>;
  wallClock?: Partial<ExitPolicyV1["wallClock"]>;
  progress?: Partial<ExitPolicyV1["progress"]>;
  errors?: Partial<ExitPolicyV1["errors"]>;
  humanInterrupt?: Partial<ExitPolicyV1["humanInterrupt"]>;
  externalEvent?: Partial<ExitPolicyV1["externalEvent"]>;
}

export function createDefaultExitPolicy(
  budget: LoopBudget,
  overrides: ExitPolicyOverrides = {}
): ExitPolicyV1 {
  const base: ExitPolicyV1 = {
    schemaVersion: "exit-policy/1",
    goal: { verifierRequired: true, minimumScore: 1 },
    turns: { max: budget.maxIterations },
    budget: {
      maxUsd: budget.maxUsd,
      ...(budget.maxTokens !== undefined ? { maxTokens: budget.maxTokens } : {})
    },
    wallClock: { maxElapsedMs: 30 * 60 * 1000 },
    progress: { windowSize: 3, unchangedStateLimit: 3 },
    errors: { maxConsecutive: 3 },
    humanInterrupt: { enabled: true },
    externalEvent: { enabled: true }
  };

  return {
    ...base,
    ...overrides,
    goal: { ...base.goal, ...overrides.goal },
    turns: { ...base.turns, ...overrides.turns },
    budget: { ...base.budget, ...overrides.budget },
    wallClock: { ...base.wallClock, ...overrides.wallClock },
    progress: { ...base.progress, ...overrides.progress },
    errors: { ...base.errors, ...overrides.errors },
    humanInterrupt: { ...base.humanInterrupt, ...overrides.humanInterrupt },
    externalEvent: { ...base.externalEvent, ...overrides.externalEvent }
  };
}

export function validateExitPolicy(policy: ExitPolicyV1): void {
  assertFinitePositive("turns.max", policy.turns.max);
  assertFinitePositive("budget.maxUsd", policy.budget.maxUsd);
  if (policy.budget.maxTokens !== undefined) {
    assertFinitePositive("budget.maxTokens", policy.budget.maxTokens);
  }
  assertFinitePositive("wallClock.maxElapsedMs", policy.wallClock.maxElapsedMs);
  assertFinitePositive("progress.windowSize", policy.progress.windowSize);
  assertFinitePositive("progress.unchangedStateLimit", policy.progress.unchangedStateLimit);
  assertFinitePositive("errors.maxConsecutive", policy.errors.maxConsecutive);

  if (policy.goal.minimumScore < 0 || policy.goal.minimumScore > 1) {
    throw new RangeError("goal.minimumScore must be between 0 and 1");
  }
  if (policy.progress.unchangedStateLimit > policy.progress.windowSize) {
    throw new RangeError(
      "progress.unchangedStateLimit cannot exceed progress.windowSize"
    );
  }
  if (policy.wallClock.deadlineAt !== undefined) {
    const parsed = Date.parse(policy.wallClock.deadlineAt);
    if (!Number.isFinite(parsed)) {
      throw new RangeError("wallClock.deadlineAt must be an ISO timestamp");
    }
  }
}

export function evaluateExitPolicy(
  policy: ExitPolicyV1,
  snapshot: ExitSnapshotV1
): ExitEvaluationV1 {
  validateExitPolicy(policy);
  const matches: ExitMatchV1[] = [];

  const push = (
    kind: ExitKind,
    reason: string,
    evidence: Record<string, unknown>
  ): void => {
    matches.push({ kind, reason, evidence });
  };

  // 1. Human interrupt (highest authority — cannot be argued with)
  if (policy.humanInterrupt.enabled && snapshot.humanInterrupt !== undefined) {
    push("human_interrupt", snapshot.humanInterrupt.reason ?? "Human interrupt requested.", {
      requestedAt: snapshot.humanInterrupt.requestedAt,
      requestedBy: snapshot.humanInterrupt.requestedBy
    });
  }

  // 2. External event
  if (policy.externalEvent.enabled && snapshot.externalEvent !== undefined) {
    push("external_event", snapshot.externalEvent.reason ?? "External terminal event observed.", {
      source: snapshot.externalEvent.source,
      event: snapshot.externalEvent.event,
      disposition: snapshot.externalEvent.disposition,
      subject: snapshot.externalEvent.subject,
      evidenceUri: snapshot.externalEvent.evidenceUri
    });
  }

  // 3. Goal met (verified success outranks resource exhaustion)
  const result = snapshot.result;
  const goalMet =
    result !== undefined &&
    result.status === "completed" &&
    (!policy.goal.verifierRequired || result.verificationPassed) &&
    result.verifierScore >= policy.goal.minimumScore;
  if (goalMet) {
    push("goal_met", "Configured verification goal passed.", {
      verifierScore: result.verifierScore,
      minimumScore: policy.goal.minimumScore
    });
  }

  // 4. Wall clock
  const elapsedMs = Math.max(0, snapshot.nowMs - snapshot.runStartedAtMs);
  const deadlineMs =
    policy.wallClock.deadlineAt === undefined
      ? undefined
      : Date.parse(policy.wallClock.deadlineAt);
  if (
    elapsedMs >= policy.wallClock.maxElapsedMs ||
    (deadlineMs !== undefined && snapshot.nowMs >= deadlineMs)
  ) {
    push("wall_clock", "Run wall-clock limit reached.", {
      elapsedMs,
      maxElapsedMs: policy.wallClock.maxElapsedMs,
      deadlineAt: policy.wallClock.deadlineAt
    });
  }

  // 5. Budget cap
  const usdExceeded = snapshot.actualUsd >= policy.budget.maxUsd;
  const tokensExceeded =
    policy.budget.maxTokens !== undefined && snapshot.tokensUsed >= policy.budget.maxTokens;
  if (usdExceeded || tokensExceeded) {
    push("budget_cap", "Run token or dollar budget reached.", {
      actualUsd: snapshot.actualUsd,
      maxUsd: policy.budget.maxUsd,
      tokensUsed: snapshot.tokensUsed,
      ...(policy.budget.maxTokens !== undefined ? { maxTokens: policy.budget.maxTokens } : {}),
      usdExceeded,
      tokensExceeded
    });
  }

  // 6. Turn cap — suppressed when goalMet: completing on the final allowed
  // iteration is legitimate success, not an overrun. turn_cap fires only when
  // iterations are exhausted without verified completion.
  if (!goalMet && snapshot.turnsUsed >= policy.turns.max) {
    push("turn_cap", "Run iteration limit reached.", {
      turnsUsed: snapshot.turnsUsed,
      maxTurns: policy.turns.max
    });
  }

  // 7. Error threshold
  if (snapshot.consecutiveErrors >= policy.errors.maxConsecutive) {
    push("error_threshold", "Consecutive error threshold reached.", {
      consecutiveErrors: snapshot.consecutiveErrors,
      maxConsecutive: policy.errors.maxConsecutive
    });
  }

  // 8. No progress — only fires when the window is FULL (A3 fix: sub-window must not fire)
  const requiredHashes = policy.progress.unchangedStateLimit;
  const recentHashes = snapshot.recentStateHashes.slice(-requiredHashes);
  const hashStall =
    recentHashes.length === requiredHashes && new Set(recentHashes).size === 1;
  if (hashStall || snapshot.trajectoryStop?.shouldStop === true) {
    push(
      "no_progress",
      snapshot.trajectoryStop?.reason ?? "Canonical run state stopped changing.",
      {
        unchangedStateCount: hashStall ? recentHashes.length : 0,
        stateHash: hashStall ? recentHashes[0] : undefined,
        trajectoryStop: snapshot.trajectoryStop?.shouldStop ?? false
      }
    );
  }

  const matched = EXIT_PRECEDENCE.filter((kind) =>
    matches.some((m) => m.kind === kind)
  );

  return {
    schemaVersion: "exit-evaluation/1",
    policyVersion: policy.schemaVersion,
    shouldExit: matched.length > 0,
    ...(matched[0] === undefined ? {} : { primary: matched[0] }),
    matched,
    phase: snapshot.phase,
    evaluatedAt: snapshot.evaluatedAt,
    matches
  };
}

export function toLegacyExitDecision(
  evaluation: ExitEvaluationV1,
  externalDisposition?: "satisfied" | "superseded" | "cancelled"
): LegacyExitDecision {
  const primary = evaluation.primary;
  if (primary === undefined) {
    return {
      shouldExit: false,
      lifecycleState: "running",
      status: "running",
      reason: "No exit condition matched.",
      exitEvaluation: evaluation
    };
  }

  const reason =
    evaluation.matches.find((m) => m.kind === primary)?.reason ??
    `MartinLoop exited because ${primary} fired.`;

  if (primary === "goal_met") {
    return completed(reason, primary, evaluation);
  }
  if (primary === "external_event" && externalDisposition === "satisfied") {
    return completed(reason, primary, evaluation);
  }
  if (primary === "human_interrupt") {
    return exited("human_escalation", reason, primary, evaluation);
  }
  if (primary === "budget_cap" || primary === "turn_cap") {
    return exited("budget_exit", reason, primary, evaluation);
  }
  if (primary === "no_progress") {
    return exited("diminishing_returns", reason, primary, evaluation);
  }
  if (primary === "error_threshold") {
    return exited("error_threshold", reason, primary, evaluation);
  }
  if (primary === "wall_clock") {
    return exited("wall_clock", reason, primary, evaluation);
  }
  if (primary === "external_event") {
    return exited("external_event", reason, primary, evaluation);
  }
  return exited("stuck_exit", reason, primary, evaluation);
}

/**
 * Hash the meaningful workspace/verification state for no-progress detection.
 * Excludes timestamps, cost counters, prose summaries — only structural changes count.
 */
export function hashProgressState(value: unknown): string {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(",")}]`;
  }
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableJson(obj[k])}`)
    .join(",")}}`;
}

function completed(
  reason: string,
  primary: ExitKind,
  evaluation: ExitEvaluationV1
): LegacyExitDecision {
  return {
    shouldExit: true,
    lifecycleState: "completed",
    status: "completed",
    reason,
    reasonCode: primary,
    exitEvaluation: evaluation
  };
}

function exited(
  lifecycleState: LoopLifecycleState,
  reason: string,
  primary: ExitKind,
  evaluation: ExitEvaluationV1
): LegacyExitDecision {
  return {
    shouldExit: true,
    lifecycleState,
    status: "exited",
    reason,
    reasonCode: primary,
    exitEvaluation: evaluation
  };
}

function assertFinitePositive(name: string, value: number): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${name} must be a finite number greater than zero`);
  }
}

/** @deprecated Use evaluateExitPolicy instead. Retained for downstream compatibility. */
export { inferExitCompat as inferExitCompat };
function inferExitCompat(_unused: unknown): never {
  throw new Error(
    "inferExitCompat is a compatibility stub — call evaluateExitPolicy directly"
  );
}
