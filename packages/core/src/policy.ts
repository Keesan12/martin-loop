import type {
  BudgetPreflightEstimate,
  CostProvenance,
  EvidenceVector,
  FailureClass,
  InterventionType,
  LoopAttempt,
  LoopBudget,
  LoopCost,
  LoopLifecycleState,
  LoopStatus,
  PatchDecision,
  PatchDecisionArtifact,
  PatchDecisionReasonCode,
  PatchScore,
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
  usage?: {
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
  canSwitchAdapter?: boolean;
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
    !input.lastFailure.retryable &&
    !input.canSwitchAdapter
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

// ─── Phase 4: Budget Preflight ───────────────────────────────────────────────

export interface BudgetPreflightInput {
  promptCharCount: number;
  attemptCount: number;
  remainingBudgetUsd: number;
  perAttemptCapUsd?: number;
  pricePerMTokenUsd?: number;
}

export interface BudgetPreflightDecision {
  allowed: boolean;
  reason: string;
  estimate: BudgetPreflightEstimate;
}

export function evaluateBudgetPreflight(input: BudgetPreflightInput): BudgetPreflightDecision {
  const pricePerMToken = input.pricePerMTokenUsd ?? 3.0;
  const rawPromptTokens = Math.ceil(input.promptCharCount / 4);
  const estimatedPromptTokens = Math.ceil(rawPromptTokens * 1.2);
  const estimatedToolOverheadTokens = 800 + input.attemptCount * 200;
  const estimatedOutputTokensMax = 4_000;
  const estimatedVerifierCostUsd = 0.01;
  const estimatedAttemptCostUsd =
    roundUsd(
      ((estimatedPromptTokens + estimatedToolOverheadTokens + estimatedOutputTokensMax) /
        1_000_000) *
        pricePerMToken
    ) + estimatedVerifierCostUsd;
  const provenance: CostProvenance = "estimated";
  const estimate: BudgetPreflightEstimate = {
    estimatedPromptTokens,
    estimatedToolOverheadTokens,
    estimatedOutputTokensMax,
    estimatedVerifierCostUsd,
    estimatedAttemptCostUsd,
    provenance
  };

  if (estimatedAttemptCostUsd > input.remainingBudgetUsd) {
    return {
      allowed: false,
      reason: `Preflight: estimated attempt cost $${estimatedAttemptCostUsd} exceeds remaining budget $${input.remainingBudgetUsd}.`,
      estimate
    };
  }

  const perAttemptCap = input.perAttemptCapUsd ?? Math.max(input.remainingBudgetUsd * 0.2, 0.05);
  if (estimatedAttemptCostUsd > perAttemptCap) {
    return {
      allowed: false,
      reason: `Preflight: estimated attempt cost $${estimatedAttemptCostUsd} exceeds per-attempt cap $${roundUsd(perAttemptCap)}.`,
      estimate
    };
  }

  return {
    allowed: true,
    reason: "Preflight passed.",
    estimate
  };
}

// ─── Phase 4: EvidenceVector + Recovery Recipes ──────────────────────────────

export interface EvidenceVectorInput {
  compilerOutput?: string;
  testOutput?: string;
  diff?: string;
  previousDiff?: string;
  forbiddenTouchedFiles?: string[];
  missingSymbols?: string[];
  actualUsd?: number;
  previousVerifierScore?: number;
  verifierScore?: number;
  retryCountForSurface?: number;
}

export function computeEvidenceVector(input: EvidenceVectorInput): EvidenceVector {
  const typeErrors = input.compilerOutput
    ? (input.compilerOutput.match(/\berror TS\d+/g) ?? []).length
    : 0;
  const compileErrors =
    typeErrors +
    (input.compilerOutput ? (input.compilerOutput.match(/\bSyntaxError\b/g) ?? []).length : 0);
  const failingTests = input.testOutput
    ? (input.testOutput.match(/\bFAIL\b/gi) ?? []).length +
      (input.testOutput.match(/\bfailed\b/gi) ?? []).length +
      (input.testOutput.match(/[✗×]/g) ?? []).length
    : 0;
  const verifierScore = input.verifierScore ?? 0;
  let diffNovelty = 1;

  if (input.diff && input.previousDiff) {
    const currentTokens = tokenizeDiff(input.diff);
    const previousTokens = tokenizeDiff(input.previousDiff);
    if (previousTokens.size > 0) {
      const overlap = [...currentTokens].filter((token) => previousTokens.has(token)).length;
      const similarity = overlap / Math.max(currentTokens.size, previousTokens.size, 1);
      diffNovelty = Math.max(0, 1 - similarity);
    }
  }

  const forbiddenTouchedFileCount = input.forbiddenTouchedFiles?.length ?? 0;
  const missingSymbolCount = input.missingSymbols?.length ?? 0;
  const progressDelta =
    input.verifierScore !== undefined && input.previousVerifierScore !== undefined
      ? Math.max(0, input.verifierScore - input.previousVerifierScore)
      : 0;
  const costPerProgressUnit =
    progressDelta > 0 && input.actualUsd !== undefined ? roundUsd(input.actualUsd / progressDelta) : 0;
  const safetyRiskScore = Math.min(
    1,
    forbiddenTouchedFileCount * 0.3 + missingSymbolCount * 0.1
  );

  return {
    compileErrors,
    typeErrors,
    failingTests,
    verifierScore,
    diffNovelty,
    forbiddenTouchedFileCount,
    missingSymbolCount,
    costPerProgressUnit,
    retryCountForSurface: input.retryCountForSurface ?? 0,
    safetyRiskScore
  };
}

export type RecoveryRecipe =
  | "narrow_prompt_targeted_files"
  | "failing_tests_only"
  | "force_repo_anatomy_slices"
  | "tighten_allowlist_reduce_patch"
  | "strategy_swap"
  | "abort_safety_violation"
  | "downgrade_model"
  | "escalate_human";

export interface RecoveryDecision {
  recipe: RecoveryRecipe;
  rationale: string;
  intervention: InterventionType;
}

export interface PatchDecisionInput {
  verificationPassed: boolean;
  previousVerifierScore?: number;
  verifierScore?: number;
  groundingViolationCount?: number;
  safetyViolationCount?: number;
  scopeViolationCount?: number;
  changedFileCount?: number;
  diffNovelty?: number;
  diffStats?: {
    filesChanged: number;
    addedLines: number;
    deletedLines: number;
  };
  costUsd?: number;
  humanApprovalRequired?: boolean;
  summary?: string;
}

export interface EvaluatedPatchDecision extends PatchDecisionArtifact {
  score: PatchScore;
}

export function selectRecoveryRecipe(evidence: EvidenceVector): RecoveryDecision {
  if (evidence.safetyRiskScore >= 0.7 || evidence.forbiddenTouchedFileCount > 2) {
    return {
      recipe: "abort_safety_violation",
      rationale: "High safety risk score or multiple forbidden file touches. Abort required.",
      intervention: "escalate_human"
    };
  }

  if (evidence.missingSymbolCount > 0 && evidence.retryCountForSurface <= 1) {
    return {
      recipe: "force_repo_anatomy_slices",
      rationale: "Missing symbols detected. Force repo grounding context into the next prompt.",
      intervention: "run_verifier"
    };
  }

  if (evidence.forbiddenTouchedFileCount > 0) {
    return {
      recipe: "tighten_allowlist_reduce_patch",
      rationale: "Patch touched forbidden files. Tighten scope and reduce patch budget.",
      intervention: "tighten_task"
    };
  }

  if (evidence.compileErrors > 0 || evidence.typeErrors > 0) {
    return {
      recipe: "narrow_prompt_targeted_files",
      rationale: "Compile or type errors detected. Narrow the next prompt to targeted files.",
      intervention: "compress_context"
    };
  }

  if (evidence.failingTests > 0 && evidence.retryCountForSurface <= 2) {
    return {
      recipe: "failing_tests_only",
      rationale: "Test failures remain. Focus on the failing tests and touched files only.",
      intervention: "run_verifier"
    };
  }

  if (evidence.diffNovelty < 0.2) {
    if (evidence.retryCountForSurface >= 2) {
      return {
        recipe: "strategy_swap",
        rationale: "Very low diff novelty across repeated retries. Swap strategy.",
        intervention: "change_model"
      };
    }

    return {
      recipe: "narrow_prompt_targeted_files",
      rationale: "Low diff novelty suggests repetition. Compress context and narrow focus.",
      intervention: "compress_context"
    };
  }

  if (evidence.costPerProgressUnit > 5 || evidence.retryCountForSurface >= 3) {
    return {
      recipe: "downgrade_model",
      rationale: "Cost efficiency is degrading or retries are exhausted. Downgrade the model.",
      intervention: "change_model"
    };
  }

  return {
    recipe: "escalate_human",
    rationale: "No specific recovery pattern matched. Escalate for human review.",
    intervention: "escalate_human"
  };
}

export function evaluatePatchDecision(input: PatchDecisionInput): EvaluatedPatchDecision {
  const score = scorePatchDecision(input);
  const reasonCodes = [...score.reasonCodes];
  const decision = decidePatchOutcome(input, reasonCodes);

  return {
    decision,
    summary: buildPatchDecisionSummary(decision, reasonCodes, input.summary),
    reasonCodes,
    score
  };
}

export function scorePatchDecision(input: PatchDecisionInput): PatchScore {
  const verifierScore = input.verifierScore ?? (input.verificationPassed ? 1 : 0);
  const previousVerifierScore = input.previousVerifierScore ?? 0;
  const verifierDelta = roundScore(verifierScore - previousVerifierScore);
  const groundingViolationCount = input.groundingViolationCount ?? 0;
  const scopeViolationCount = input.scopeViolationCount ?? 0;
  const safetyViolationCount = input.safetyViolationCount ?? 0;
  const changedFileEvidenceAvailable = input.changedFileCount !== undefined;
  const changedFileCount = input.changedFileCount ?? 0;
  const noveltyScore = input.diffNovelty ?? (changedFileCount > 0 ? 1 : 0);
  const diffRiskScore = computeDiffRiskScore(input.diffStats);
  const costUsd = roundUsd(input.costUsd ?? 0);
  const reasonCodes: PatchDecisionReasonCode[] = [];

  if (input.verificationPassed) {
    reasonCodes.push("verifier_passed");
  }
  if (groundingViolationCount > 0) {
    reasonCodes.push("grounding_failure");
  }
  if (scopeViolationCount > 0) {
    reasonCodes.push("scope_violation");
  }
  if (changedFileEvidenceAvailable && changedFileCount === 0) {
    reasonCodes.push("no_code_change");
  }
  if (input.humanApprovalRequired) {
    reasonCodes.push("human_approval_required");
  }
  if (safetyViolationCount > 0) {
    reasonCodes.push("safety_violation");
  }
  if (verifierDelta < 0) {
    reasonCodes.push("verifier_regressed");
  }
  if (!input.verificationPassed && noveltyScore < 0.2 && verifierDelta <= 0) {
    reasonCodes.push("low_novelty_no_progress");
  }
  if (!input.verificationPassed && diffRiskScore >= 0.7 && verifierDelta <= 0) {
    reasonCodes.push("large_diff_no_improvement");
  }
  if (
    !input.verificationPassed &&
    reasonCodes.length === 0
  ) {
    reasonCodes.push("verifier_not_improved");
  }

  let score = 0;
  if (input.verificationPassed) {
    score += 0.55;
  }
  score += Math.max(verifierDelta, 0) * 0.2;
  score -= groundingViolationCount * 0.45;
  score -= scopeViolationCount * 0.35;
  score -= safetyViolationCount * 0.45;
  if (input.humanApprovalRequired) {
    score -= 0.25;
  }
  if (changedFileEvidenceAvailable && changedFileCount === 0) {
    score -= 0.35;
  }
  if (!input.verificationPassed && noveltyScore < 0.2 && verifierDelta <= 0) {
    score -= 0.2;
  }
  if (!input.verificationPassed && diffRiskScore >= 0.7 && verifierDelta <= 0) {
    score -= 0.25;
  }
  score -= diffRiskScore * 0.1;
  score -= Math.min(costUsd / 10, 0.1);

  return {
    score: roundScore(Math.max(-1, Math.min(1, score))),
    verifierScore: roundScore(verifierScore),
    verifierDelta,
    groundingViolationCount,
    scopeViolationCount,
    safetyViolationCount,
    changedFileCount,
    diffRiskScore,
    noveltyScore: roundScore(noveltyScore),
    costUsd,
    reasonCodes
  };
}

function tokenizeDiff(diff: string): Set<string> {
  const tokens = new Set<string>();

  for (const line of diff.split("\n")) {
    if ((!line.startsWith("+") && !line.startsWith("-")) || line.startsWith("+++") || line.startsWith("---")) {
      continue;
    }

    for (const token of line.slice(1).match(/[A-Za-z_][A-Za-z0-9_]{2,}/g) ?? []) {
      tokens.add(token);
    }
  }

  return tokens;
}

function decidePatchOutcome(
  input: PatchDecisionInput,
  reasonCodes: PatchDecisionReasonCode[]
): PatchDecision {
  if (input.humanApprovalRequired || reasonCodes.includes("safety_violation")) {
    return "ESCALATE";
  }

  if (
    reasonCodes.includes("grounding_failure") ||
    reasonCodes.includes("scope_violation") ||
    reasonCodes.includes("no_code_change") ||
    reasonCodes.includes("verifier_regressed") ||
    reasonCodes.includes("large_diff_no_improvement") ||
    reasonCodes.includes("low_novelty_no_progress") ||
    reasonCodes.includes("verifier_not_improved")
  ) {
    return "DISCARD";
  }

  if (input.verificationPassed) {
    return "KEEP";
  }

  return "DISCARD";
}

function buildPatchDecisionSummary(
  decision: PatchDecision,
  reasonCodes: PatchDecisionReasonCode[],
  summary?: string
): string {
  const headline = {
    KEEP: "Patch kept.",
    DISCARD: "Patch discarded.",
    ESCALATE: "Patch requires escalation.",
    HANDOFF: "Patch requires handoff."
  }[decision];
  const reasons = reasonCodes.join(", ");

  if (summary) {
    return `${headline} Reasons: ${reasons || "none"}. Attempt summary: ${summary}`;
  }

  return `${headline} Reasons: ${reasons || "none"}.`;
}

function computeDiffRiskScore(input?: {
  filesChanged: number;
  addedLines: number;
  deletedLines: number;
}): number {
  if (!input) {
    return 0;
  }

  const fileRisk = Math.min(input.filesChanged / 8, 1);
  const lineRisk = Math.min((input.addedLines + input.deletedLines) / 200, 1);
  return roundScore(Math.max(fileRisk, lineRisk));
}

function roundScore(value: number): number {
  return Math.round(value * 100) / 100;
}
