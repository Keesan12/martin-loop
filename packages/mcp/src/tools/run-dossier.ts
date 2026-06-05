import {
  buildArtifactSummary,
  buildBudgetSnapshot,
  buildCostSnapshot,
  buildEventSummaries,
  buildLoopPreview,
  buildSuggestedPromptNames,
  buildSuggestedResourceUris,
  buildVerificationSummary
} from "./tool-support.js";
import {
  loadDetailedLoopRecord,
  readAttemptArtifactFiles,
  readLedgerEvents
} from "./run-store.js";
import { resolveTrustedLoopRepoRoot } from "../server-validation.js";
import { readRunControlState } from "./run-controls.js";
import { martinEvalTool } from "./eval.js";
import { assessRunRisk, inspectRepoSignals } from "./workflow-governance.js";

export interface MartinRunDossierInput {
  file?: string;
  loopId?: string;
  runsDir?: string;
  latest?: boolean;
  format?: "json" | "md" | "github-pr";
}

export interface MartinRunDossierOutput {
  source: string;
  sourceKind: "file" | "loop_id" | "latest" | "runs_root";
  loop: ReturnType<typeof buildLoopPreview>;
  budget: ReturnType<typeof buildBudgetSnapshot>;
  cost: ReturnType<typeof buildCostSnapshot>;
  attempts: Array<{
    index: number;
    attemptId?: string;
    adapterId?: string;
    model?: string;
    failureClass?: string;
    intervention?: string;
    startedAt?: string;
    completedAt?: string;
    summary?: string;
    artifactFiles: string[];
  }>;
  verification: ReturnType<typeof buildVerificationSummary>;
  artifacts: ReturnType<typeof buildArtifactSummary>;
  recentEvents: ReturnType<typeof buildEventSummaries>;
  related: {
    resources: string[];
    prompts: string[];
  };
  review: {
    diffSummary: string;
    risk: ReturnType<typeof assessRunRisk>;
    outcome: "passed" | "failed" | "needs_review";
    nextAction: string;
  };
  evaluation: Awaited<ReturnType<typeof martinEvalTool>>;
  control: Awaited<ReturnType<typeof readRunControlState>>;
  format: "json" | "md" | "github-pr";
  rendered?: string;
  inspection: {
    runsRoot: string;
    canonicalRunDirectory?: string;
    canonicalLoopRecordPath?: string;
    ledgerPath?: string;
  };
  warnings: string[];
}

export async function martinRunDossierTool(
  input: MartinRunDossierInput
): Promise<MartinRunDossierOutput> {
  const detail = await loadDetailedLoopRecord(input);
  const ledgerEvents = await readLedgerEvents(detail);
  const verification = buildVerificationSummary(detail.loop, ledgerEvents);
  const control = await readRunControlState(detail);
  const evaluation = await martinEvalTool(input);
  const repoRoot = resolveTrustedLoopRepoRoot(detail.loop.task?.repoRoot);
  const risk = assessRunRisk({
    objective: detail.loop.task?.objective ?? detail.loop.loopId,
    allowedPaths: detail.loop.task?.allowedPaths ?? [],
    blockedPaths: detail.loop.task?.deniedPaths ?? [],
    verifiers: detail.loop.task?.verificationPlan ?? [],
    signals: inspectRepoSignals(repoRoot)
  });

  const attempts = await Promise.all(
    detail.loop.attempts.map(async (attempt) => ({
      index: attempt.index,
      ...(attempt.attemptId ? { attemptId: attempt.attemptId } : {}),
      ...(attempt.adapterId ? { adapterId: attempt.adapterId } : {}),
      ...(attempt.model ? { model: attempt.model } : {}),
      ...(attempt.failureClass ? { failureClass: attempt.failureClass } : {}),
      ...(attempt.intervention ? { intervention: attempt.intervention } : {}),
      ...(attempt.startedAt ? { startedAt: attempt.startedAt } : {}),
      ...(attempt.completedAt ? { completedAt: attempt.completedAt } : {}),
      ...(attempt.summary ? { summary: attempt.summary } : {}),
      artifactFiles: await readAttemptArtifactFiles(detail, attempt.index)
    }))
  );
  const review = {
    diffSummary:
      attempts.length > 0
        ? `Run touched ${attempts.length} attempt(s); latest summary: ${attempts.at(-1)?.summary ?? "No attempt summary recorded."}`
        : "No attempts were recorded for this run.",
    risk,
    outcome:
      verification.status === "passed"
        ? "passed"
        : verification.status === "failed"
          ? "failed"
          : "needs_review",
    nextAction:
      verification.status === "passed"
        ? "Review the dossier and evaluation, then decide whether to merge or promote."
        : verification.status === "failed"
          ? "Investigate the latest verifier failure before retrying or promoting."
          : "Collect more evidence before claiming completion."
  } as const;

  const output: MartinRunDossierOutput = {
    source: detail.source,
    sourceKind: detail.sourceKind,
    loop: buildLoopPreview(detail.loop),
    budget: buildBudgetSnapshot(detail.loop.budget),
    cost: buildCostSnapshot(detail.loop.cost),
    attempts,
    verification,
    artifacts: buildArtifactSummary(detail.loop),
    recentEvents: buildEventSummaries(detail.loop, 8),
    related: {
      resources: buildSuggestedResourceUris(detail.loop.loopId),
      prompts: buildSuggestedPromptNames()
    },
    review,
    evaluation,
    control,
    format: input.format ?? "json",
    inspection: {
      runsRoot: detail.runsRoot,
      ...(detail.canonicalRunDirectory ? { canonicalRunDirectory: detail.canonicalRunDirectory } : {}),
      ...(detail.canonicalLoopRecordPath ? { canonicalLoopRecordPath: detail.canonicalLoopRecordPath } : {}),
      ...(detail.ledgerPath ? { ledgerPath: detail.ledgerPath } : {})
    },
    warnings: [...detail.warnings, ...verification.warnings]
  };

  if (output.format !== "json") {
    output.rendered = renderDossier(output);
  }

  return output;
}

function renderDossier(output: MartinRunDossierOutput): string {
  const lines = [
    output.format === "github-pr" ? "## MartinLoop Run Dossier" : "# MartinLoop Run Dossier",
    "",
    `Objective: ${output.loop.objective}`,
    `Run: ${output.loop.loopId}`,
    `Status: ${output.loop.status} / ${output.loop.lifecycleState}`,
    `Attempts: ${output.attempts.length}`,
    `Verifiers: ${output.verification.status}`,
    `Risk: ${output.review.risk.level} (${output.review.risk.score})`,
    `Allowed paths: ${output.review.risk.reasons.length > 0 ? output.review.risk.reasons.join("; ") : "No major risk reasons recorded."}`,
    "",
    "Review Summary:",
    output.review.diffSummary,
    "",
    "Next Action:",
    output.review.nextAction
  ];

  if (output.format === "github-pr") {
    lines.push("", `Evaluation: ${output.evaluation.grade} (${output.evaluation.score})`);
  }

  return lines.join("\n");
}
