// SPDX-FileCopyrightText: MartinLoop contributors
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";

import type {
  CostProvenance,
  ExecutionMode,
  LoopRecord,
  ReceiptIntegritySummary,
  TestIntegrityStatus,
  TestIntegrityVerdict,
  VerifiedHandoffCheckV1,
  VerifiedHandoffOutcome,
  VerifiedHandoffRecoveryV1,
  VerifiedHandoffRequirementV1,
  VerifiedHandoffScopeV1,
  VerifiedHandoffTestIntegrityV1,
  VerifiedHandoffV1,
} from "@martin/contracts";

// ---------------------------------------------------------------------------
// Mapping: granular TestIntegrityStatus → public TestIntegrityVerdict
//
// A new enum value MUST appear here or TypeScript compilation will fail,
// ensuring the mapping is always exhaustive.
// ---------------------------------------------------------------------------

export function toTestIntegrityVerdict(
  status: TestIntegrityStatus
): TestIntegrityVerdict {
  switch (status) {
    case "UNCHANGED":
    case "AUTHORIZED_CHANGE":
      return "VERIFIED";

    case "PREVENTED":
    case "DETECTED_AND_ROLLED_BACK":
    case "DETECTED_NEEDS_REVIEW":
      return "TAMPERING_DETECTED";

    case "NOT_EVALUATED":
      return "NOT_EVALUATED";
  }
}

// ---------------------------------------------------------------------------
// Outcome resolution — deterministic, no hidden defaults
// ---------------------------------------------------------------------------

const STOPPED_LIFECYCLE_STATES = new Set<LoopRecord["lifecycleState"]>([
  "budget_exit",
  "diminishing_returns",
  "stuck_exit",
  "human_escalation",
]);

export interface VerifierExecutionBinding {
  runId: string;
  workspaceId: string;
  cwd: string;
  commands: string[];
}

export interface BoundVerifierEvidence {
  passed: boolean;
  binding?: VerifierExecutionBinding;
  steps?: Array<{
    command: string;
    launched: boolean;
    completed?: boolean;
    crashed?: boolean;
    exitCode?: number;
    timedOut?: boolean;
  }>;
}

export function verifierActuallyPassed(
  evidence: BoundVerifierEvidence | null | undefined,
  expected: VerifierExecutionBinding
): boolean {
  if (!evidence?.passed || !evidence.binding || !evidence.steps) {
    return false;
  }

  if (expected.commands.length === 0) {
    return false;
  }

  if (
    evidence.binding.runId !== expected.runId ||
    evidence.binding.workspaceId !== expected.workspaceId ||
    evidence.binding.cwd !== expected.cwd ||
    JSON.stringify(evidence.binding.commands) !== JSON.stringify(expected.commands)
  ) {
    return false;
  }

  if (evidence.steps.length !== expected.commands.length) {
    return false;
  }

  return evidence.steps.every((step, index) =>
    step.command === expected.commands[index] &&
    step.launched === true &&
    step.completed === true &&
    step.crashed === false &&
    step.timedOut !== true &&
    step.exitCode === 0
  );
}

export function resolveVerifiedHandoffOutcome(input: {
  lifecycleState: LoopRecord["lifecycleState"];
  executionStatus?: "completed" | "write_blocked" | "sandbox_blocked" | "policy_rejected" | "failed";
  verificationStatus: BuildVerifiedHandoffInput["verification"]["status"];
  receiptIntegrity: ReceiptIntegritySummary["state"];
  scopeStatus?: VerifiedHandoffScopeV1["status"];
  testIntegrityStatus?: TestIntegrityStatus;
  mutationRequired?: boolean;
  changedFileCount?: number;
  definitionOfDonePreSatisfied?: boolean;
  evidenceContradicted?: boolean;
  governanceClaimEligible?: boolean;
  unresolvedWorkCount: number;
}): VerifiedHandoffOutcome {
  if (
    STOPPED_LIFECYCLE_STATES.has(input.lifecycleState) ||
    input.executionStatus === "write_blocked" ||
    input.executionStatus === "sandbox_blocked" ||
    input.executionStatus === "policy_rejected"
  ) {
    return "STOPPED";
  }

  if (
    input.executionStatus === "failed" ||
    input.governanceClaimEligible === false ||
    input.evidenceContradicted === true ||
    (input.mutationRequired === true &&
      (input.changedFileCount ?? 0) === 0 &&
      input.definitionOfDonePreSatisfied !== true)
  ) {
    return "NEEDS_REVIEW";
  }

  const evidenceTrustworthy = input.receiptIntegrity === "verified";
  const scopeAcceptable =
    input.scopeStatus === undefined ||
    input.scopeStatus === "WITHIN_SCOPE" ||
    input.scopeStatus === "NOT_EVALUATED";
  const testIntegrityAcceptable =
    input.testIntegrityStatus === undefined ||
    input.testIntegrityStatus === "UNCHANGED" ||
    input.testIntegrityStatus === "AUTHORIZED_CHANGE" ||
    input.testIntegrityStatus === "NOT_EVALUATED";

  if (
    input.verificationStatus === "passed" &&
    evidenceTrustworthy &&
    scopeAcceptable &&
    testIntegrityAcceptable &&
    input.unresolvedWorkCount === 0
  ) {
    return "VERIFIED";
  }

  return "NEEDS_REVIEW";
}

