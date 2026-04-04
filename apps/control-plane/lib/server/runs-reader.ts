/**
 * Reads real loop records from ~/.martin/runs/*.jsonl and computes aggregates
 * for the cost dashboard. Uses blended pricing to estimate costs when CLI
 * adapters don't expose token prices directly.
 *
 * All "savings" values are labeled as estimates — no fake certainty.
 */

import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

// Blended average across top models (same constants as claude-cli.ts)
const BLENDED_INPUT_PER_1K  = 0.003;
const BLENDED_OUTPUT_PER_1K = 0.012;

function estimateUsd(tokensIn: number, tokensOut: number): number {
  return (tokensIn / 1000) * BLENDED_INPUT_PER_1K +
         (tokensOut / 1000) * BLENDED_OUTPUT_PER_1K;
}

export type LoopRecord = {
  loopId: string;
  status: string;
  lifecycleState: string;
  createdAt: string;
  updatedAt: string;
  budget: { maxUsd: number; softLimitUsd: number; maxIterations: number; maxTokens: number };
  cost: { actualUsd: number; tokensIn: number; tokensOut: number; avoidedUsd?: number };
  attempts: Array<{
    index: number;
    model?: string;
    adapterId?: string;
    failureClass?: string;
    intervention?: string;
    startedAt?: string;
    completedAt?: string;
  }>;
  task: { title: string; objective: string };
};

export type RunsAggregate = {
  /** Total loops recorded. */
  totalLoops: number;
  /** Loops that completed with verification pass. */
  completedLoops: number;
  /** Loops currently running. */
  activeLoops: number;
  /** Total attempts across all loops. */
  totalAttempts: number;
  /** Actual USD spent (non-zero only when using direct-provider adapters). */
  actualUsd: number;
  /** Estimated USD saved vs a naive full-iteration loop. Labeled as estimate. */
  estimatedSavedUsd: number;
  /** True if cost data comes from real token counts; false if estimated. */
  costIsReal: boolean;
  /** Total tokens consumed across all loops. */
  tokensIn: number;
  tokensOut: number;
  /** Token reduction % vs naive full run (always computable). */
  tokenReductionPct: number;
  /** Average exit time in seconds. */
  avgExitTimeSecs: number;
  /** Cost per iteration (USD). */
  costPerIteration: number;
  /** Failure class distribution: class → count. */
  failureClasses: Record<string, number>;
  /** Model usage distribution: model → count. */
  modelUsage: Record<string, number>;
  /** Per-day data for the savings chart (last 14 days). */
  dailyPoints: Array<{ label: string; savedUsd: number; spendUsd: number }>;
  /** Auto-optimized = loops that changed model during run. */
  autoOptimizedLoops: number;
};

export async function readRunsAggregate(): Promise<RunsAggregate | null> {
  const runsDir = join(homedir(), ".martin", "runs");
  let files: string[];

  try {
    files = await readdir(runsDir);
  } catch {
    return null;
  }

  const jsonlFiles = files.filter((f) => f.endsWith(".jsonl"));
  if (jsonlFiles.length === 0) return null;

  const loops: LoopRecord[] = [];

  for (const file of jsonlFiles) {
    try {
      const text = await readFile(join(runsDir, file), "utf8");
      for (const line of text.trim().split("\n").filter(Boolean)) {
        const record = JSON.parse(line) as LoopRecord;
        loops.push(record);
      }
    } catch {
      // skip malformed lines
    }
  }

  if (loops.length === 0) return null;

  return computeAggregate(loops);
}

