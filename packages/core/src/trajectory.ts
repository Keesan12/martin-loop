// SPDX-FileCopyrightText: MartinLoop contributors
//
// SPDX-License-Identifier: Apache-2.0

import {
  cloneCircuitBreakDecision,
  cloneTrajectoryAssessment,
  type CircuitBreakDecision,
  type InterventionType,
  type TrajectoryAssessment,
  type TrajectorySignal
} from "@martin/contracts";

const STOP_WORDS = new Set([
  "about",
  "after",
  "again",
  "along",
  "also",
  "been",
  "before",
  "being",
  "between",
  "could",
  "failed",
  "failure",
  "from",
  "have",
  "into",
  "just",
  "keep",
  "made",
  "make",
  "need",
  "only",
  "over",
  "same",
  "should",
  "still",
  "than",
  "that",
  "their",
  "them",
  "then",
  "there",
  "these",
  "they",
  "this",
  "those",
  "touching",
  "without",
  "would"
]);

const STALL_FAILURE_CLASSES: ReadonlySet<string> = new Set([
  "logic_error",
  "verification_failure",
  "repo_grounding_failure",
  "scope_creep",
  "no_progress"
]);

export function assessTrajectory(input: {
  objective: string;
  verificationPlan?: string[];
  attempts: TrajectoryAttemptLike[];
}): TrajectoryAssessment {
  const attempts = input.attempts.filter((attempt) => attempt.index > 0);
  if (attempts.length === 0) {
    return cloneTrajectoryAssessment({
      status: "healthy",
      confidence: "low",
      summary: "No prior attempts exist, so Martin has no drift evidence yet.",
      signals: []
    });
  }

  const signals: TrajectorySignal[] = [];
  const recentAttempts = attempts.slice(-4);
  const lastThree = recentAttempts.slice(-3);
  const lastTwo = recentAttempts.slice(-2);

  const oscillation = detectFailureOscillation(lastThree);
  if (oscillation) {
    signals.push(oscillation);
  }

  const repetition = detectAttemptRepetition(lastThree);
  if (repetition) {
    signals.push(repetition);
  }

  const verificationStall = detectVerificationStall(lastTwo);
  if (verificationStall) {
    signals.push(verificationStall);
  }

  const objectiveDrift = detectObjectiveDrift({
    objective: input.objective,
    verificationPlan: input.verificationPlan,
    attempts: lastTwo
  });
  if (objectiveDrift) {
    signals.push(objectiveDrift);
  }

  const status = deriveTrajectoryStatus(signals);
  const confidence = deriveTrajectoryConfidence(signals);
  const recommendedIntervention = deriveRecommendedIntervention(signals);

  if (signals.length === 0) {
    return cloneTrajectoryAssessment({
      status: "healthy",
      confidence: "medium",
      summary: "Recent attempts stay aligned enough that Martin does not need a circuit break yet.",
      signals: []
    });
  }

  const summary = summarizeTrajectory(status, signals);
  return cloneTrajectoryAssessment({
    status,
    confidence,
    summary,
    signals,
    ...(recommendedIntervention ? { recommendedIntervention } : {})
  });
}

export function decideCircuitBreak(input: {
  objective: string;
  verificationPlan?: string[];
  attempts: TrajectoryAttemptLike[];
  remainingIterations?: number;
}): CircuitBreakDecision {
  const assessment = assessTrajectory(input);
  const remainingIterations = input.remainingIterations ?? Number.POSITIVE_INFINITY;
  const stopForHighSignal = assessment.signals.some((signal) => signal.severity === "high");
  const stopForLateDrift =
    assessment.status === "drifting" &&
    remainingIterations <= 1 &&
    assessment.signals.some((signal) => signal.code === "objective_drift");
  const stopForLateStall =
    assessment.status === "watch" &&
    remainingIterations <= 1 &&
    assessment.signals.some((signal) => signal.code === "verification_stall");

  const shouldStop = stopForHighSignal || stopForLateDrift || stopForLateStall;

  return cloneCircuitBreakDecision({
    shouldStop,
    reason: shouldStop
      ? assessment.summary
      : "Trajectory signals do not justify a hard circuit break yet.",
    assessment,
    ...(assessment.recommendedIntervention
      ? { recommendedIntervention: assessment.recommendedIntervention }
      : {})
  });
}

function detectFailureOscillation(
  attempts: Pick<TrajectoryAttemptLike, "index" | "failureClass">[]
): TrajectorySignal | undefined {
  if (attempts.length < 3) {
    return undefined;
  }

  const [first, second, third] = attempts;
  if (
    !first?.failureClass ||
    !second?.failureClass ||
    !third?.failureClass ||
    first.failureClass === second.failureClass ||
    first.failureClass !== third.failureClass
  ) {
    return undefined;
  }

  return {
    code: "failure_oscillation",
    severity: "high",
    summary: `Attempts ${first.index}, ${second.index}, and ${third.index} oscillate between failure classes instead of converging.`,
    attemptIndexes: [first.index, second.index, third.index]
  };
}

function detectAttemptRepetition(
  attempts: Pick<TrajectoryAttemptLike, "index" | "summary">[]
): TrajectorySignal | undefined {
  if (attempts.length < 3) {
    return undefined;
  }

  const tokenSets = attempts.map((attempt) => toTokenSet(attempt.summary));
  if (tokenSets.some((tokens) => tokens.size < 4)) {
    return undefined;
  }

  const pairScores = [
    jaccardSimilarity(tokenSets[0]!, tokenSets[1]!),
    jaccardSimilarity(tokenSets[1]!, tokenSets[2]!),
    jaccardSimilarity(tokenSets[0]!, tokenSets[2]!)
  ];

  if (pairScores.every((score) => score >= 0.55)) {
    const matchedTerms = intersectSets(
      tokenSets[0]!,
      new Set(intersectSets(tokenSets[1]!, tokenSets[2]!))
    );
    return {
      code: "attempt_repetition",
      severity: "high",
      summary: `Attempts ${attempts.map((attempt) => attempt.index).join(", ")} are materially repetitive and are not exploring a new path.`,
      attemptIndexes: attempts.map((attempt) => attempt.index),
      ...(matchedTerms.length > 0 ? { matchedTerms: matchedTerms.slice(0, 6) } : {})
    };
  }

  return undefined;
}

