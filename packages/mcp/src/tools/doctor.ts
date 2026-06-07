import {
  probeCodexLaunch,
  resolveCliCommandAvailability,
  type CodexHostPlatform
} from "@martin/adapters";
import { resolveRunsRoot } from "@martin/core";

import { resolveSafeRepoRoot, resolveSafeRunsRootPath } from "../server-validation.js";
import {
  getEngineAvailability,
  inspectRunsRoot,
  resolveExecutionMode,
  type LoopPreview,
  type MartinEngine
} from "./tool-support.js";
import {
  buildReadinessReport,
  inspectRepoSignals,
  type MartinReadinessReport
} from "./workflow-governance.js";

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
  scope: {
    invocationRoot: string;
    workingDirectory: string;
    repoRoot: string;
    runsRoot: string;
  };
  engines: Record<
    MartinEngine,
    {
      available: boolean;
      detail: string;
      resolvedPath?: string;
      hostPlatform?: CodexHostPlatform;
      nativeInstallValid?: boolean;
      launchReady?: boolean;
      probeSummary?: string;
    }
  >;
  requestedEngine?: MartinEngine;
  runStore: {
    exists: boolean;
    loopCount: number;
    latestRun?: LoopPreview;
  };
  readiness: MartinReadinessReport;
  warnings: string[];
}

export async function martinDoctorTool(input: MartinDoctorInput): Promise<MartinDoctorOutput> {
  const workingDirectory = resolveSafeRepoRoot(input.workingDirectory);
  const runsRoot = resolveSafeRunsRootPath(input.runsDir, resolveRunsRoot(process.env));
  const workspaceRoot = resolveSafeRepoRoot();
  const executionMode = resolveExecutionMode();
  const claude = getEngineAvailability("claude");
  const codex = resolveCliCommandAvailability("codex");
  const gemini = getEngineAvailability("gemini");
  const codexProbe =
    executionMode.liveMode && codex.available
      ? probeCodexLaunch({
          workingDirectory,
          availability: codex
        })
      : undefined;
  const runStore = await inspectRunsRoot(runsRoot);
  const signals = inspectRepoSignals(workingDirectory);
  const readiness = buildReadinessReport(signals, runStore);

  const warnings: string[] = [];
  if (!runStore.exists) {
    warnings.push("Configured Martin runs root does not exist yet.");
  }
  if (executionMode.liveMode && !claude.available && !codex.available && !gemini.available) {
    warnings.push("None of claude, codex, or gemini is currently available on PATH for live runs.");
  }
  if (input.engine && executionMode.liveMode) {
    const selected =
      input.engine === "claude" ? claude : input.engine === "gemini" ? gemini : codex;
    if (!selected.available) {
      warnings.push(`Requested engine '${input.engine}' is not available on PATH.`);
    }
    if (input.engine === "codex" && codexProbe && !codexProbe.ok) {
      warnings.push(codexProbe.summary);
    }
  }
  warnings.push(...runStore.warnings);

  const status = warnings.length === 0 ? "ok" : "degraded";
  const summary =
    status === "ok"
      ? `Doctor passed: repo readiness ${readiness.score}/100 with ${runStore.loopCount} visible run(s).`
      : `Doctor found ${warnings.length} issue(s); readiness ${readiness.score}/100 before live execution.`;

  return {
    status,
    summary,
    server: {
      name: "martin-loop",
      nodeVersion: process.version,
      platform: process.platform
    },
    environment: {
      workspaceRoot,
      workingDirectory,
      runsRoot,
      mode: executionMode.mode,
      liveMode: executionMode.liveMode
    },
    scope: {
      invocationRoot: workspaceRoot,
      workingDirectory,
      repoRoot: workingDirectory,
      runsRoot
    },
    engines: {
      claude: {
        available: claude.available,
        detail: claude.detail,
        ...(claude.resolvedPath ? { resolvedPath: claude.resolvedPath } : {})
      },
      codex: {
        available: codex.available,
        detail: codex.detail,
        ...(codex.resolvedPath ? { resolvedPath: codex.resolvedPath } : {}),
        ...(codexProbe
          ? {
              hostPlatform: codexProbe.diagnosis.hostPlatform,
              nativeInstallValid: codexProbe.diagnosis.nativeInstallValid,
              launchReady: codexProbe.ok,
              probeSummary: codexProbe.summary
            }
          : {})
      },
      gemini: {
        available: gemini.available,
        detail: gemini.detail,
        ...(gemini.resolvedPath ? { resolvedPath: gemini.resolvedPath } : {})
      }
    },
    ...(input.engine ? { requestedEngine: input.engine } : {}),
    runStore: {
      exists: runStore.exists,
      loopCount: runStore.loopCount,
      ...(runStore.latestRun ? { latestRun: runStore.latestRun } : {})
    },
    readiness,
    warnings
  };
}
