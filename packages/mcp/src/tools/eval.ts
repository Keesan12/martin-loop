// SPDX-FileCopyrightText: MartinLoop contributors
//
// SPDX-License-Identifier: Apache-2.0

import { loadDetailedLoopRecord, readLedgerEvents } from "./run-store.js";
import { resolveTrustedLoopRepoRoot } from "../server-validation.js";
import { buildVerificationSummary } from "./tool-support.js";
import { assessRunRisk, inspectRepoSignals } from "./workflow-governance.js";

export interface MartinEvalInput {
  file?: string;
  loopId?: string;
  runsDir?: string;
  latest?: boolean;
}

export interface MartinEvalOutput {
  source: string;
  sourceKind: "file" | "loop_id" | "latest" | "runs_root";
  loopId: string;
  score: number;
  grade:
    | "mergeable"
    | "mergeable_with_review"
    | "needs_review"
    | "blocked"
    | "insufficient_evidence";
  checks: {
    taskCompletion: "passed" | "warning" | "failed";
    verifier: "passed" | "warning" | "failed";
    diffDiscipline: "passed" | "warning" | "failed";
    regressionRisk: "passed" | "warning" | "failed";
    securityRisk: "passed" | "warning" | "failed";
    reviewability: "passed" | "warning" | "failed";
  };
  warnings: string[];
  summary: string;
}

export async function martinEvalTool(input: MartinEvalInput): Promise<MartinEvalOutput> {
  const detail = await loadDetailedLoopRecord(input);
  const ledgerEvents = await readLedgerEvents(detail);
  const verification = buildVerificationSummary(detail.loop, ledgerEvents);
  const repoRoot = resolveTrustedLoopRepoRoot(detail.loop.task?.repoRoot);
  const signals = inspectRepoSignals(repoRoot);
  const risk = assessRunRisk({
    objective: detail.loop.task?.objective ?? detail.loop.loopId,
    allowedPaths: detail.loop.task?.allowedPaths ?? [],
    blockedPaths: detail.loop.task?.deniedPaths ?? [],
    verifiers: detail.loop.task?.verificationPlan ?? [],
    signals
  });
  const observationMismatch = hasObservationMismatch(detail.loop.events ?? []);

  const checks = {
    taskCompletion:
      detail.loop.status === "completed" ? "passed" : detail.loop.status === "exited" ? "warning" : "failed",
    verifier:
      verification.status === "passed"
        ? "passed"
        : verification.status === "failed" || verification.status === "contradicted"
          ? "failed"
          : "warning",
    diffDiscipline:
      observationMismatch
        ? "failed"
        : (detail.loop.task?.allowedPaths?.length ?? 0) > 0
          ? "passed"
          : "warning",
    regressionRisk: verification.status === "passed" && !observationMismatch ? "passed" : "warning",
    securityRisk: risk.level === "high" ? "failed" : risk.level === "medium" ? "warning" : "passed",
    reviewability:
      detail.loop.attempts.length > 0 && (detail.loop.events?.length ?? 0) > 0 ? "passed" : "warning"
  } as const;

  let score = 100;
  score -= checks.taskCompletion === "failed" ? 25 : checks.taskCompletion === "warning" ? 10 : 0;
  score -= checks.verifier === "failed" ? 25 : checks.verifier === "warning" ? 10 : 0;
  score -= checks.diffDiscipline === "warning" ? 8 : 0;
  score -= checks.regressionRisk === "warning" ? 10 : 0;
  score -= checks.securityRisk === "failed" ? 20 : checks.securityRisk === "warning" ? 10 : 0;
  score -= checks.reviewability === "warning" ? 8 : 0;
  score = Math.max(0, score);

  const grade =
    verification.status === "not_run" || observationMismatch
      ? "insufficient_evidence"
      : score >= 90
        ? "mergeable"
        : score >= 75
          ? "mergeable_with_review"
          : score >= 55
            ? "needs_review"
            : "blocked";

  const warnings = [
    ...detail.warnings,
    ...verification.warnings,
    ...risk.reasons,
    ...(observationMismatch
      ? ["Change observation mismatch: adapter-reported files differ from repo-observed files."]
      : [])
  ];

  return {
    source: detail.source,
    sourceKind: detail.sourceKind,
    loopId: detail.loop.loopId,
    score,
    grade,
    checks: { ...checks },
    warnings,
    summary:
      grade === "mergeable"
        ? `Run ${detail.loop.loopId} looks mergeable with verifier-backed completion.`
        : grade === "mergeable_with_review"
          ? `Run ${detail.loop.loopId} looks mergeable with review; inspect dossier and risk notes first.`
          : grade === "needs_review"
            ? `Run ${detail.loop.loopId} needs review before promotion.`
            : grade === "insufficient_evidence"
              ? `Run ${detail.loop.loopId} does not have enough evidence for a safe promotion decision.`
              : `Run ${detail.loop.loopId} is blocked from promotion by verification or risk gaps.`
  };
}

function hasObservationMismatch(events: Array<{ type?: string; payload?: Record<string, unknown> }>): boolean {
  return events.some((event) => {
    if (event.type !== "observation.reconciled") {
      return false;
    }

    const observation = isRecord(event.payload?.["observation"]) ? event.payload?.["observation"] : undefined;
    return observation?.["status"] === "mismatch";
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
