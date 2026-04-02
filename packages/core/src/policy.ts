import type {
  FailureClass,
  InterventionType,
  LoopAttempt,
  LoopBudget,
  LoopCost,
  LoopLifecycleState,
  LoopStatus,
  PolicyPhase
} from "@martin/contracts";

export interface FailureAssessment {
  failureClass: FailureClass;
  rationale: string;
  retryable: boolean;
  recommendedIntervention: InterventionType;
}

export interface CostGovernorState {
  pressure: "healthy" | "soft_limit" | "hard_limit";
  shouldStop: boolean;
  remainingBudgetUsd: number;
  remainingIterations: number;
  remainingTokens: number;
  recommendedIntervention?: InterventionType;
}

export interface ExitDecision {
  shouldExit: boolean;
  lifecycleState: LoopLifecycleState;
  status: LoopStatus;
  reason: string;
}

export interface MartinAdapterResultLike {
  status: "completed" | "failed";
  summary: string;
  verification: {
    passed: boolean;
    summary: string;
  };
  failure?: {
    message: string;
    classHint?: FailureClass;
  };
}

/**
 * Maps a PolicyPhase to the LoopLifecycleState used in events and persistence.
 * FailureClass remains a thin output label — policy reads EvidenceVector, not the label.
 */
export function policyPhaseToLifecycleState(phase: PolicyPhase): LoopLifecycleState {
  switch (phase) {
    case "GATHER":
    case "ADMIT":
    case "PATCH":
      return "running";
    case "VERIFY":
      return "verifying";
    case "RECOVER":
      return "running";
    case "ESCALATE":
    case "HANDOFF":
      return "human_escalation";
    case "ABORT":
      return "stuck_exit";
    default:
      return "running";
  }
}

/**
 * Determines the next PolicyPhase given the current phase and last result.
 * This is the explicit typed transition table — no implicit fallthrough.
 */
export function nextPolicyPhase(
  current: PolicyPhase,
  result: MartinAdapterResultLike,
  costState: CostGovernorState,
  retryCount: number
): PolicyPhase {
  // Successful verification → complete via HANDOFF
  if (result.status === "completed" && result.verification.passed) {
    return "HANDOFF";
  }

  // Hard budget limit → ABORT
  if (costState.shouldStop) {
    return "ABORT";
  }

  switch (current) {
    case "GATHER":
      return "ADMIT";
    case "ADMIT":
      return "PATCH";
    case "PATCH":
      return "VERIFY";
    case "VERIFY":
      return retryCount >= 2 ? "ESCALATE" : "RECOVER";
    case "RECOVER":
      return retryCount >= 3 ? "ESCALATE" : "PATCH";
    case "ESCALATE":
      return "ABORT";
    case "ABORT":
    case "HANDOFF":
      return current; // terminal — no further transitions
    default:
      return "PATCH";
  }
}