const SIMULATED_ADAPTER_PATTERN = /(?:^|:)(?:stub|fixture|synthetic)(?::|$)/u;

function isExecutionMode(value: string | undefined): value is ExecutionMode {
  return value === "governed" || value === "verification_only" || value === "simulated";
}

export function deriveVerifiedHandoffExecutionBoundary(loop: LoopRecord): {
  executionMode: ExecutionMode;
  governanceClaimEligible: boolean;
} {
  const adapterIds = loop.attempts.map((attempt) => attempt.adapterId);
  const hasSimulatedAdapter = adapterIds.some((adapterId) =>
    adapterId === "direct:proof:no-mutation" ||
    SIMULATED_ADAPTER_PATTERN.test(adapterId)
  );
  const hasVerifierOnlyAdapter = adapterIds.some(
    (adapterId) => adapterId === "direct:verifier:verify-only"
  );
  const persistedMode = isExecutionMode(loop.metadata["executionMode"])
    ? loop.metadata["executionMode"]
    : undefined;
  const groundingEvidenceAvailable = loop.metadata["groundingEvidenceStatus"] !== "unavailable";

  const executionMode: ExecutionMode = hasSimulatedAdapter
    ? "simulated"
    : hasVerifierOnlyAdapter
      ? "verification_only"
      : persistedMode ?? (adapterIds.length > 0 ? "governed" : "simulated");

  return {
    executionMode,
    governanceClaimEligible:
      executionMode === "governed" && adapterIds.length > 0 && groundingEvidenceAvailable,
  };
}

// ---------------------------------------------------------------------------
// Builder input / helpers
// ---------------------------------------------------------------------------

export interface BuildVerifiedHandoffInput {
  loop: LoopRecord;
  generatedAt?: string;
  receiptIntegrity: ReceiptIntegritySummary;
  verification: {
    status: "passed" | "failed" | "contradicted" | "not_run";
    summary: string;
    steps: Array<{
      command: string;
      launched: boolean;
      completed?: boolean;
      crashed?: boolean;
      exitCode?: number;
      timedOut?: boolean;
      detail?: string;
    }>;
    warnings: string[];
    binding?: VerifierExecutionBinding;
  };
  executionStatus?: "completed" | "write_blocked" | "sandbox_blocked" | "policy_rejected" | "failed";
  mutationRequired?: boolean;
  definitionOfDonePreSatisfied?: boolean;
  evidenceContradicted?: boolean;
  changedFiles?: string[];
  scope?: Partial<VerifiedHandoffScopeV1>;
  testIntegrity?: Partial<VerifiedHandoffTestIntegrityV1>;
  requirements?: VerifiedHandoffRequirementV1[];
  unresolvedWork?: string[];
  stopReason?: string;
  recovery?: Partial<VerifiedHandoffRecoveryV1>;
  nextAction: string;
}

function toEvidenceStatus(
  status: BuildVerifiedHandoffInput["verification"]["status"]
): VerifiedHandoffV1["verification"]["status"] {
  switch (status) {
    case "passed":
      return "PASSED";
    case "failed":
      return "FAILED";
    case "contradicted":
      return "CONTRADICTED";
    case "not_run":
      return "NOT_RUN";
  }
}

function toCheck(
  step: BuildVerifiedHandoffInput["verification"]["steps"][number]
): VerifiedHandoffCheckV1 {
  const status = !step.launched
    ? "NOT_RUN"
    : step.timedOut
      ? "FAILED"
      : step.exitCode === 0
        ? "PASSED"
        : "FAILED";

  return {
    command: step.command,
    status,
    ...(step.exitCode !== undefined ? { exitCode: step.exitCode } : {}),
    ...(step.timedOut !== undefined ? { timedOut: step.timedOut } : {}),
    ...(step.detail ? { detail: step.detail } : {}),
  };
}

// ---------------------------------------------------------------------------
// Main builder
// ---------------------------------------------------------------------------

