/**
 * Exit contracts for the MartinLoop Eight-Exit Runtime.
 *
 * Precedence rationale (product decision — changing EXIT_PRECEDENCE in core
 * requires updating this paragraph in the same commit):
 *   1. human_interrupt and external_event outrank all others — they represent
 *      authority external to the run's own evidence and cannot be argued with.
 *   2. wall_clock, budget_cap, and turn_cap all outrank goal_met — governance
 *      limits (time, cost, iterations) cannot be overridden by a simultaneously
 *      verified goal; resource limits rank wall_clock > budget_cap > turn_cap.
 *   3. turn_cap is suppressed at signal-generation time when the goal is already
 *      met, so goal_met and turn_cap cannot co-occur in a well-formed evaluation.
 *      Completing on the final permitted iteration is legitimate success, not an
 *      overrun; turn_cap fires only when iterations are exhausted without
 *      verified completion.
 *   4. goal_met outranks error_threshold and no_progress — a deterministically
 *      verified result takes priority over soft progress signals.
 */

export const EXIT_POLICY_VERSION = "exit-policy/1" as const;
export const EXIT_EVALUATION_VERSION = "exit-evaluation/1" as const;
export const EXIT_SIGNAL_VERSION = "exit-signal/1" as const;
export const TERMINATION_ENVELOPE_VERSION = "termination/1" as const;

export const EXIT_KINDS = [
  "goal_met",
  "turn_cap",
  "budget_cap",
  "wall_clock",
  "no_progress",
  "human_interrupt",
  "error_threshold",
  "external_event"
] as const;

export type ExitKind = (typeof EXIT_KINDS)[number];

export type ExitEvaluationPhase =
  | "pre_run"
  | "pre_attempt"
  | "post_attempt"
  | "before_retry"
  | "during_attempt";

export type ExternalEventDisposition =
  | "satisfied"
  | "superseded"
  | "cancelled";

export interface ExternalExitEvent {
  source: string;
  event: string;
  disposition: ExternalEventDisposition;
  observedAt: string;
  subject?: string;
  reason?: string;
  evidenceUri?: string;
}

export interface ExitPolicyV1 {
  schemaVersion: typeof EXIT_POLICY_VERSION;
  goal: {
    verifierRequired: boolean;
    minimumScore: number;
  };
  turns: {
    max: number;
  };
  budget: {
    maxUsd: number;
    maxTokens: number;
  };
  wallClock: {
    maxElapsedMs: number;
    deadlineAt?: string;
  };
  progress: {
    windowSize: number;
    unchangedStateLimit: number;
  };
  errors: {
    maxConsecutive: number;
  };
  humanInterrupt: {
    enabled: boolean;
  };
  externalEvent: {
    enabled: boolean;
  };
}

export interface ExitSignalV1 {
  schemaVersion: typeof EXIT_SIGNAL_VERSION;
  runId: string;
  kind: "human_interrupt" | "external_event";
  requestedAt: string;
  requestedBy: string;
  reason?: string;
  externalEvent?: ExternalExitEvent;
}

export interface ExitSnapshotV1 {
  phase: ExitEvaluationPhase;
  evaluatedAt: string;
  runStartedAtMs: number;
  nowMs: number;
  turnsUsed: number;
  actualUsd: number;
  tokensUsed: number;
  result?: {
    status: "completed" | "failed";
    verificationPassed: boolean;
    verifierScore: number;
  };
  recentStateHashes: string[];
  consecutiveErrors: number;
  humanInterrupt?: ExitSignalV1;
  externalEvent?: ExternalExitEvent;
  trajectoryStop?: {
    shouldStop: boolean;
    reason: string;
  };
}

export interface ExitMatchV1 {
  kind: ExitKind;
  reason: string;
  evidence: Record<string, unknown>;
}

export interface ExitEvaluationV1 {
  schemaVersion: typeof EXIT_EVALUATION_VERSION;
  policyVersion: typeof EXIT_POLICY_VERSION;
  shouldExit: boolean;
  primary?: ExitKind;
  matched: ExitKind[];
  phase: ExitEvaluationPhase;
  evaluatedAt: string;
  matches: ExitMatchV1[];
}

export type TerminationEnvelopeV1 =
  | {
      schemaVersion: typeof TERMINATION_ENVELOPE_VERSION;
      class: "operational_exit";
      exit: ExitEvaluationV1;
    }
  | {
      schemaVersion: typeof TERMINATION_ENVELOPE_VERSION;
      class: "guard_stop";
      guard: {
        reasonCode: string;
        reason: string;
        failureClass?: string;
        safetySurface?: string;
      };
    };
