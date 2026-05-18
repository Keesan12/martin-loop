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

export interface MartinRunDossierInput {
  file?: string;
  loopId?: string;
  runsDir?: string;
  latest?: boolean;
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

  return {
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
    inspection: {
      runsRoot: detail.runsRoot,
      ...(detail.canonicalRunDirectory ? { canonicalRunDirectory: detail.canonicalRunDirectory } : {}),
      ...(detail.canonicalLoopRecordPath ? { canonicalLoopRecordPath: detail.canonicalLoopRecordPath } : {}),
      ...(detail.ledgerPath ? { ledgerPath: detail.ledgerPath } : {})
    },
    warnings: [...detail.warnings, ...verification.warnings]
  };
}