function computeAggregate(loops: LoopRecord[]): RunsAggregate {
  let completedLoops = 0;
  let activeLoops = 0;
  let autoOptimizedLoops = 0;
  let totalAttempts = 0;
  let actualUsd = 0;
  let tokensIn = 0;
  let tokensOut = 0;
  let totalExitSecs = 0;
  let exitCount = 0;
  const failureClasses: Record<string, number> = {};
  const modelUsage: Record<string, number> = {};

  for (const loop of loops) {
    totalAttempts += loop.attempts.length;
    actualUsd += loop.cost.actualUsd;
    tokensIn += loop.cost.tokensIn;
    tokensOut += loop.cost.tokensOut;

    if (loop.status === "completed") completedLoops++;
    if (loop.status === "running") activeLoops++;

    const hasModelChange = loop.attempts.some((a) => a.intervention === "change_model");
    if (hasModelChange) autoOptimizedLoops++;

    const created = new Date(loop.createdAt).getTime();
    const updated = new Date(loop.updatedAt ?? loop.createdAt).getTime();
    const secs = (updated - created) / 1000;
    if (secs > 0) { totalExitSecs += secs; exitCount++; }

    for (const attempt of loop.attempts) {
      if (attempt.failureClass) {
        failureClasses[attempt.failureClass] = (failureClasses[attempt.failureClass] ?? 0) + 1;
      }
      if (attempt.model) {
        const modelKey = shortModelName(attempt.model);
        modelUsage[modelKey] = (modelUsage[modelKey] ?? 0) + 1;
      }
    }
  }

  // Cost estimation
  const costIsReal = actualUsd > 0;
  const effectiveUsd = costIsReal
    ? actualUsd
    : estimateUsd(tokensIn, tokensOut);

  // Savings = cost of iterations NOT run
  // For each loop: iterationsSaved = maxIterations - attemptsUsed
  // Estimated cost per iteration = effectiveUsd / totalAttempts
  const costPerIteration = totalAttempts > 0 ? effectiveUsd / totalAttempts : 0;
  let iterationsSaved = 0;
  for (const loop of loops) {
    iterationsSaved += Math.max(loop.budget.maxIterations - loop.attempts.length, 0);
  }
  const estimatedSavedUsd = iterationsSaved * costPerIteration;

  // Token reduction: (iterationsSaved / totalIterationsIfFull) %
  const totalIterationsIfFull = loops.reduce((s, l) => s + l.budget.maxIterations, 0);
  const tokenReductionPct =
    totalIterationsIfFull > 0
      ? Math.round((iterationsSaved / totalIterationsIfFull) * 100)
      : 0;

  const avgExitTimeSecs = exitCount > 0 ? totalExitSecs / exitCount : 0;

  // Daily points — last 14 days
  const dailyPoints = buildDailyPoints(loops, costPerIteration);

  return {
    totalLoops: loops.length,
    completedLoops,
    activeLoops,
    autoOptimizedLoops,
    totalAttempts,
    actualUsd: round2(effectiveUsd),
    estimatedSavedUsd: round2(estimatedSavedUsd),
    costIsReal,
    tokensIn,
    tokensOut,
    tokenReductionPct,
    avgExitTimeSecs: Math.round(avgExitTimeSecs * 10) / 10,
    costPerIteration: round6(costPerIteration),
    failureClasses,
    modelUsage,
    dailyPoints
  };
}

function buildDailyPoints(
  loops: LoopRecord[],
  costPerIteration: number
): Array<{ label: string; savedUsd: number; spendUsd: number }> {
  const dayMap = new Map<string, { spent: number; saved: number }>();

  for (const loop of loops) {
    const day = loop.createdAt.slice(0, 10); // YYYY-MM-DD
    const existing = dayMap.get(day) ?? { spent: 0, saved: 0 };
    const loopCostPerIter = costPerIteration;
    const spent = loop.attempts.length * loopCostPerIter;
    const saved = Math.max(loop.budget.maxIterations - loop.attempts.length, 0) * loopCostPerIter;
    dayMap.set(day, { spent: existing.spent + spent, saved: existing.saved + saved });
  }

  // Last 14 days, sorted ascending
  const today = new Date();
  const points: Array<{ label: string; savedUsd: number; spendUsd: number }> = [];

  for (let i = 13; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    const key = d.toISOString().slice(0, 10);
    const entry = dayMap.get(key) ?? { spent: 0, saved: 0 };
    const label = i === 0 ? "Today" : d.toLocaleDateString("en-US", { weekday: "short" });
    points.push({ label, savedUsd: round2(entry.saved), spendUsd: round2(entry.spent) });
  }

  return points;
}

function shortModelName(model: string): string {
  if (model.includes("opus"))   return "Claude Opus";
  if (model.includes("sonnet")) return "Claude Sonnet 4";
  if (model.includes("haiku"))  return "Claude Haiku";
  if (model.includes("gpt-4o-mini")) return "GPT-4o Mini";
  if (model.includes("gpt-4o")) return "GPT-4o";
  if (model.includes("codex"))  return "Codex";
  return model.split(":").pop() ?? model;
}

function round2(n: number): number { return Math.round(n * 100) / 100; }
function round6(n: number): number { return Math.round(n * 1_000_000) / 1_000_000; }
