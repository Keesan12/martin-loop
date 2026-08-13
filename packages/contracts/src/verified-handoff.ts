// SPDX-FileCopyrightText: MartinLoop contributors
// SPDX-License-Identifier: Apache-2.0

import type {
  CostProvenance,
  LoopLifecycleState,
  LoopStatus,
  ReceiptIntegritySummary,
} from "./index.js";

export const VERIFIED_HANDOFF_OUTCOMES = [
  "VERIFIED",
  "STOPPED",
  "NEEDS_REVIEW",
] as const;

export type VerifiedHandoffOutcome =
  (typeof VERIFIED_HANDOFF_OUTCOMES)[number];

export const EVIDENCE_STATUSES = [
  "PASSED",
  "FAILED",
  "CONTRADICTED",
  "NOT_RUN",
  "NOT_EVALUATED",
] as const;

export type EvidenceStatus = (typeof EVIDENCE_STATUSES)[number];

/**
 * Granular internal/runtime state. Retained for diagnosis, policy,
 * receipts and engineering review.
 */
export const TEST_INTEGRITY_STATUSES = [
  "UNCHANGED",
  "AUTHORIZED_CHANGE",
  "PREVENTED",
  "DETECTED_AND_ROLLED_BACK",
  "DETECTED_NEEDS_REVIEW",
  "NOT_EVALUATED",
] as const;

export type TestIntegrityStatus =
  (typeof TEST_INTEGRITY_STATUSES)[number];

/**
 * Stable public-facing verdict used by CLI, MCP, JSON/Markdown handoffs
 * and the website. Do not make each renderer collapse states independently.
 */
export const TEST_INTEGRITY_VERDICTS = [
  "VERIFIED",
  "TAMPERING_DETECTED",
  "NOT_EVALUATED",
] as const;

export type TestIntegrityVerdict =
  (typeof TEST_INTEGRITY_VERDICTS)[number];

export interface VerifiedHandoffCheckV1 {
  command: string;
  status: EvidenceStatus;
  exitCode?: number;
  timedOut?: boolean;
  detail?: string;
}

export interface VerifiedHandoffRequirementV1 {
  requirement: string;
  status: "PROVEN" | "FAILED" | "UNRESOLVED" | "NOT_EVALUATED";
  evidence?: string[];
}

export interface VerifiedHandoffScopeV1 {
  status:
    | "WITHIN_SCOPE"
    | "VIOLATION_REJECTED"
    | "NEEDS_REVIEW"
    | "NOT_EVALUATED";
  allowedPaths: string[];
  deniedPaths: string[];
  changedFiles: string[];
  violations: string[];
}

export interface VerifiedHandoffTestIntegrityV1 {
  /** Public rendering contract. */
  verdict: TestIntegrityVerdict;
  /** Granular runtime state for diagnosis and evidence. */
  status: TestIntegrityStatus;
  protectedPaths: string[];
  changedProtectedPaths: string[];
  findings: Array<{
    filePath: string;
    issue: string;
    severity: "high" | "medium" | "low";
    detail: string;
  }>;
  summary: string;
}

export interface VerifiedHandoffRecoveryV1 {
  rollbackBoundaryAvailable: boolean;
  rollbackAttempted: boolean;
  rollbackSucceeded?: boolean;
  isolatedRef?: string;
  nextCommand?: string;
  summary: string;
}

export interface VerifiedHandoffV1 {
  schemaVersion: "1.0.0";
  handoffId: string;
  loopId: string;
  generatedAt: string;
  task: {
    title: string;
    objective: string;
  };
  definitionOfDone: {
    acceptanceCriteria: string[];
    verificationPlan: string[];
  };
  outcome: VerifiedHandoffOutcome;
  sourceStatus: {
    status: LoopStatus;
    lifecycleState: LoopLifecycleState;
  };
  verification: {
    status: EvidenceStatus;
    summary: string;
    checks: VerifiedHandoffCheckV1[];
    warnings: string[];
  };
  requirements: VerifiedHandoffRequirementV1[];
  scope: VerifiedHandoffScopeV1;
  testIntegrity: VerifiedHandoffTestIntegrityV1;
  unresolvedWork: string[];
  stopReason?: string;
  recovery: VerifiedHandoffRecoveryV1;
  usage: {
    attempts: number;
    actualUsd: number;
    estimatedUsd?: number;
    tokensIn: number;
    tokensOut: number;
    costProvenance: CostProvenance;
  };
  receiptIntegrity: ReceiptIntegritySummary;
  nextAction: string;
}
