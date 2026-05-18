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

  const records: LoopRunRecord[] = [];

  const jsonlFiles = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
    .map((entry) => entry.name);

  for (const file of jsonlFiles) {
    try {
      records.push(...(await readLoopRecordsFromFile(join(dir, file))));
    } catch {
      // skip malformed files or lines
    }
  }

  const runDirectories = entries.filter((entry) => entry.isDirectory());
  for (const entry of runDirectories) {
    try {
      records.push(...(await readLoopRecordsFromFile(join(dir, entry.name, "loop-record.json"))));
    } catch {
      // skip missing or malformed canonical records
    }
  }

  return records;
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
