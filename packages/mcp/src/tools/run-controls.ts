// SPDX-FileCopyrightText: MartinLoop contributors
//
// SPDX-License-Identifier: Apache-2.0

import { appendFile, readFile } from "node:fs/promises";
import path from "node:path";

import { invalidArgumentsError, unsupportedOperationError } from "./tool-errors.js";
import { loadDetailedLoopRecord, type DetailedLoopSource } from "./run-store.js";

export type MartinControlAction = "pause" | "cancel" | "continue";

export interface MartinRunControlRequestInput {
  file?: string;
  loopId?: string;
  runsDir?: string;
  latest?: boolean;
  reason?: string;
  requestedBy?: string;
}

export interface MartinRunControlReceipt {
  controlId: string;
  loopId: string;
  action: MartinControlAction;
  requestedAt: string;
  reason?: string;
  requestedBy?: string;
}

export interface MartinRunControlState {
  requestedState: "active" | "paused" | "cancellation_requested";
  latestReceipt?: MartinRunControlReceipt;
  approvalState: "not_required" | "resume_requested";
  receipts: MartinRunControlReceipt[];
  receiptPath?: string;
}

export interface MartinRunControlOutput {
  ok: boolean;
  summary: string;
  loopId: string;
  requestedAction: MartinControlAction;
  state: MartinRunControlState;
}

export async function createRunControlReceipt(
  action: MartinControlAction,
  input: MartinRunControlRequestInput
): Promise<MartinRunControlOutput> {
  const detail = await loadDetailedLoopRecord(input);
  if (!detail.canonicalRunDirectory) {
    throw unsupportedOperationError(
      "Run control receipts require a canonical run directory.",
      "Use a canonical loopId-backed Martin run before writing control receipts."
    );
  }

  const receipt: MartinRunControlReceipt = {
    controlId: `ctl_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    loopId: detail.loop.loopId,
    action,
    requestedAt: new Date().toISOString(),
    ...(input.reason ? { reason: input.reason } : {}),
    ...(input.requestedBy ? { requestedBy: input.requestedBy } : {})
  };

  const receiptPath = path.join(detail.canonicalRunDirectory, "controls.jsonl");
  await appendFile(receiptPath, `${JSON.stringify(receipt)}\n`, "utf8");
  const state = await readRunControlState(detail);

  return {
    ok: true,
    summary:
      action === "cancel"
        ? `Cancellation request recorded for ${detail.loop.loopId}.`
        : action === "pause"
          ? `Pause request recorded for ${detail.loop.loopId}.`
          : `Continue request recorded for ${detail.loop.loopId}.`,
    loopId: detail.loop.loopId,
    requestedAction: action,
    state
  };
}

export async function readRunControlState(
  detailOrInput: DetailedLoopSource | MartinRunControlRequestInput
): Promise<MartinRunControlState> {
  const detail =
    isDetailedLoopSource(detailOrInput)
      ? detailOrInput
      : await loadDetailedLoopRecord(detailOrInput);

  const receiptPath = detail.canonicalRunDirectory
    ? path.join(detail.canonicalRunDirectory, "controls.jsonl")
    : undefined;
  const receipts = receiptPath ? await readControlReceipts(receiptPath) : [];
  const latestReceipt = receipts.at(-1);

  return {
    requestedState:
      latestReceipt?.action === "pause"
        ? "paused"
        : latestReceipt?.action === "cancel"
          ? "cancellation_requested"
          : "active",
    ...(latestReceipt ? { latestReceipt } : {}),
    approvalState: latestReceipt?.action === "pause" ? "resume_requested" : "not_required",
    receipts,
    ...(receiptPath ? { receiptPath } : {})
  };
}

export async function readControlReceipts(receiptPath: string): Promise<MartinRunControlReceipt[]> {
  try {
    const contents = await readFile(receiptPath, "utf8");
    return contents
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line) as MartinRunControlReceipt)
      .filter(isRunControlReceipt);
  } catch {
    return [];
  }
}

function isDetailedLoopSource(value: unknown): value is DetailedLoopSource {
  return typeof value === "object" && value !== null && "loop" in value && "runsRoot" in value;
}

function isRunControlReceipt(value: unknown): value is MartinRunControlReceipt {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { controlId?: unknown }).controlId === "string" &&
    typeof (value as { loopId?: unknown }).loopId === "string" &&
    typeof (value as { action?: unknown }).action === "string" &&
    typeof (value as { requestedAt?: unknown }).requestedAt === "string"
  );
}

export function validateControlReason(value?: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw invalidArgumentsError("Invalid reason.");
  }
  return trimmed;
}
