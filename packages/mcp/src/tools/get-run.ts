// SPDX-FileCopyrightText: MartinLoop contributors
//
// SPDX-License-Identifier: Apache-2.0

import {
  buildArtifactSummary,
  buildBudgetSnapshot,
  buildCostSnapshot,
  buildLoopPreview,
  resolveReceiptIntegrity,
  buildVerificationSummary
} from "./tool-support.js";
import { loadDetailedLoopRecord, readLedgerEvents } from "./run-store.js";
import type { ReceiptIntegritySummary, ReceiptScope } from "@martin/contracts";

export interface MartinGetRunInput {
  file?: string;
  loopId?: string;
  runsDir?: string;
  latest?: boolean;
}

export interface MartinGetRunOutput {
  source: string;
  sourceKind: "file" | "loop_id" | "latest" | "runs_root";
  loop: ReturnType<typeof buildLoopPreview>;
  budget: ReturnType<typeof buildBudgetSnapshot>;
  cost: ReturnType<typeof buildCostSnapshot>;
  verification: ReturnType<typeof buildVerificationSummary>;
  receiptIntegrity: ReceiptIntegritySummary;
  receiptScope?: ReceiptScope;
  artifacts: ReturnType<typeof buildArtifactSummary>;
  inspection: {
    runsRoot: string;
    canonicalRunDirectory?: string;
    canonicalLoopRecordPath?: string;
    ledgerPath?: string;
  };
  warnings: string[];
}

export async function martinGetRunTool(
  input: MartinGetRunInput
): Promise<MartinGetRunOutput> {
  const detail = await loadDetailedLoopRecord(input);
  const ledgerEvents = await readLedgerEvents(detail);
  const verification = buildVerificationSummary(detail.loop, ledgerEvents);

  return {
    source: detail.source,
    sourceKind: detail.sourceKind,
    loop: buildLoopPreview(detail.loop),
    budget: buildBudgetSnapshot(detail.loop.budget),
    cost: buildCostSnapshot(detail.loop.cost),
    verification,
    receiptIntegrity: resolveReceiptIntegrity(detail.loop),
    ...(detail.loop.receiptScope ? { receiptScope: detail.loop.receiptScope } : {}),
    artifacts: buildArtifactSummary(detail.loop),
    inspection: {
      runsRoot: detail.runsRoot,
      ...(detail.canonicalRunDirectory ? { canonicalRunDirectory: detail.canonicalRunDirectory } : {}),
      ...(detail.canonicalLoopRecordPath ? { canonicalLoopRecordPath: detail.canonicalLoopRecordPath } : {}),
      ...(detail.ledgerPath ? { ledgerPath: detail.ledgerPath } : {})
    },
    warnings: [...detail.warnings, ...verification.warnings]
  };
}
