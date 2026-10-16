// SPDX-FileCopyrightText: MartinLoop contributors
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";

import type {
  CostProvenance,
  ExecutionMode,
  ExitKind,
  LoopRecord,
  ReceiptIntegritySummary,
  TestIntegrityStatus,
  TestIntegrityVerdict,
  VerifiedHandoffCheckV1,
  VerifiedHandoffFileEffectsV1,
  VerifiedHandoffLifecycleTruthV1,
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
  "wall_clock",
  "error_threshold",
  "external_event",
]);

export function deriveVerifiedHandoffLifecycleTruth(
  loop: LoopRecord,
): VerifiedHandoffLifecycleTruthV1 {
  const envelope = loop.terminationEnvelope;
  if (envelope === undefined) {
    return {
      executionStatus: loop.status,
      lifecycleState: loop.lifecycleState,
      terminationClass: "none",
      matchedReasons: [],
      exhaustedLimits: [],
      evidenceAvailable: false,
    };
  }

  if (envelope.class === "guard_stop") {
    return {
      executionStatus: loop.status,
      lifecycleState: loop.lifecycleState,
      terminationClass: "guard_stop",
      reasonCode: envelope.guard.reasonCode,
      reason: envelope.guard.reason,
      matchedReasons: [],
      exhaustedLimits: [],
      evidenceAvailable: true,
    };
  }

  const primary = envelope.exit.primary;
  const primaryMatch = envelope.exit.matches.find(
    (match) => match.kind === primary,
  );
  const exhausted = new Set<VerifiedHandoffLifecycleTruthV1["exhaustedLimits"][number]>();
  for (const match of envelope.exit.matches) {
    if (match.kind === "turn_cap") {
      exhausted.add("iterations");
    } else if (match.kind === "wall_clock") {
      exhausted.add("wall_clock");
    } else if (match.kind === "budget_cap") {
      if (match.evidence["usdExceeded"] === true) {
        exhausted.add("usd");
      }
      if (match.evidence["tokensExceeded"] === true) {
        exhausted.add("tokens");
      }
    }
  }
  const exhaustedLimits = (["usd", "tokens", "iterations", "wall_clock"] as const)
    .filter((limit) => exhausted.has(limit));

  return {
    executionStatus: loop.status,
    lifecycleState: loop.lifecycleState,
    terminationClass: "operational_exit",
    ...(primary ? { reasonCode: primary } : {}),
    ...(primaryMatch?.reason ? { reason: primaryMatch.reason } : {}),
    matchedReasons: [...envelope.exit.matched],
    exhaustedLimits,
    evidenceAvailable: true,
  };
}

