import { createHash } from "node:crypto";

import type { MissionWorkItem } from "./supervisor.js";

export type MissionQueuePhase =
  | "waiting" | "ready" | "launching" | "candidate" | "verifying"
  | "failed" | "integrating" | "integrated" | "blocked";

export interface MissionQueueEntry {
  workItemId: string;
  phase: MissionQueuePhase;
  childRunId?: string;
  launchKey?: string;
  candidateHash?: string;
  receiptHash?: string;
  integrationId?: string;
  integratedHash?: string;
  selectedProvider?: string;
  recoveryAuthority?: {
    kind: "candidate" | "failed_settlement" | "terminal";
    supervisorCheckpointHash: string;
    runId: string;
    receiptHash: string;
    outcomeHash: string;
    actualUsd?: number;
    tokens?: number;
    terminalStatus?: "failed" | "blocked";
  };
}

export function createReadyDagQueue(items: readonly MissionWorkItem[]): MissionQueueEntry[] {
  const verified = new Set(items.filter((item) => item.status === "verified").map((item) => item.id));
  return items.map((item) => ({
    workItemId: item.id,
    phase: item.status === "verified"
      ? "integrated"
      : item.status === "failed" || item.status === "blocked"
        ? "blocked"
        : item.dependsOn.every((id) => verified.has(id)) ? "ready" : "waiting"
  }));
}

export function refreshReadyDagQueue(
  queue: readonly MissionQueueEntry[],
  items: readonly MissionWorkItem[]
): MissionQueueEntry[] {
  const verified = new Set(items.filter((item) => item.status === "verified").map((item) => item.id));
  const byId = new Map(items.map((item) => [item.id, item]));
  return queue.map((entry) => {
    if (entry.phase !== "waiting") return { ...entry };
    const item = byId.get(entry.workItemId);
    return item !== undefined && item.dependsOn.every((id) => verified.has(id))
      ? { ...entry, phase: "ready" }
      : { ...entry };
  });
}

export function hashMissionWorkQueue(queue: readonly MissionQueueEntry[]): string {
  return createHash("sha256").update(JSON.stringify(queue), "utf8").digest("hex");
}
