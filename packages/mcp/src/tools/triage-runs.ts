import path from "node:path";
import { decideCircuitBreak } from "@martin/core";

import {
  buildLoopPreview,
  buildSuggestedPromptNames,
  buildSuggestedResourceUris,
  buildVerificationSummary,
  type LoopPreview,
  type VerificationSummary
} from "./tool-support.js";
import { listLoopRecords, readLedgerEvents, type LoopListInput } from "./run-store.js";
import { resolveSafeLoopRecordPath } from "../server-validation.js";

export interface MartinTriageRunsInput extends LoopListInput {
  includeHealthy?: boolean;
}

export interface MartinRunTriageFinding {
  severity: "critical" | "high" | "medium" | "low";
  summary: string;
  reasonCodes: string[];
  loop: LoopPreview;
  verification: VerificationSummary;
  suggestedResources: string[];
  suggestedPrompts: string[];
}

export interface MartinTriageRunsOutput {
  source: string;
  runsRoot: string;
  filters: {
    limit: number;
    includeHealthy: boolean;
    status?: string;
    lifecycleState?: string;
    adapterId?: string;
    model?: string;
    updatedAfter?: string;
  };
  evaluatedRuns: number;
  findingCount: number;
  severityBreakdown: Record<string, number>;
  findings: MartinRunTriageFinding[];
  warnings: string[];
}

const SEVERITY_RANK: Record<MartinRunTriageFinding["severity"], number> = {
  critical: 4,
  high: 3,
  medium: 2,
  low: 1
};

export async function martinTriageRunsTool(
  input: MartinTriageRunsInput
): Promise<MartinTriageRunsOutput> {
  const listed = await listLoopRecords(input);
  const warnings = [...listed.warnings];
  const findings = await Promise.all(
    listed.loops.map(async (loop) => {
      try {
        const preview = buildLoopPreview(loop);
        const trajectory = decideCircuitBreak({
          objective: loop.task?.objective ?? loop.loopId,
          verificationPlan: loop.task?.verificationPlan,
          attempts: loop.attempts.map((attempt) => ({
            index: attempt.index,
            summary: attempt.summary,
            failureClass: attempt.failureClass
          })),
          remainingIterations: preview.remainingIterations
        });
        let ledgerEvents: import("@martin/core").LedgerEvent[] = [];

        const canonicalLoopRecordPath = resolveSafeLoopRecordPath(loop.loopId, listed.runsRoot);
        ledgerEvents = await readLedgerEvents({
          source: listed.source,
          sourceKind: "runs_root",
          runsRoot: listed.runsRoot,
          loop,
          warnings: [],
          canonicalRunDirectory: path.dirname(canonicalLoopRecordPath),
          canonicalLoopRecordPath
        });
        const verification = buildVerificationSummary(loop, ledgerEvents);
        return buildTriageFinding(preview, verification, trajectory);
      } catch {
        warnings.push(`Skipped triage for '${loop.loopId}' because its run record or verification evidence is unreadable.`);
        return null;
      }
    })
  );

  const filteredFindings = findings
    .filter((finding): finding is MartinRunTriageFinding => finding !== null)
    .filter((finding) => input.includeHealthy || finding.reasonCodes[0] !== "healthy")
    .sort(compareFindings);

  return {
    source: listed.source,
    runsRoot: listed.runsRoot,
    filters: {
      limit: input.limit ?? 20,
      includeHealthy: input.includeHealthy ?? false,
      ...(input.status ? { status: input.status } : {}),
      ...(input.lifecycleState ? { lifecycleState: input.lifecycleState } : {}),
      ...(input.adapterId ? { adapterId: input.adapterId } : {}),
      ...(input.model ? { model: input.model } : {}),
      ...(input.updatedAfter ? { updatedAfter: input.updatedAfter } : {})
    },
    evaluatedRuns: listed.loops.length,
    findingCount: filteredFindings.length,
    severityBreakdown: filteredFindings.reduce<Record<string, number>>((accumulator, finding) => {
      accumulator[finding.severity] = (accumulator[finding.severity] ?? 0) + 1;
      return accumulator;
    }, {}),
    findings: filteredFindings,
    warnings
  };
}

