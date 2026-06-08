import { buildLoopPreview, buildVerificationSummary, resolveReceiptIntegrity } from "./tool-support.js";
import { loadDetailedLoopRecord, readLedgerEvents } from "./run-store.js";
import type { ReceiptIntegritySummary, ReceiptScope } from "@martin/contracts";

export interface MartinGetVerificationResultsInput {
  file?: string;
  loopId?: string;
  runsDir?: string;
}

export interface MartinGetVerificationResultsOutput {
  source: string;
  sourceKind: "file" | "loop_id" | "latest" | "runs_root";
  loop: ReturnType<typeof buildLoopPreview>;
  verification: ReturnType<typeof buildVerificationSummary>;
  receiptIntegrity: ReceiptIntegritySummary;
  receiptScope?: ReceiptScope;
  warnings: string[];
}

export async function martinGetVerificationResultsTool(
  input: MartinGetVerificationResultsInput
): Promise<MartinGetVerificationResultsOutput> {
  const detail = await loadDetailedLoopRecord(input);
  const ledgerEvents = await readLedgerEvents(detail);
  const verification = buildVerificationSummary(detail.loop, ledgerEvents);

  return {
    source: detail.source,
    sourceKind: detail.sourceKind,
    loop: buildLoopPreview(detail.loop),
    verification,
    receiptIntegrity: resolveReceiptIntegrity(detail.loop),
    ...(detail.loop.receiptScope ? { receiptScope: detail.loop.receiptScope } : {}),
    warnings: [...detail.warnings, ...verification.warnings]
  };
}
