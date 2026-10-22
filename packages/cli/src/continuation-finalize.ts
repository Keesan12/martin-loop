import type { LoopRecord } from "@martin/contracts";

import { persistLoopArtifacts } from "./persistence.js";

export async function finalizeContinuationEvidence(
  loop: LoopRecord,
  runsRoot: string
): Promise<void> {
  await persistLoopArtifacts(loop, { runsRoot });
}