export interface VerifierExecutionBinding {
  runId: string;
  workspaceId: string;
  attemptId?: string;
  cwd: string;
  runsRoot?: string;
  executionProfile?: "strict_local" | "ci_safe" | "staging_controlled" | "research_untrusted";
  allowedNetworkDomains?: string[];
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
    (evidence.binding.attemptId ?? undefined) !== (expected.attemptId ?? undefined) ||
    evidence.binding.cwd !== expected.cwd ||
    (evidence.binding.runsRoot ?? undefined) !== (expected.runsRoot ?? undefined) ||
    (evidence.binding.executionProfile ?? undefined) !== (expected.executionProfile ?? undefined) ||
    JSON.stringify(evidence.binding.allowedNetworkDomains ?? []) !== JSON.stringify(expected.allowedNetworkDomains ?? []) ||
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
  sourceStatus?: LoopRecord["status"];
  terminationClass?: VerifiedHandoffLifecycleTruthV1["terminationClass"];
  reasonCode?: ExitKind | string;
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
    input.terminationClass === "guard_stop" ||
    (input.terminationClass === "operational_exit" &&
      input.reasonCode !== undefined &&
      input.reasonCode !== "goal_met") ||
    input.executionStatus === "write_blocked" ||
    input.executionStatus === "sandbox_blocked" ||
    input.executionStatus === "policy_rejected"
  ) {
    return "STOPPED";
  }

  if (
    input.sourceStatus !== "completed" ||
    input.terminationClass !== "operational_exit" ||
    input.reasonCode !== "goal_met" ||
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

  const executionMode: ExecutionMode = hasSimulatedAdapter
    ? "simulated"
    : hasVerifierOnlyAdapter
      ? "verification_only"
      : persistedMode ?? (adapterIds.length > 0 ? "governed" : "simulated");

  return {
    executionMode,
    governanceClaimEligible:
      executionMode === "governed" && adapterIds.length > 0,
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
  fileEffects?: Partial<VerifiedHandoffFileEffectsV1>;
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

export const NO_FILE_CHANGES_WARNING =
  "No file changes were observed for this run; the verifier result reflects the workspace as it already was.";

export function buildVerifiedHandoff(
  input: BuildVerifiedHandoffInput
): VerifiedHandoffV1 {
  const generatedAt = input.generatedAt ?? new Date().toISOString();
  const changedFiles = input.changedFiles ?? [];
  const unresolvedWork = input.unresolvedWork ?? [];
  const lifecycleTruth = deriveVerifiedHandoffLifecycleTruth(input.loop);
  const fileEffects: VerifiedHandoffFileEffectsV1 = {
    observationStatus: input.fileEffects?.observationStatus ?? "unavailable",
    touchedDuringExecution: [...(input.fileEffects?.touchedDuringExecution ?? [])],
    netChangedAtCompletion: [...(input.fileEffects?.netChangedAtCompletion ?? [])],
    revertedBeforeCompletion: [...(input.fileEffects?.revertedBeforeCompletion ?? [])],
    ...(input.fileEffects?.observationReason
      ? { observationReason: input.fileEffects.observationReason }
      : input.fileEffects?.observationStatus === "observed"
        ? {}
        : { observationReason: "File-effect evidence was not recorded for this run." }),
  };

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
  const expectedVerifierBinding: VerifierExecutionBinding | undefined =
    input.verification.binding
      ? {
          runId: input.loop.loopId,
          workspaceId: input.loop.workspaceId,
          ...(input.loop.attempts.at(-1)?.attemptId
            ? { attemptId: input.loop.attempts.at(-1)?.attemptId }
            : {}),
          cwd:
            input.loop.receiptScope?.workingDirectory ??
            input.loop.task.repoRoot ??
            input.verification.binding.cwd,
          ...(input.loop.receiptScope?.runsRoot
            ? { runsRoot: input.loop.receiptScope.runsRoot }
            : {}),
          ...(input.loop.task.executionProfile
            ? { executionProfile: input.loop.task.executionProfile }
            : {}),
          ...(input.loop.task.allowedNetworkDomains?.length
            ? { allowedNetworkDomains: [...input.loop.task.allowedNetworkDomains] }
            : {}),
          commands: [...input.loop.task.verificationPlan],
        }
      : undefined;
  const verifierStepsActuallyPassed = expectedVerifierBinding
    ? verifierActuallyPassed(
        {
          passed: input.verification.status === "passed",
          binding: input.verification.binding,
          steps: input.verification.steps,
        },
        expectedVerifierBinding,
      )
    : false;
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
    ...(fileEffects.observationStatus === "observed" &&
    fileEffects.netChangedAtCompletion.length === 0 &&
    input.loop.task.mutationMode !== "read_only"
      ? [NO_FILE_CHANGES_WARNING]
      : []),
  ];

  const outcome = resolveVerifiedHandoffOutcome({
    lifecycleState: input.loop.lifecycleState,
    sourceStatus: input.loop.status,
    terminationClass: lifecycleTruth.terminationClass,
    reasonCode: lifecycleTruth.reasonCode,
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
    lifecycleTruth,
    fileEffects,
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
