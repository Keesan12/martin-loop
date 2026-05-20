import { getAttempt, loadSelectedRun } from "./cockpit-support.js";

export interface GetAttemptInput {
  loopId: string;
  attemptIndex: number;
  runsDir?: string;
}

export type GetAttemptOutput = ReturnType<typeof getAttempt>;

export async function getAttemptTool(input: GetAttemptInput): Promise<GetAttemptOutput> {
  const loop = await loadSelectedRun({ loopId: input.loopId, runsDir: input.runsDir });
  return getAttempt(loop, input.attemptIndex);
}