function buildTriageFinding(
  loop: LoopPreview,
  verification: VerificationSummary,
  trajectory: ReturnType<typeof decideCircuitBreak>
): MartinRunTriageFinding {
  const reasonCodes: string[] = [];
  let severity: MartinRunTriageFinding["severity"] = "low";

  if (verification.status === "failed") {
    reasonCodes.push("verification_failed");
    severity = maxSeverity(severity, "critical");
  }
  if (verification.status === "contradicted") {
    reasonCodes.push("verification_contradicted");
    severity = maxSeverity(severity, "critical");
  }

  if (loop.pressure === "hard_limit" || loop.shouldStop) {
    reasonCodes.push("budget_hard_limit");
    severity = maxSeverity(severity, "critical");
  }

  if (loop.status === "failed") {
    reasonCodes.push("status_failed");
    severity = maxSeverity(severity, "high");
  }

  if (loop.lifecycleState === "diminishing_returns") {
    reasonCodes.push("diminishing_returns");
    severity = maxSeverity(severity, "high");
  }

  if (trajectory.shouldStop || trajectory.assessment.status === "stalled") {
    reasonCodes.push("trajectory_stalled");
    severity = maxSeverity(severity, "critical");
  }

  if (verification.status === "not_run" && loop.attempts > 0) {
    reasonCodes.push("verification_not_run");
    severity = maxSeverity(severity, "medium");
  }

  if (loop.pressure === "soft_limit") {
    reasonCodes.push("budget_soft_limit");
    severity = maxSeverity(severity, "medium");
  }

  if (loop.status === "exited") {
    reasonCodes.push("status_exited");
    severity = maxSeverity(severity, "medium");
  }

  if (reasonCodes.length === 0) {
    reasonCodes.push("healthy");
  }

  return {
    severity,
    summary: summarizeFinding(loop, verification, severity, reasonCodes),
    reasonCodes,
    loop,
    verification,
    suggestedResources: buildSuggestedResourceUris(loop.loopId),
    suggestedPrompts: buildSuggestedPromptNames()
  };
}

function summarizeFinding(
  loop: LoopPreview,
  verification: VerificationSummary,
  severity: MartinRunTriageFinding["severity"],
  reasonCodes: string[]
): string {
  if (reasonCodes.includes("trajectory_stalled")) {
    return `Severity ${severity}: ${loop.loopId} should not spend another attempt before operator review.`;
  }

  if (reasonCodes.includes("verification_failed")) {
    return `Severity ${severity}: ${loop.loopId} failed verification after ${loop.attempts} attempt(s).`;
  }

  if (reasonCodes.includes("budget_hard_limit")) {
    return `Severity ${severity}: ${loop.loopId} exhausted its budget envelope with pressure ${loop.pressure}.`;
  }

  if (reasonCodes.includes("status_failed")) {
    return `Severity ${severity}: ${loop.loopId} is currently failed/${loop.lifecycleState}.`;
  }

  if (reasonCodes.includes("verification_contradicted")) {
    return `Severity ${severity}: ${loop.loopId} has contradictory verification evidence and needs operator review.`;
  }

  if (reasonCodes.includes("verification_not_run")) {
    return `Severity ${severity}: ${loop.loopId} has ${loop.attempts} attempt(s) but verification was not recorded.`;
  }

  if (reasonCodes.includes("budget_soft_limit")) {
    return `Severity ${severity}: ${loop.loopId} is at soft-limit pressure with ${loop.remainingBudgetUsd.toFixed(2)} USD remaining.`;
  }

  if (reasonCodes.includes("status_exited")) {
    return `Severity ${severity}: ${loop.loopId} exited without a clean verification result.`;
  }

  return `Severity ${severity}: ${loop.loopId} is healthy with verification status ${verification.status}.`;
}

function maxSeverity(
  left: MartinRunTriageFinding["severity"],
  right: MartinRunTriageFinding["severity"]
): MartinRunTriageFinding["severity"] {
  return SEVERITY_RANK[left] >= SEVERITY_RANK[right] ? left : right;
}

function compareFindings(left: MartinRunTriageFinding, right: MartinRunTriageFinding): number {
  const severityDelta = SEVERITY_RANK[right.severity] - SEVERITY_RANK[left.severity];
  if (severityDelta !== 0) {
    return severityDelta;
  }

  const leftTimestamp = new Date(left.loop.updatedAt ?? left.loop.createdAt ?? 0).getTime();
  const rightTimestamp = new Date(right.loop.updatedAt ?? right.loop.createdAt ?? 0).getTime();
  return rightTimestamp - leftTimestamp;
}
