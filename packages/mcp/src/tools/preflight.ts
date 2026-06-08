import {
  probeCodexLaunch,
  type CodexHostPlatform
} from "@martin/adapters";
import { DEFAULT_BUDGET, type ExecutionPolicy } from "@martin/contracts";
import type { AdapterCapabilityDescriptor } from "@martin/contracts";
import { resolveRunsRoot } from "@martin/core";

import { normalizeSafePathPatterns, resolveSafeRepoRoot } from "../server-validation.js";
import {
  formatUsd,
  getEngineAvailability,
  resolveExecutionMode,
  type MartinEngine
} from "./tool-support.js";
import { compileMcpExecutionPolicy } from "./execution-policy.js";
import {
  buildPlanProposal,
  buildRunContract,
  buildPolicyPackDefinition,
  inspectRepoSignals,
  type MartinPlanProposal,
  type MartinPolicyPack,
  type MartinRiskAssessment,
  type MartinRunContract
} from "./workflow-governance.js";

export interface MartinPreflightInput {
  objective: string;
  workingDirectory?: string;
  engine?: MartinEngine;
  model?: string;
  context?: string;
  policyPack?: MartinPolicyPack;
  maxUsd?: number;
  maxIterations?: number;
  maxTokens?: number;
  maxMinutes?: number;
  maxFilesChanged?: number;
  maxCommands?: number;
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
  receiptScope: {
    invocationRoot: string;
    workingDirectory: string;
    repoRoot: string;
    runsRoot: string;
  };
  scope: {
    invocationRoot: string;
    workingDirectory: string;
    repoRoot: string;
    runsRoot: string;
  };
  readiness: {
    mode: "live" | "proof";
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
      capabilities: AdapterCapabilityDescriptor;
      resolvedPath?: string;
    };
    codexDiagnostics?: {
      hostPlatform: CodexHostPlatform;
      nativeInstallValid: boolean;
      launchReady: boolean;
      summary: string;
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
  policy: ReturnType<typeof buildPolicyPackDefinition>;
  risk: MartinRiskAssessment;
  runContract: MartinRunContract;
  plan: MartinPlanProposal;
  effectivePolicy: ExecutionPolicy;
}

export async function martinPreflightTool(
  input: MartinPreflightInput
): Promise<MartinPreflightOutput> {
  const executionMode = resolveExecutionMode();
  const workspaceRoot = resolveSafeRepoRoot();
  const workingDirectory = resolveSafeRepoRoot(input.workingDirectory);
  const signals = inspectRepoSignals(workingDirectory);
  const engine = input.engine ?? "claude";
  const engineAvailability = getEngineAvailability(engine);
  const codexProbe =
    executionMode.liveMode && engine === "codex" && engineAvailability.available
      ? probeCodexLaunch({
          workingDirectory,
          availability: engineAvailability
        })
      : undefined;
  const warnings: string[] = [];
  const allowedPaths = normalizeSafePathPatterns(input.allowedPaths, "allowedPaths") ?? [];
  const deniedPaths = normalizeSafePathPatterns(input.deniedPaths, "deniedPaths") ?? [];
  const overlappingScopes = allowedPaths.filter((candidate) => deniedPaths.includes(candidate));
  const effectivePolicy = compileMcpExecutionPolicy({
    workingDirectory,
    maxUsd: input.maxUsd,
    maxIterations: input.maxIterations,
    maxTokens: input.maxTokens,
    verificationPlan: input.verificationPlan,
    allowedPaths,
    deniedPaths
  });
  const budget = effectivePolicy.budget;

  if (!executionMode.liveMode) {
    warnings.push("Proof mode is active; preflight only proves configuration shape, not live CLI readiness.");
  } else if (!engineAvailability.available) {
    warnings.push(`Requested engine '${engine}' is not available on PATH.`);
  } else if (engine === "codex" && codexProbe && !codexProbe.ok) {
    warnings.push(codexProbe.summary);
  }

  if (effectivePolicy.task.verificationPlan.length === 0) {
    warnings.push("No verificationPlan was provided; Martin can run, but completion confidence will be lower.");
  }

  if ((effectivePolicy.task.allowedPaths?.length ?? 0) === 0) {
    warnings.push("No allowedPaths were provided; Martin will rely on the broader repo root scope.");
  }
  if (overlappingScopes.length > 0) {
    warnings.push(
      `Some path patterns appear in both allowedPaths and deniedPaths: ${overlappingScopes.join(", ")}.`
    );
  }

  const normalizedInput = {
    ...input,
    maxUsd: budget.maxUsd,
    maxIterations: budget.maxIterations,
    maxTokens: budget.maxTokens,
    verificationPlan: effectivePolicy.task.verificationPlan,
    allowedPaths: effectivePolicy.task.allowedPaths,
    deniedPaths: effectivePolicy.task.deniedPaths
  };
  const plan = buildPlanProposal(workingDirectory, normalizedInput);
  const runContract = buildRunContract(workingDirectory, normalizedInput);
  const policy = buildPolicyPackDefinition(input.policyPack, signals);

  const engineReady =
    !executionMode.liveMode ||
    (engineAvailability.available && (engine !== "codex" || codexProbe?.ok !== false));
  const ok = engineReady;
  const receiptScope = {
    invocationRoot: workspaceRoot,
    workingDirectory,
    repoRoot: workingDirectory,
    runsRoot: resolveRunsRoot(process.env)
  };

  return {
    ok,
    summary: ok
      ? `Preflight ready for ${engine} in ${workingDirectory} with a ${formatUsd(budget.maxUsd)} budget cap and ${runContract.risk.level} risk.`
      : `Preflight blocked: ${
          engine === "codex" && codexProbe && !codexProbe.ok
            ? codexProbe.summary
            : `${engine} is not available for live execution.`
        }`,
    warnings,
    receiptScope,
    scope: {
      ...receiptScope
    },
    readiness: {
      mode: executionMode.mode,
      liveMode: executionMode.liveMode,
      engineReady
    },
    normalized: {
      objective: input.objective,
      workingDirectory,
      engine,
      ...(input.model ? { model: input.model } : {}),
      budget,
      verificationPlan: effectivePolicy.task.verificationPlan,
      ...(effectivePolicy.task.allowedPaths ? { allowedPaths: effectivePolicy.task.allowedPaths } : {}),
      ...(effectivePolicy.task.deniedPaths ? { deniedPaths: effectivePolicy.task.deniedPaths } : {}),
      workspaceId: input.workspaceId ?? "ws_mcp",
      projectId: input.projectId ?? "proj_mcp"
    },
    execution: {
      requestedEngine: engine,
      engineAvailability: {
        available: engineAvailability.available,
        detail: engineAvailability.detail,
        capabilities: engineAvailability.capabilities,
        ...(engineAvailability.resolvedPath
          ? { resolvedPath: engineAvailability.resolvedPath }
          : {})
      },
      ...(codexProbe
        ? {
            codexDiagnostics: {
              hostPlatform: codexProbe.diagnosis.hostPlatform,
              nativeInstallValid: codexProbe.diagnosis.nativeInstallValid,
              launchReady: codexProbe.ok,
              summary: codexProbe.summary
            }
          }
        : {}),
      runsRoot: resolveRunsRoot(process.env),
      pathScope: {
        repoRoot: workingDirectory,
        allowedPathsCount: effectivePolicy.task.allowedPaths?.length ?? 0,
        deniedPathsCount: effectivePolicy.task.deniedPaths?.length ?? 0,
        hasScopeConflicts: overlappingScopes.length > 0
      },
      expectedRunLayout: {
        runDirectoryPattern: "<runsRoot>/<loopId>/",
        loopRecordPathPattern: "<runsRoot>/<loopId>/loop-record.json"
      }
    },
    policy,
    risk: runContract.risk,
    runContract,
    plan,
    effectivePolicy
  };
}
