import { extractVerificationResults, loadSelectedRun, type VerificationResultSummary } from "./cockpit-support.js";

export interface GetVerificationResultsInput {
  loopId?: string;
  runsDir?: string;
  latest?: boolean;
}

export interface GetVerificationResultsOutput {
  loopId: string;
  results: VerificationResultSummary[];
}

export async function getVerificationResultsTool(
  input: GetVerificationResultsInput
): Promise<GetVerificationResultsOutput> {
  const loop = await loadSelectedRun(input);
  return {
    loopId: loop.loopId,
    results: extractVerificationResults(loop)
  };
}
