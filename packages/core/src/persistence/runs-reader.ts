/**
 * Reads completed loop records from ~/.martin/runs/ for analysis.
 * Used by the Trust Calibration Engine and other offline analytics.
 *
 * Supports both storage layouts:
 * - legacy root JSONL files: <runsRoot>/*.jsonl
 * - canonical run trees: <runsRoot>/<loopId>/loop-record.json
 */

import type { Dirent } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { extname, join } from "node:path";

export interface LoopAttemptRecord {
  index: number;
  model?: string;
  adapterId?: string;
  failureClass?: string;
  intervention?: string;
  startedAt?: string;
  completedAt?: string;
}

export interface LoopRunRecord {
  loopId: string;
  status: string;
  lifecycleState: string;
  createdAt: string;
  updatedAt: string;
  budget: {
    maxUsd: number;
    softLimitUsd: number;
    maxIterations: number;
    maxTokens: number;
  };
  cost: {
    actualUsd: number;
    tokensIn: number;
    tokensOut: number;
    avoidedUsd?: number;
  };
  attempts: LoopAttemptRecord[];
  task: { title: string; objective: string };
}

type LoopRecordSource = "legacy_jsonl" | "canonical_tree";

export interface LoopRecordsRollup {
  generatedAt: string;
  totalRuns: number;
  statusBreakdown: Record<string, number>;
  lifecycleBreakdown: Record<string, number>;
  latestByLoopId: Record<
    string,
    {
      status: string;
      lifecycleState: string;
      updatedAt: string;
      costUsd: number;
      attempts: number;
    }
  >;
}

export async function readLoopRecordsFromFile(file: string): Promise<LoopRunRecord[]> {
  const text = await readFile(file, "utf8");
  const extension = extname(file).toLowerCase();

  if (extension === ".jsonl") {
    return text
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line) as LoopRunRecord);
  }

  const parsed = JSON.parse(text) as LoopRunRecord | LoopRunRecord[];
  return Array.isArray(parsed) ? parsed : [parsed];
}

export async function readLatestLoopRecordFromFile(
  file: string,
): Promise<LoopRunRecord | null> {
  const records = await readLoopRecordsFromFile(file);
  if (records.length === 0) return null;

  return records.reduce<LoopRunRecord>((latest, record) => {
    const currentTimestamp = new Date(record.updatedAt ?? record.createdAt).getTime();
    const latestTimestamp = new Date(latest.updatedAt ?? latest.createdAt).getTime();
    return currentTimestamp > latestTimestamp ? record : latest;
  }, records[0]!);
}

/**
 * Reads all loop records from the given directory (default: ~/.martin/runs/).
 * Returns an empty array if the directory doesn't exist or has no records.
 */
export async function readAllLoopRecords(
  runsDir?: string
): Promise<LoopRunRecord[]> {
  const dir = runsDir ?? join(homedir(), ".martin", "runs");
  let entries: Dirent<string>[];

  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  const recordsByLoopId = new Map<string, { record: LoopRunRecord; source: LoopRecordSource }>();

  const jsonlFiles = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
    .map((entry) => entry.name);

  for (const file of jsonlFiles) {
    try {
      const fromFile = await readLoopRecordsFromFile(join(dir, file));
      for (const record of fromFile) {
        ingestRecord(recordsByLoopId, record, "legacy_jsonl");
      }
    } catch {
      // skip malformed files or lines
    }
  }

  const runDirectories = entries.filter((entry) => entry.isDirectory());
  for (const entry of runDirectories) {
    try {
      const canonical = await readLoopRecordsFromFile(join(dir, entry.name, "loop-record.json"));
      for (const record of canonical) {
        ingestRecord(recordsByLoopId, record, "canonical_tree");
      }
    } catch {
      // skip missing or malformed canonical records
    }
  }

  return [...recordsByLoopId.values()].map((entry) => entry.record);
}

/**
 * Returns the most recently updated loop record, or null if none exist.
 */
export async function readLatestLoopRecord(
  runsDir?: string
): Promise<LoopRunRecord | null> {
  const records = await readAllLoopRecords(runsDir);
  if (records.length === 0) return null;

  return records.reduce<LoopRunRecord>((latest, r) => {
    const a = new Date(r.updatedAt ?? r.createdAt).getTime();
    const b = new Date(latest.updatedAt ?? latest.createdAt).getTime();
    return a > b ? r : latest;
  }, records[0]!);
}

export function buildLoopRecordsRollup(records: LoopRunRecord[]): LoopRecordsRollup {
  const statusBreakdown: Record<string, number> = {};
  const lifecycleBreakdown: Record<string, number> = {};
  const latestByLoopId: LoopRecordsRollup["latestByLoopId"] = {};

  for (const record of records) {
    statusBreakdown[record.status] = (statusBreakdown[record.status] ?? 0) + 1;
    lifecycleBreakdown[record.lifecycleState] = (lifecycleBreakdown[record.lifecycleState] ?? 0) + 1;
    latestByLoopId[record.loopId] = {
      status: record.status,
      lifecycleState: record.lifecycleState,
      updatedAt: record.updatedAt,
      costUsd: record.cost.actualUsd,
      attempts: record.attempts.length
    };
  }

  return {
    generatedAt: new Date().toISOString(),
    totalRuns: records.length,
    statusBreakdown,
    lifecycleBreakdown,
    latestByLoopId
  };
}

function ingestRecord(
  recordsByLoopId: Map<string, { record: LoopRunRecord; source: LoopRecordSource }>,
  record: LoopRunRecord,
  source: LoopRecordSource
): void {
  const existing = recordsByLoopId.get(record.loopId);
  if (!existing) {
    recordsByLoopId.set(record.loopId, { record, source });
    return;
  }

  const candidateTimestamp = resolveRecordTimestamp(record);
  const existingTimestamp = resolveRecordTimestamp(existing.record);
  if (candidateTimestamp > existingTimestamp) {
    recordsByLoopId.set(record.loopId, { record, source });
    return;
  }

  if (
    candidateTimestamp === existingTimestamp &&
    sourcePrecedence(source) > sourcePrecedence(existing.source)
  ) {
    recordsByLoopId.set(record.loopId, { record, source });
  }
}

function resolveRecordTimestamp(record: LoopRunRecord): number {
  const updated = Date.parse(record.updatedAt ?? "");
  if (Number.isFinite(updated)) {
    return updated;
  }
  const created = Date.parse(record.createdAt ?? "");
  return Number.isFinite(created) ? created : 0;
}

function sourcePrecedence(source: LoopRecordSource): number {
  return source === "canonical_tree" ? 2 : 1;
}
