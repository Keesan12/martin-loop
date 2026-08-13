/**
 * Append-Only Trace Store
 *
 * Aggregates run data over time to build institutional memory. Every governed
 * run's routing decision, cost, failure class, and outcome is appended to a
 * local JSONL trace file. Data is NEVER overwritten — only appended.
 *
 * The trace store feeds:
 * - classifyRoute() with historicalDirectSuccessRate from real past runs
 * - Cost prediction models with actual spend data
 * - Failure pattern detection across runs
 * - Team analytics and optimization recommendations
 *
 * Storage: `<runsRoot>/_martin/trace-log.jsonl` (one JSON object per line)
 */

import { appendFile, mkdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

export interface TraceEntry {
  /** ISO-8601 timestamp */
  timestamp: string;
  /** Unique loop identifier */
  loopId: string;
  /** The objective that was governed */
  objective: string;
  /** Which engine executed the run */
  engine: string;
  /** Route selected by classifyRoute */
  selectedRoute: "direct" | "manager" | "consensus";
  /** Route classifier confidence (0-1) */
  routeConfidence: number;
  /** Budget allocated (USD) */
  budgetUsd: number;
  /** Actual spend (USD) */
  actualCostUsd: number;
  /** Pre-work burn percentage */
  preWorkBurnPct: number;
  /** Number of attempts */
  attempts: number;
  /** Final loop status */
  status: string;
  /** Final lifecycle state */
  lifecycleState: string;
  /** Failure class of last attempt (if failed) */
  failureClass?: string;
  /** Whether verification passed */
  verificationPassed: boolean;
  /** Number of files changed */
  filesChanged: number;
  /** Working directory (hashed for privacy) */
  workspaceHash: string;
}

export interface TraceAggregation {
  totalRuns: number;
  directRuns: number;
  managerRuns: number;
  consensusRuns: number;
  directSuccessRate: number;
  managerSuccessRate: number;
  averageCostUsd: number;
  averagePreWorkBurnPct: number;
  totalSpendUsd: number;
  totalSavedUsd: number;
  topFailureClasses: Array<{ failureClass: string; count: number }>;
  averageAttemptsPerRun: number;
  lastUpdated: string;
}

const TRACE_DIRECTORY = "_martin";
const TRACE_FILENAME = "trace-log.jsonl";

function resolveTracePath(runsRoot: string): string {
  return join(resolve(runsRoot), TRACE_DIRECTORY, TRACE_FILENAME);
}

/**
 * Append a trace entry to the local trace store. Never overwrites.
 */
export async function appendTraceEntry(
  runsRoot: string,
  entry: TraceEntry
): Promise<void> {
  const tracePath = resolveTracePath(runsRoot);
  await mkdir(join(resolve(runsRoot), TRACE_DIRECTORY), { recursive: true });
  const line = JSON.stringify(entry) + "\n";
  await appendFile(tracePath, line, "utf8");
}

/**
 * Read all trace entries from the local trace store.
 */
export async function readTraceEntries(runsRoot: string): Promise<TraceEntry[]> {
  const tracePath = resolveTracePath(runsRoot);
  try {
    const raw = await readFile(tracePath, "utf8");
    return raw
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => {
        try {
          return JSON.parse(line) as TraceEntry;
        } catch {
          return null;
        }
      })
      .filter((entry): entry is TraceEntry => entry !== null);
  } catch {
    return [];
  }
}

/**
 * Aggregate trace entries into summary statistics.
 * Used by classifyRoute() to get historicalDirectSuccessRate.
 */
export function aggregateTraces(entries: TraceEntry[]): TraceAggregation {
  if (entries.length === 0) {
    return {
      totalRuns: 0,
      directRuns: 0,
      managerRuns: 0,
      consensusRuns: 0,
      directSuccessRate: 0,
      managerSuccessRate: 0,
      averageCostUsd: 0,
      averagePreWorkBurnPct: 0,
      totalSpendUsd: 0,
      totalSavedUsd: 0,
      topFailureClasses: [],
      averageAttemptsPerRun: 0,
      lastUpdated: new Date().toISOString()
    };
  }

  const direct = entries.filter((e) => e.selectedRoute === "direct");
  const manager = entries.filter((e) => e.selectedRoute === "manager");
  const consensus = entries.filter((e) => e.selectedRoute === "consensus");

  const directSuccesses = direct.filter((e) => e.status === "completed" && e.verificationPassed);
  const managerSuccesses = manager.filter((e) => e.status === "completed" && e.verificationPassed);

  const totalCost = entries.reduce((sum, e) => sum + e.actualCostUsd, 0);
  const totalBudget = entries.reduce((sum, e) => sum + e.budgetUsd, 0);
  const totalAttempts = entries.reduce((sum, e) => sum + e.attempts, 0);
  const totalBurnPct = entries.reduce((sum, e) => sum + e.preWorkBurnPct, 0);

  // Count failure classes
  const failureCounts = new Map<string, number>();
  for (const entry of entries) {
    if (entry.failureClass) {
      failureCounts.set(entry.failureClass, (failureCounts.get(entry.failureClass) ?? 0) + 1);
    }
  }
  const topFailureClasses = [...failureCounts.entries()]
    .map(([failureClass, count]) => ({ failureClass, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);

  return {
    totalRuns: entries.length,
    directRuns: direct.length,
    managerRuns: manager.length,
    consensusRuns: consensus.length,
    directSuccessRate: direct.length > 0 ? directSuccesses.length / direct.length : 0,
    managerSuccessRate: manager.length > 0 ? managerSuccesses.length / manager.length : 0,
    averageCostUsd: Math.round((totalCost / entries.length) * 100) / 100,
    averagePreWorkBurnPct: Math.round(totalBurnPct / entries.length),
    totalSpendUsd: Math.round(totalCost * 100) / 100,
    totalSavedUsd: Math.round((totalBudget - totalCost) * 100) / 100,
    topFailureClasses,
    averageAttemptsPerRun: Math.round((totalAttempts / entries.length) * 10) / 10,
    lastUpdated: entries[entries.length - 1]?.timestamp ?? new Date().toISOString()
  };
}

/**
 * Get the historical direct success rate for use in route classification.
 * Returns undefined if insufficient data (< 5 runs).
 */
export async function getHistoricalDirectSuccessRate(
  runsRoot: string
): Promise<number | undefined> {
  const entries = await readTraceEntries(runsRoot);
  const directRuns = entries.filter((e) => e.selectedRoute === "direct");
  if (directRuns.length < 5) return undefined;
  const successes = directRuns.filter((e) => e.status === "completed" && e.verificationPassed);
  return successes.length / directRuns.length;
}
