import { buildRunDossier, loadSelectedRun } from "./cockpit-support.js";

export interface RunDossierInput {
  loopId?: string;
  runsDir?: string;
  latest?: boolean;
}

export type RunDossierOutput = ReturnType<typeof buildRunDossier>;

export async function runDossierTool(input: RunDossierInput): Promise<RunDossierOutput> {
  const loop = await loadSelectedRun(input);
  return buildRunDossier(loop);
}
