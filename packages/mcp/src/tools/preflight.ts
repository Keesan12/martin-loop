import { DEFAULT_BUDGET } from "@martin/contracts";
import { resolveRunsRoot } from "@martin/core";

import { resolveSafeRepoRoot } from "../server-validation.js";
import {
  formatUsd,
  getEngineAvailability,
  resolveExecutionMode,
  type MartinEngine
} from "./tool-support.js";

export interface MartinPreflightInput {
  objective: string;
  workingDirectory?: string;
  engine?: MartinEngine;
  model?: string;
  maxUsd?: number;
  maxIterations?: number;
  maxTokens?: number;
  verificationPlan?: string[];
  allowedPaths?: string[];
  deniedPaths?: string[];
  workspaceId?: string;
  projectId?: string;
}

export interface MartinPreflightOutput {
  ok: boolean;
  summary: string;
  warnings: string[];
  readiness: {
    mode: "live" | "stub";
    liveMode: boolean;
    engineReady: boolean;
  };
  normalized: {
    objective: string;
    workingDirectory: string;
    engine: MartinEngine;
    model?: string;
    budget: {
      maxUsd: number;
      softLimitUsd: number;
      maxIterations: number;
      maxTokens: number;
    };
    verificationPlan: string[];
    allowedPaths?: string[];
    deniedPaths?: string[];
    workspaceId: string;
    projectId: string;
  };
  execution: {
    requestedEngine: MartinEngine;
    engineAvailability: {
      available: boolean;
      detail: string;
      resolvedPath?: string;
    };
    runsRoot: string;
    pathScope: {
      repoRoot: string;
      allowedPathsCount: number;
      deniedPathsCount: number;
      hasScopeConflicts: boolean;
    };
    expectedRunLayout: {
      runDirectoryPattern: string;
      loopRecordPathPattern: string;
    };
  };
}

export async function martinPreflightTool(
  input: MartinPreflightInput
): Promise<MartinPreflightOutput> {
  const executionMode = resolveExecutionMode();
  const workingDirectory = resolveSafeRepoRoot(input.workingDirectory);
  const engine = input.engine ?? "claude";
  const engineAvailability = getEngineAvailability(engine);
  const warnings: string[] = [];
  const allowedPaths = input.allowedPaths ?? [];
  const deniedPaths = input.deniedPaths ?? [];
  const overlappingScopes = allowedPaths.filter((candidate) => deniedPaths.includes(candidate));

  const budget = {
    ...DEFAULT_BUDGET,
    ...(input.maxUsd !== undefined ? { maxUsd: input.maxUsd } : {}),
    ...(input.maxIterations !== undefined ? { maxIterations: input.maxIterations } : {}),
    ...(input.maxTokens !== undefined ? { maxTokens: input.maxTokens } : {})
  };

  if (!executionMode.liveMode) {
    warnings.push("Stub mode is active; preflight only proves configuration shape, not live CLI readiness.");
  } else if (!engineAvailability.available) {
    warnings.push(`Requested engine '${engine}' is not available on PATH.`);
  }

  if ((input.verificationPlan?.length ?? 0) === 0) {
    warnings.push("No verificationPlan was provided; Martin can run, but completion confidence will be lower.");
  }

  if ((input.allowedPaths?.length ?? 0) === 0) {
    warnings.push("No allowedPaths were provided; Martin will rely on the broader repo root scope.");
  }

  if (overlappingScopes.length > 0) {
    warnings.push(
      `Some path patterns appear in both allowedPaths and deniedPaths: ${overlappingScopes.join(", ")}.`
    );
  }

  const ok = !executionMode.liveMode || engineAvailability.available;

  return {
    ok,
    summary: ok
      ? `Preflight ready for ${engine} in ${workingDirectory} with a ${formatUsd(budget.maxUsd)} budget cap.`
      : `Preflight blocked: ${engine} is not available for live execution.`,
    warnings,
    readiness: {
      mode: executionMode.mode,
      liveMode: executionMode.liveMode,
      engineReady: !executionMode.liveMode || engineAvailability.available
    },
    normalized: {
      objective: input.objective,
      workingDirectory,
      engine,
      ...(input.model ? { model: input.model } : {}),
      budget,
      verificationPlan: input.verificationPlan ?? [],
      ...(input.allowedPaths ? { allowedPaths: input.allowedPaths } : {}),
      ...(input.deniedPaths ? { deniedPaths: input.deniedPaths } : {}),
      workspaceId: input.workspaceId ?? "ws_mcp",
      projectId: input.projectId ?? "proj_mcp"
    },
    execution: {
      requestedEngine: engine,
      engineAvailability,
      runsRoot: resolveRunsRoot(process.env),
      pathScope: {
        repoRoot: workingDirectory,
        allowedPathsCount: allowedPaths.length,
        deniedPathsCount: deniedPaths.length,
        hasScopeConflicts: overlappingScopes.length > 0
      },
      expectedRunLayout: {
        runDirectoryPattern: "<runsRoot>/<loopId>/",
        loopRecordPathPattern: "<runsRoot>/<loopId>/loop-record.json"
      }
    }
  };
}