function detectVerificationStall(
  attempts: Pick<TrajectoryAttemptLike, "index" | "summary" | "failureClass">[]
): TrajectorySignal | undefined {
  if (attempts.length < 2) {
    return undefined;
  }

  const relevant = attempts.filter((attempt) => {
    const failureClass = attempt.failureClass;
    return failureClass !== undefined && STALL_FAILURE_CLASSES.has(failureClass);
  });
  if (relevant.length < 2) {
    return undefined;
  }

  const tokenSets = relevant.map((attempt) => toTokenSet(attempt.summary));
  const overlap = tokenSets
    .slice(1)
    .map((tokens, index) => jaccardSimilarity(tokenSets[index]!, tokens))
    .reduce((highest, score) => Math.max(highest, score), 0);

  if (overlap < 0.35) {
    return undefined;
  }

  const latest = relevant.at(-1)!;
  return {
    code: "verification_stall",
    severity: "medium",
    summary: `Recent attempts keep landing on the same verifier-facing failure surface (${latest.failureClass}).`,
    attemptIndexes: relevant.map((attempt) => attempt.index)
  };
}

function detectObjectiveDrift(input: {
  objective: string;
  verificationPlan?: string[];
  attempts: Pick<TrajectoryAttemptLike, "index" | "summary">[];
}): TrajectorySignal | undefined {
  if (input.attempts.length < 2) {
    return undefined;
  }

  const objectiveTerms = toTokenSet(`${input.objective} ${(input.verificationPlan ?? []).join(" ")}`);
  if (objectiveTerms.size < 4) {
    return undefined;
  }

  const summaryTerms = input.attempts.map((attempt) => toTokenSet(attempt.summary));
  const overlaps = summaryTerms.map((terms) => jaccardSimilarity(terms, objectiveTerms));
  if (overlaps.some((score) => score >= 0.18)) {
    return undefined;
  }

  const sharedDriftTerms = intersectSets(summaryTerms[0]!, summaryTerms[1]!);
  if (sharedDriftTerms.length < 3) {
    return undefined;
  }

  return {
    code: "objective_drift",
    severity: "medium",
    summary: "Recent attempt summaries are converging on work that does not overlap with the original objective or verifier plan.",
    attemptIndexes: input.attempts.map((attempt) => attempt.index),
    matchedTerms: sharedDriftTerms.slice(0, 6)
  };
}

function deriveTrajectoryStatus(signals: TrajectorySignal[]): TrajectoryAssessment["status"] {
  if (signals.some((signal) => signal.severity === "high")) {
    return "stalled";
  }
  if (signals.some((signal) => signal.code === "objective_drift")) {
    return "drifting";
  }
  if (signals.some((signal) => signal.severity === "medium")) {
    return "watch";
  }
  return "healthy";
}

function deriveTrajectoryConfidence(
  signals: TrajectorySignal[]
): TrajectoryAssessment["confidence"] {
  if (signals.some((signal) => signal.severity === "high")) {
    return "high";
  }
  if (signals.some((signal) => signal.severity === "medium")) {
    return "medium";
  }
  return "low";
}

function deriveRecommendedIntervention(
  signals: TrajectorySignal[]
): InterventionType | undefined {
  if (signals.some((signal) => signal.code === "failure_oscillation" || signal.code === "attempt_repetition")) {
    return "escalate_human";
  }
  if (signals.some((signal) => signal.code === "objective_drift")) {
    return "tighten_task";
  }
  if (signals.some((signal) => signal.code === "verification_stall")) {
    return "run_verifier";
  }
  return undefined;
}

function summarizeTrajectory(
  status: TrajectoryAssessment["status"],
  signals: TrajectorySignal[]
): string {
  const lead = signals[0];
  if (!lead) {
    return "Trajectory is healthy.";
  }

  switch (status) {
    case "stalled":
      return `Trajectory stalled: ${lead.summary}`;
    case "drifting":
      return `Trajectory drift detected: ${lead.summary}`;
    case "watch":
      return `Trajectory warning: ${lead.summary}`;
    default:
      return lead.summary;
  }
}

function toTokenSet(text: string | undefined): Set<string> {
  return new Set(
    (text ?? "")
      .toLowerCase()
      .match(/[a-z][a-z0-9_/-]{2,}/g)
      ?.flatMap((token) => splitCompositeToken(token))
      .map((token) => token.trim())
      .filter((token) => token.length >= 3 && !STOP_WORDS.has(token)) ?? []
  );
}

function splitCompositeToken(token: string): string[] {
  return token
    .split(/[-_/]/g)
    .flatMap((part) => part.split(/(?=[A-Z])/g))
    .map((part) => part.toLowerCase())
    .filter(Boolean);
}

function jaccardSimilarity(left: Set<string>, right: Set<string>): number {
  if (left.size === 0 || right.size === 0) {
    return 0;
  }

  const intersection = intersectSets(left, right).length;
  const union = new Set([...left, ...right]).size;
  return union === 0 ? 0 : intersection / union;
}

function intersectSets(left: Set<string>, right: Set<string>): string[] {
  return [...left].filter((term) => right.has(term));
}

interface TrajectoryAttemptLike {
  index: number;
  summary?: string;
  failureClass?: string;
}
