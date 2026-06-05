import { resolveRunsRoot } from "@martin/core";

import { resolveSafeRepoRoot, resolveSafeRunsRootPath } from "../server-validation.js";
import {
  getEngineAvailability,
  inspectRunsRoot,
  resolveExecutionMode,
  type LoopPreview,
  type MartinEngine
} from "./tool-support.js";

export interface MartinDoctorInput {
  workingDirectory?: string;
  runsDir?: string;
  engine?: MartinEngine;
}

export interface MartinDoctorOutput {
  status: "ok" | "degraded";
  summary: string;
  server: {
    name: "martin-loop";
    nodeVersion: string;
    platform: NodeJS.Platform;
  };
  environment: {
    workspaceRoot: string;
    workingDirectory: string;
    runsRoot: string;
    mode: "live" | "proof";
    liveMode: boolean;
  };
  engines: Record<MartinEngine, { available: boolean; launchReady: boolean; detail: string; resolvedPath?: string }>;
  requestedEngine?: MartinEngine;
  runStore: {
    exists: boolean;
    loopCount: number;
    latestRun?: LoopPreview;
  };
  warnings: string[];
}

export async function martinDoctorTool(input: MartinDoctorInput): Promise<MartinDoctorOutput> {
  const workingDirectory = resolveSafeRepoRoot(input.workingDirectory);
  const runsRoot = resolveSafeRunsRootPath(input.runsDir, resolveRunsRoot(process.env));
  const executionMode = resolveExecutionMode();
  const [claude, codex] = await Promise.all([
    getEngineAvailability("claude", workingDirectory),
    getEngineAvailability("codex", workingDirectory)
  ]);
  const runStore = await inspectRunsRoot(runsRoot);

  const warnings: string[] = [];
  if (!runStore.exists) {
    warnings.push("Configured Martin runs root does not exist yet.");
  }
  if (executionMode.liveMode && !claude.launchReady && !codex.launchReady) {
    warnings.push("Neither claude nor codex is currently launch-ready for live runs.");
  }
  if (input.engine && executionMode.liveMode) {
    const selected = input.engine === "claude" ? claude : codex;
    if (!selected.launchReady) {
      warnings.push(`Requested engine '${input.engine}' is not launch-ready. ${selected.detail}`);
    }
  }
  warnings.push(...runStore.warnings);

  const status = warnings.length === 0 ? "ok" : "degraded";
  const summary =
    status === "ok"
      ? `Doctor passed: ${runStore.loopCount} run(s) visible in ${runsRoot}.`
      : `Doctor found ${warnings.length} issue(s); review warnings before live execution.`;

  return {
    status,
    summary,
    server: {
      name: "martin-loop",
      nodeVersion: process.version,
      platform: process.platform
    },
    environment: {
      workspaceRoot: resolveSafeRepoRoot(),
      workingDirectory,
      runsRoot,
      mode: executionMode.mode,
      liveMode: executionMode.liveMode
    },
    engines: {
      claude: {
        available: claude.available,
        launchReady: claude.launchReady,
        detail: claude.detail,
        ...(claude.resolvedPath ? { resolvedPath: claude.resolvedPath } : {})
      },
      codex: {
        available: codex.available,
        launchReady: codex.launchReady,
        detail: codex.detail,
        ...(codex.resolvedPath ? { resolvedPath: codex.resolvedPath } : {})
      }
    },
    ...(input.engine ? { requestedEngine: input.engine } : {}),
    runStore: {
      exists: runStore.exists,
      loopCount: runStore.loopCount,
      ...(runStore.latestRun ? { latestRun: runStore.latestRun } : {})
    },
    warnings
  };
}
