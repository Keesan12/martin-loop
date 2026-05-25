import { buildAttemptArtifactsReference, buildAttemptSummary, buildLoopPreview } from "./tool-support.js";
import { loadAttemptFromLoop } from "./run-store.js";

export interface MartinGetAttemptInput {
  file?: string;
  loopId?: string;
  runsDir?: string;
  attemptIndex?: number;
}

export interface MartinGetAttemptOutput {
  source: string;
  sourceKind: "file" | "loop_id" | "latest" | "runs_root";
  loop: ReturnType<typeof buildLoopPreview>;
  attempt: ReturnType<typeof buildAttemptSummary>;
  warnings: string[];
}

export async function martinGetAttemptTool(
  input: MartinGetAttemptInput
): Promise<MartinGetAttemptOutput> {
  const { detail, attempt } = await loadAttemptFromLoop(input);
  const artifacts =
    detail.canonicalRunDirectory
      ? await buildAttemptArtifactsReference(detail.runsRoot, detail.loop.loopId, attempt.index)
      : undefined;

  return {
    source: detail.source,
    sourceKind: detail.sourceKind,
    loop: buildLoopPreview(detail.loop),
    attempt: buildAttemptSummary(attempt, artifacts),
    warnings: detail.warnings
  };
}
