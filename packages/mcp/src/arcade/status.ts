import {
  martinRunDossierTool,
  type MartinRunDossierInput,
  type MartinRunDossierOutput
} from "../tools/run-dossier.js";

export interface ArcadeStatusInput {
  loopId?: string;
}

export type ArcadeDossierReader = (
  input: MartinRunDossierInput
) => Promise<MartinRunDossierOutput>;

const ACTIVE_LIFECYCLES = new Set(["created", "running", "verifying"]);

export async function readArcadeStatus(
  input: ArcadeStatusInput,
  readDossier: ArcadeDossierReader = martinRunDossierTool
) {
  const dossier = await readDossier(input.loopId ? { loopId: input.loopId } : { latest: true });
  const lifecycleState = dossier.loop.lifecycleState;
  const completed = !ACTIVE_LIFECYCLES.has(lifecycleState);

  return {
    loopId: dossier.loop.loopId,
    lifecycleState,
    completed,
    displayOutcome: completed ? dossier.verifiedHandoff.outcome : null,
    verification: dossier.verification,
    receiptIntegrity: dossier.receiptIntegrity,
    attempts: dossier.attempts.length,
    cost: {
      actualUsd: dossier.cost.actualUsd,
      provenance: dossier.cost.provenance
    },
    budget: {
      maxUsd: dossier.budget.maxUsd,
      remainingUsd: dossier.loop.remainingBudgetUsd
    },
    warnings: dossier.warnings
  };
}
