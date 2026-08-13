export type ChangeObservationStatus =
  | "verified"
  | "mismatch"
  | "adapter_only"
  | "repo_only"
  | "unavailable";

export interface ChangeObservationEvidence {
  available: boolean;
  changedFiles: string[];
  diffStats?: {
    filesChanged: number;
    addedLines: number;
    deletedLines: number;
  };
}

export interface ChangeObservationReconciliation {
  status: ChangeObservationStatus;
  summary: string;
  adapterReported: ChangeObservationEvidence;
  repoObserved: ChangeObservationEvidence;
  effectiveChangedFiles: string[];
  matchedFiles: string[];
  adapterOnlyFiles: string[];
  repoOnlyFiles: string[];
}

export function cloneChangeObservationReconciliation(
  input: ChangeObservationReconciliation
): ChangeObservationReconciliation {
  return {
    status: input.status,
    summary: input.summary,
    adapterReported: cloneObservationEvidence(input.adapterReported),
    repoObserved: cloneObservationEvidence(input.repoObserved),
    effectiveChangedFiles: [...input.effectiveChangedFiles],
    matchedFiles: [...input.matchedFiles],
    adapterOnlyFiles: [...input.adapterOnlyFiles],
    repoOnlyFiles: [...input.repoOnlyFiles]
  };
}

function cloneObservationEvidence(input: ChangeObservationEvidence): ChangeObservationEvidence {
  return {
    available: input.available,
    changedFiles: [...input.changedFiles],
    ...(input.diffStats
      ? {
          diffStats: {
            filesChanged: input.diffStats.filesChanged,
            addedLines: input.diffStats.addedLines,
            deletedLines: input.diffStats.deletedLines
          }
        }
      : {})
  };
}