export function buildVerifiedHandoff(
  input: BuildVerifiedHandoffInput
): VerifiedHandoffV1 {
  const generatedAt = input.generatedAt ?? new Date().toISOString();
  const changedFiles = input.changedFiles ?? [];
  const unresolvedWork = input.unresolvedWork ?? [];

  const scope: VerifiedHandoffScopeV1 = {
    status: input.scope?.status ?? "NOT_EVALUATED",
    allowedPaths:
      input.scope?.allowedPaths ?? input.loop.task.allowedPaths ?? [],
    deniedPaths:
      input.scope?.deniedPaths ?? input.loop.task.deniedPaths ?? [],
    changedFiles: input.scope?.changedFiles ?? changedFiles,
    violations: input.scope?.violations ?? [],
  };

  const testIntegrityStatus: TestIntegrityStatus =
    input.testIntegrity?.status ?? "NOT_EVALUATED";

  const testIntegrity: VerifiedHandoffTestIntegrityV1 = {
    verdict: toTestIntegrityVerdict(testIntegrityStatus),
    status: testIntegrityStatus,
    protectedPaths: input.testIntegrity?.protectedPaths ?? [],
    changedProtectedPaths: input.testIntegrity?.changedProtectedPaths ?? [],
    findings: input.testIntegrity?.findings ?? [],
    summary:
      input.testIntegrity?.summary ??
      "Test integrity was not evaluated for this run.",
  };

  const executionBoundary = deriveVerifiedHandoffExecutionBoundary(input.loop);
  const verifierStepsActuallyPassed =
    input.verification.steps.length > 0 &&
    input.verification.steps.every(
      (step) =>
        step.launched === true &&
        step.completed === true &&
        step.crashed === false &&
        step.timedOut !== true &&
        step.exitCode === 0
    );
  const effectiveVerificationStatus =
    input.verification.status === "passed" && !verifierStepsActuallyPassed
      ? input.verification.steps.length === 0
        ? "not_run"
        : "contradicted"
      : input.verification.status;
  const verificationWarnings = [
    ...input.verification.warnings,
    ...(effectiveVerificationStatus !== input.verification.status
      ? ["A VERIFIED claim requires at least one launched, completed, exit-zero verifier step."]
      : []),
  ];

  const outcome = resolveVerifiedHandoffOutcome({
    lifecycleState: input.loop.lifecycleState,
    executionStatus: input.executionStatus,
    verificationStatus: effectiveVerificationStatus,
    receiptIntegrity: input.receiptIntegrity.state,
    scopeStatus: scope.status,
    testIntegrityStatus: testIntegrity.status,
    mutationRequired: input.mutationRequired ?? input.loop.task.mutationMode === "edit",
    changedFileCount: scope.changedFiles.length,
    definitionOfDonePreSatisfied: input.definitionOfDonePreSatisfied,
    evidenceContradicted:
      input.evidenceContradicted ?? effectiveVerificationStatus === "contradicted",
    governanceClaimEligible: executionBoundary.governanceClaimEligible,
    unresolvedWorkCount: unresolvedWork.length,
  });

  const handoffId = `vh_${createHash("sha256")
    .update(`${input.loop.loopId}:${generatedAt}`)
    .digest("hex")
    .slice(0, 16)}`;

  return {
    schemaVersion: "1.0.0",
    handoffId,
    loopId: input.loop.loopId,
    generatedAt,
    task: {
      title: input.loop.task.title,
      objective: input.loop.task.objective,
    },
    definitionOfDone: {
      acceptanceCriteria: input.loop.task.acceptanceCriteria ?? [],
      verificationPlan: input.loop.task.verificationPlan,
    },
    outcome,
    executionMode: executionBoundary.executionMode,
    governanceClaimEligible: executionBoundary.governanceClaimEligible,
    sourceStatus: {
      status: input.loop.status,
      lifecycleState: input.loop.lifecycleState,
    },
    verification: {
      status: toEvidenceStatus(effectiveVerificationStatus),
      summary: input.verification.summary,
      checks: input.verification.steps.map(toCheck),
      warnings: verificationWarnings,
    },
    requirements: input.requirements ?? [],
    scope,
    testIntegrity,
    unresolvedWork,
    ...(input.stopReason ? { stopReason: input.stopReason } : {}),
    recovery: {
      rollbackBoundaryAvailable:
        input.recovery?.rollbackBoundaryAvailable ?? false,
      rollbackAttempted: input.recovery?.rollbackAttempted ?? false,
      ...(input.recovery?.rollbackSucceeded !== undefined
        ? { rollbackSucceeded: input.recovery.rollbackSucceeded }
        : {}),
      ...(input.recovery?.isolatedRef
        ? { isolatedRef: input.recovery.isolatedRef }
        : {}),
      ...(input.recovery?.nextCommand
        ? { nextCommand: input.recovery.nextCommand }
        : {}),
      summary:
        input.recovery?.summary ??
        "No explicit recovery evidence was supplied to the handoff builder.",
    },
    usage: {
      attempts: input.loop.attempts.length,
      actualUsd: input.loop.cost.actualUsd,
      ...(input.loop.cost.estimatedUsd !== undefined
        ? { estimatedUsd: input.loop.cost.estimatedUsd }
        : {}),
      tokensIn: input.loop.cost.tokensIn,
      tokensOut: input.loop.cost.tokensOut,
      costProvenance:
        input.loop.cost.provenance ??
        ("unavailable" satisfies CostProvenance),
    },
    receiptIntegrity: input.receiptIntegrity,
    nextAction: input.nextAction,
  };
}