export function classifyFailure(input: {
  attempts: LoopAttempt[];
  result: MartinAdapterResultLike;
}): FailureAssessment {
  if (input.result.failure?.classHint) {
    return mapClassHintToAssessment(input.result.failure.classHint, input.attempts);
  }

  const message = [
    input.result.summary,
    input.result.verification.summary,
    input.result.failure?.message
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  const repeatedFailure = detectRepeatedFailure(input.attempts);

  if (
    containsPositive(message, [
      "enoent",
      "command not found",
      "missing from path",
      "not in path",
      "could not find"
    ])
  ) {
    return {
      failureClass: "environment_mismatch",
      rationale: "The adapter could not access the required local runtime or CLI tooling.",
      retryable: false,
      recommendedIntervention: "switch_adapter"
    };
  }

  if (containsPositive(message, ["syntax error", "parse error", "typescript error"])) {
    return {
      failureClass: "syntax_error",
      rationale: "The attempt failed on a parser or compiler-style issue.",
      retryable: true,
      recommendedIntervention: "compress_context"
    };
  }

  if (
    containsPositive(message, [
      "cannot find module",
      "module not found",
      "cannot resolve module",
      "cannot find name",
      "does not exist on type",
      "no such file or directory",
      "unknown import",
      "unknown symbol",
      "undefined reference"
    ])
  ) {
    return {
      failureClass: "repo_grounding_failure",
      rationale:
        "The attempt referenced modules, symbols, or files that are not grounded in the repo or approved docs.",
      retryable: true,
      recommendedIntervention:
        repeatedFailure === "repo_grounding_failure" ? "tighten_task" : "run_verifier"
    };
  }

  if (
    containsPositive(message, [
      "verification failed",
      "test failed",
      "regression",
      "failing test",
      "assertionerror"
    ])
  ) {
    return {
      failureClass: "verification_failure",
      rationale: "The proposed fix did not satisfy the verification gate.",
      retryable: true,
      recommendedIntervention:
        repeatedFailure === "verification_failure" ? "tighten_task" : "run_verifier"
    };
  }

  if (
    containsPositive(message, [
      "scope creep",
      "too broad",
      "unrelated files",
      "outside allowed paths",
      "forbidden file"
    ])
  ) {
    return {
      failureClass: "scope_creep",
      rationale: "The attempt drifted away from the original task boundary.",
      retryable: true,
      recommendedIntervention: "tighten_task"
    };
  }

  if (!input.result.verification.passed) {
    return {
      failureClass: "verification_failure",
      rationale: "Verification did not pass and no specific failure pattern was detected.",
      retryable: true,
      recommendedIntervention:
        repeatedFailure === "verification_failure" ? "tighten_task" : "run_verifier"
    };
  }

  if (detectOscillation(input.attempts)) {
    return {
      failureClass: "logic_error",
      rationale: "Oscillating failure pattern detected — switching strategy to break the cycle.",
      retryable: true,
      recommendedIntervention: "change_model"
    };
  }

  return {
    failureClass: repeatedFailure ?? "logic_error",
    rationale: "The loop is still failing to produce a correct implementation.",
    retryable: true,
    recommendedIntervention:
      repeatedFailure === "logic_error" ? "change_model" : "compress_context"
  };
}

export function evaluateCostGovernor(input: {
  budget: LoopBudget;
  cost: LoopCost;
  attemptsUsed: number;
}): CostGovernorState {
  const remainingBudgetUsd = roundUsd(input.budget.maxUsd - input.cost.actualUsd);
  const remainingIterations = Math.max(input.budget.maxIterations - input.attemptsUsed, 0);
  const remainingTokens = Math.max(
    input.budget.maxTokens - input.cost.tokensIn - input.cost.tokensOut,
    0
  );

  if (
    input.cost.actualUsd >= input.budget.maxUsd ||
    input.attemptsUsed >= input.budget.maxIterations ||
    remainingTokens <= 0
  ) {
    return {
      pressure: "hard_limit",
      shouldStop: true,
      remainingBudgetUsd,
      remainingIterations,
      remainingTokens,
      recommendedIntervention: "stop_loop"
    };
  }

  if (input.cost.actualUsd >= input.budget.softLimitUsd) {
    return {
      pressure: "soft_limit",
      shouldStop: false,
      remainingBudgetUsd,
      remainingIterations,
      remainingTokens,
      recommendedIntervention: "compress_context"
    };
  }

  return {
    pressure: "healthy",
    shouldStop: false,
    remainingBudgetUsd,
    remainingIterations,
    remainingTokens
  };
}

export function inferExit(input: {
  loop: { budget: LoopBudget; cost: LoopCost; attempts: LoopAttempt[] };
  lastResult: MartinAdapterResultLike;
  lastFailure?: FailureAssessment;
  costState: CostGovernorState;
}): ExitDecision {
  if (input.lastResult.status === "completed" && input.lastResult.verification.passed) {
    return {
      shouldExit: true,
      lifecycleState: "completed",
      status: "completed",
      reason: "Martin verified the fix and can hard-complete the loop."
    };
  }

  if (input.costState.shouldStop) {
    return {
      shouldExit: true,
      lifecycleState: "budget_exit",
      status: "exited",
      reason: "Martin exited because the budget governor hit a hard limit."
    };
  }

  if (detectOscillation(input.loop.attempts)) {
    return {
      shouldExit: true,
      lifecycleState: "diminishing_returns",
      status: "exited",
      reason:
        "Oscillating failure pattern detected — loop is cycling without measurable progress."
    };
  }

  const lastTwo = input.loop.attempts.slice(-2);
  const repeatedFailure =
    lastTwo.length === 2 &&
    lastTwo.every(
      (attempt) =>
        attempt.failureClass &&
        attempt.failureClass === lastTwo[0]?.failureClass &&
        attempt.failureClass === input.lastFailure?.failureClass
    );

  if (repeatedFailure && input.lastFailure) {
    return {
      shouldExit: true,
      lifecycleState: "diminishing_returns",
      status: "exited",
      reason: `Martin exited because ${input.lastFailure.failureClass} repeated across consecutive attempts.`
    };
  }

  if (
    input.lastFailure?.failureClass === "environment_mismatch" &&
    !input.lastFailure.retryable
  ) {
    return {
      shouldExit: true,
      lifecycleState: "stuck_exit",
      status: "exited",
      reason:
        "Martin exited because the runtime environment could not support the requested adapter."
    };
  }

  return {
    shouldExit: false,
    lifecycleState: "running",
    status: "running",
    reason: "Martin should continue with another attempt."
  };
}

function containsPositive(haystack: string, needles: string[]): boolean {
  return needles.some((needle) => {
    const idx = haystack.indexOf(needle);
    if (idx === -1) return false;
    const before = haystack.slice(Math.max(0, idx - 30), idx);
    return !/\b(no|not|without|zero|pass|passes|passing|passed|clear|cleared|fix|fixed|resolve|resolved|0)\s*$/u.test(
      before
    );
  });
}

function detectOscillation(attempts: LoopAttempt[]): boolean {
  const classes = attempts
    .slice(-4)
    .map((a) => a.failureClass)
    .filter(Boolean);
  if (classes.length < 3) return false;
  if (classes[0] !== classes[1] && classes[0] === classes[2]) return true;
  if (
    classes.length >= 4 &&
    classes[0] !== classes[1] &&
    classes[0] === classes[2] &&
    classes[1] === classes[3]
  )
    return true;
  return false;
}

function mapClassHintToAssessment(
  classHint: FailureClass,
  attempts: LoopAttempt[]
): FailureAssessment {
  const repeatedFailure = detectRepeatedFailure(attempts);

  switch (classHint) {
    case "syntax_error":
      return {
        failureClass: "syntax_error",
        rationale: "Structural evidence: non-zero exit code with compiler-like error output.",
        retryable: true,
        recommendedIntervention: "compress_context"
      };
    case "repo_grounding_failure":
      return {
        failureClass: "repo_grounding_failure",
        rationale: "Structural evidence: missing repo module, symbol, or file reference.",
        retryable: true,
        recommendedIntervention:
          repeatedFailure === "repo_grounding_failure" ? "tighten_task" : "run_verifier"
      };
    case "scope_creep":
      return {
        failureClass: "scope_creep",
        rationale:
          "Structural evidence: agent output exceeded the task contract or touched forbidden files.",
        retryable: true,
        recommendedIntervention: "tighten_task"
      };
    case "hallucination":
      return {
        failureClass: "hallucination",
        rationale: "Structural evidence: suspiciously short or trivial agent response.",
        retryable: true,
        recommendedIntervention:
          repeatedFailure === "hallucination" ? "change_model" : "run_verifier"
      };
    case "verification_failure":
    case "test_regression":
      return {
        failureClass: classHint,
        rationale: "Structural evidence: verification commands did not pass.",
        retryable: true,
        recommendedIntervention:
          repeatedFailure === classHint ? "tighten_task" : "run_verifier"
      };
    default:
      return {
        failureClass: classHint,
        rationale: "Structural hint provided by adapter.",
        retryable: true,
        recommendedIntervention: repeatedFailure ? "change_model" : "compress_context"
      };
  }
}

function detectRepeatedFailure(attempts: LoopAttempt[]): FailureClass | undefined {
  const lastTwo = attempts.slice(-2);
  if (
    lastTwo.length === 2 &&
    lastTwo[0]?.failureClass &&
    lastTwo[0].failureClass === lastTwo[1]?.failureClass
  ) {
    return lastTwo[0].failureClass;
  }
  return undefined;
}

function roundUsd(value: number): number {
  return Math.round(value * 100) / 100;
}
