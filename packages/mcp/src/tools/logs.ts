// SPDX-FileCopyrightText: MartinLoop contributors
//
// SPDX-License-Identifier: Apache-2.0

import { readRunControlState } from "./run-controls.js";
import { loadDetailedLoopRecord, readLedgerEvents } from "./run-store.js";

export interface MartinLogsInput {
  file?: string;
  loopId?: string;
  runsDir?: string;
  latest?: boolean;
  limit?: number;
}

export interface MartinLogsOutput {
  source: string;
  sourceKind: "file" | "loop_id" | "latest" | "runs_root";
  loopId: string;
  logCount: number;
  live: {
    lifecycleState: string;
    pauseState: "active" | "paused" | "cancellation_requested";
    approvalState: "not_required" | "resume_requested";
  };
  entries: Array<{
    timestamp?: string;
    source: "event" | "ledger" | "control";
    kind: string;
    payload: Record<string, unknown>;
  }>;
}

export async function martinLogsTool(input: MartinLogsInput): Promise<MartinLogsOutput> {
  const detail = await loadDetailedLoopRecord(input);
  const ledgerEvents = await readLedgerEvents(detail);
  const controls = await readRunControlState(detail);
  const limit = input.limit ?? 20;

  const eventEntries = (detail.loop.events ?? []).map((event) => ({
    timestamp: event.timestamp,
    source: "event" as const,
    kind: event.type,
    payload: event.payload ?? {}
  }));
  const ledgerEntries = ledgerEvents.map((event) => ({
    timestamp: event.timestamp,
    source: "ledger" as const,
    kind: event.kind,
    payload: (event.payload ?? {}) as Record<string, unknown>
  }));
  const controlEntries = controls.receipts.map((receipt) => ({
    timestamp: receipt.requestedAt,
    source: "control" as const,
    kind: `run.${receipt.action}`,
    payload: {
      controlId: receipt.controlId,
      ...(receipt.reason ? { reason: receipt.reason } : {}),
      ...(receipt.requestedBy ? { requestedBy: receipt.requestedBy } : {})
    }
  }));

  const entries = [...eventEntries, ...ledgerEntries, ...controlEntries]
    .sort((left, right) => {
      const leftTime = left.timestamp ? new Date(left.timestamp).getTime() : 0;
      const rightTime = right.timestamp ? new Date(right.timestamp).getTime() : 0;
      return rightTime - leftTime;
    })
    .slice(0, limit);

  return {
    source: detail.source,
    sourceKind: detail.sourceKind,
    loopId: detail.loop.loopId,
    logCount: entries.length,
    live: {
      lifecycleState: detail.loop.lifecycleState,
      pauseState: controls.requestedState,
      approvalState: controls.approvalState
    },
    entries
  };
}
