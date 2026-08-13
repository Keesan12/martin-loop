import type { InterventionType } from "./index.js";

export type TrajectoryStatus = "healthy" | "watch" | "drifting" | "stalled";

export type TrajectoryConfidence = "low" | "medium" | "high";

export type TrajectorySignalCode =
  | "failure_oscillation"
  | "attempt_repetition"
  | "verification_stall"
  | "objective_drift";

export interface TrajectorySignal {
  code: TrajectorySignalCode;
  severity: "low" | "medium" | "high";
  summary: string;
  attemptIndexes: number[];
  matchedTerms?: string[];
}

export interface TrajectoryAssessment {
  status: TrajectoryStatus;
  confidence: TrajectoryConfidence;
  summary: string;
  signals: TrajectorySignal[];
  recommendedIntervention?: InterventionType;
}

export interface CircuitBreakDecision {
  shouldStop: boolean;
  reason: string;
  assessment: TrajectoryAssessment;
  recommendedIntervention?: InterventionType;
}

export function cloneTrajectoryAssessment(
  assessment: TrajectoryAssessment
): TrajectoryAssessment {
  return {
    status: assessment.status,
    confidence: assessment.confidence,
    summary: assessment.summary,
    ...(assessment.recommendedIntervention
      ? { recommendedIntervention: assessment.recommendedIntervention }
      : {}),
    signals: assessment.signals.map((signal) => ({
      code: signal.code,
      severity: signal.severity,
      summary: signal.summary,
      attemptIndexes: [...signal.attemptIndexes],
      ...(signal.matchedTerms ? { matchedTerms: [...signal.matchedTerms] } : {})
    }))
  };
}

export function cloneCircuitBreakDecision(
  decision: CircuitBreakDecision
): CircuitBreakDecision {
  return {
    shouldStop: decision.shouldStop,
    reason: decision.reason,
    assessment: cloneTrajectoryAssessment(decision.assessment),
    ...(decision.recommendedIntervention
      ? { recommendedIntervention: decision.recommendedIntervention }
      : {})
  };
}
