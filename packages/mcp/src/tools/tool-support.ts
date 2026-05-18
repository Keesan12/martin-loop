import { spawnSync } from "node:child_process";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";

import { evaluateCostGovernor, readLatestLoopRecordFromFile, resolveRunsRoot } from "@martin/core";

export type MartinEngine = "claude" | "codex";

export interface LoopPreview {
  loopId: string;
  title: string;
  objective: string;
  status: string;
  lifecycleState: string;
  createdAt?: string;
  updatedAt?: string;
  attempts: number;
  costUsd: number;
  avoidedUsd: number;
  pressure: string;
  shouldStop: boolean;
  remainingBudgetUsd: number;
  remainingIterations: number;
  remainingTokens: number;
}

export interface CliAvailability {
  available: boolean;
  detail: string;
  resolvedPath?: string;
}

export interface ExecutionMode {
  liveMode: boolean;
  mode: "live" | "stub";
}

export interface RunStoreInspection {
  exists: boolean;
  loopCount: number;
  latestRun?: LoopPreview;
  warnings: string[];
}

export function resolveExecutionMode(): ExecutionMode {
  const liveMode = process.env.MARTIN_LIVE !== "false";
  return {
    liveMode,
    mode: liveMode ? "live" : "stub"
  };
}

export function getEngineAvailability(engine: MartinEngine): CliAvailability {
  const locator = process.platform === "win32" ? "where.exe" : "which";
  const result = spawnSync(locator, [engine], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });

  const resolvedPath =
    result.status === 0
      ? (result.stdout ?? "")
          .split(/\r?\n/u)
          .map((line) => line.trim())
          .find(Boolean)
      : undefined;

  return result.status === 0
    ? {
        available: true,
        detail: `${engine} is available on PATH.`,
        ...(resolvedPath ? { resolvedPath } : {})
      }
    : {
        available: false,
        detail: `${engine} is not available on PATH.`
      };
}

export function formatUsd(value: number): string {
  return `$${value.toFixed(2)}`;
}

export async function inspectRunsRoot(
  runsRoot: string = resolveRunsRoot(process.env)
): Promise<RunStoreInspection> {
  let exists = false;

  try {
    exists = (await stat(runsRoot)).isDirectory();
  } catch {
    exists = false;
  }

  if (!exists) {
    return {
      exists: false,
      loopCount: 0,
      warnings: []
    };
  }

  const warnings: string[] = [];
  const loops: LoopPreview[] = [];
  const entries = await readdir(runsRoot, { withFileTypes: true });

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    const loopRecordPath = join(runsRoot, entry.name, "loop-record.json");
    try {
      const loop = await readLatestLoopRecordFromFile(loopRecordPath);
      if (!loop) {
        continue;
      }

      const costState = evaluateCostGovernor({
        budget: loop.budget,
        cost: {
          actualUsd: loop.cost.actualUsd,
          avoidedUsd: loop.cost.avoidedUsd ?? 0,
          tokensIn: loop.cost.tokensIn,
          tokensOut: loop.cost.tokensOut
        },
        attemptsUsed: loop.attempts.length
      });

      loops.push({
        loopId: loop.loopId,
        title: loop.task?.title ?? loop.loopId,
        objective: loop.task?.objective ?? "Loop record summary",
        status: loop.status,
        lifecycleState: loop.lifecycleState,
        ...(loop.createdAt ? { createdAt: loop.createdAt } : {}),
        ...(loop.updatedAt ? { updatedAt: loop.updatedAt } : {}),
        attempts: loop.attempts.length,
        costUsd: loop.cost.actualUsd,
        avoidedUsd: loop.cost.avoidedUsd ?? 0,
        pressure: costState.pressure,
        shouldStop: costState.shouldStop,
        remainingBudgetUsd: costState.remainingBudgetUsd,
        remainingIterations: costState.remainingIterations,
        remainingTokens: costState.remainingTokens
      });
    } catch {
      warnings.push(`Skipped unreadable loop record for '${entry.name}'.`);
    }
  }

  loops.sort((left, right) => {
    const leftTime = Date.parse(left.updatedAt ?? left.createdAt ?? "");
    const rightTime = Date.parse(right.updatedAt ?? right.createdAt ?? "");
    return (Number.isFinite(rightTime) ? rightTime : 0) - (Number.isFinite(leftTime) ? leftTime : 0);
  });

  return {
    exists: true,
    loopCount: loops.length,
    ...(loops[0] ? { latestRun: loops[0] } : {}),
    warnings
  };
}
