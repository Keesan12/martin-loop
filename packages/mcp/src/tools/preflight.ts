import {
  probeCodexLaunch,
  resolveCliCommandAvailability,
  type CodexHostPlatform
} from "@martin/adapters";
import {
  fetchSelectedMessage,
  getMcpInstalledVersion,
  isCooldownExpired,
  isDismissed,
  isNewerVersion,
  loadDeliveryRecord,
  recordShown,
  resolveDefaultLedgerPath,
  resolveRunsRoot,
  saveDeliveryRecord,
  describeMalformedVerifier,
  deniesAllWritablePaths,
} from "@martin/core";
import type { UpdateAvailableField } from "@martin/contracts";

import { MARTIN_MCP_PACKAGE_VERSION } from "../package-version.js";
import { resolveSafeRepoRoot } from "../server-validation.js";
import {
  createSkippedCliAvailability,
  formatUsd,
  getEngineAvailability,
  resolveProviderNeutralEngine,
  resolveExecutionMode,
  type CliAvailability,
  type MartinEngine
} from "./tool-support.js";
import {
  buildPlanProposal,
  normalizeLoopBudget,
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
  pricePerMTokenUsd?: number;
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
    engine: MartinEngine | "auto";
    model?: string;
    pricePerMTokenUsd?: number;
    budget: {
      maxUsd: number;
      softLimitUsd: number;
      maxIterations: number;
      maxTokens?: number;
    };
    verificationPlan: string[];
    allowedPaths?: string[];
    deniedPaths?: string[];
    workspaceId: string;
    projectId: string;
  };
  execution: {
    requestedEngine: MartinEngine | "auto";
    engineAvailability: {
      available: boolean;
      detail: string;
      resolvedPath?: string;
      candidatePaths?: string[];
      transport?: "cli" | "http";
    };
    codexDiagnostics?: {
      selectedPath?: string;
      hostPlatform: CodexHostPlatform;
      installKind: string;
      nativeInstallValid: boolean;
      invocationMode: string;
      sandboxMode: string;
      sandboxCompatible: boolean;
      nativeDependencyStatus?: string;
      nativeDependencyPackage?: string;
      launchReady: boolean;
      summary: string;
      remediation?: string;
      candidateProbeResults?: Array<{
        path: string;
        installKind: string;
        invocationMode: string;
        nativeInstallValid: boolean;
        sandboxCompatible: boolean;
        launchReady: boolean;
        summary: string;
        remediation?: string;
        nativeDependencyStatus?: string;
        nativeDependencyPackage?: string;
      }>;
    };
    runsRoot: string;
    pathScope: {
      repoRoot: string;
      allowedPathsCount: number;
      deniedPathsCount: number;
      hasScopeConflicts: boolean;
      hasWritableSurface: boolean;
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
  updateAvailable?: UpdateAvailableField;
}

export async function martinPreflightTool(
  input: MartinPreflightInput
): Promise<MartinPreflightOutput> {
  // Fire delivery fetch early so it races with the rest of preflight work.
  const mcpVersion = getMcpInstalledVersion() ?? MARTIN_MCP_PACKAGE_VERSION;
  const deliveryFetchPromise = fetchSelectedMessage(
    { clientVersion: mcpVersion, clientKind: "mcp", trigger: "version_check" },
    { timeoutMs: 3_000 }
  ).catch(() => null);

  const executionMode = resolveExecutionMode();
  const workspaceRoot = resolveSafeRepoRoot();
  const workingDirectory = resolveSafeRepoRoot(input.workingDirectory);
  const signals = inspectRepoSignals(workingDirectory, {
    includeHostAvailability: executionMode.liveMode
  });
  const neutralResolution = !input.engine && executionMode.liveMode
    ? resolveProviderNeutralEngine()
    : undefined;
  const engine = input.engine ?? neutralResolution?.engine ?? "auto";
  const engineAvailability: CliAvailability =
    !executionMode.liveMode
      ? createSkippedCliAvailability(engine)
      : engine === "auto"
        ? {
            command: "auto",
            available: false,
            locator: "provider-neutral-selection",
            detail: neutralResolution?.detail ?? "Pass engine explicitly."
          }
        : engine === "codex"
          ? resolveCliCommandAvailability("codex")
          : getEngineAvailability(engine, input.model, input.pricePerMTokenUsd);
  const codexProbe =
    executionMode.liveMode && engine === "codex" && engineAvailability.available
      ? probeCodexLaunch({
          workingDirectory,
          availability: engineAvailability
        })
      : undefined;
  const warnings: string[] = [];
  const malformedVerifiers = (input.verificationPlan ?? [])
    .map((command) => describeMalformedVerifier(command, { detectShellFold: false }))
    .filter((reason): reason is string => reason !== undefined);
  const allowedPaths = input.allowedPaths ?? [];
  const deniedPaths = input.deniedPaths ?? [];
  const overlappingScopes = allowedPaths.filter((candidate) => deniedPaths.includes(candidate));
  const denyAllWritableSurface = deniesAllWritablePaths(deniedPaths);

  const budget = normalizeLoopBudget({
    maxUsd: input.maxUsd,
    maxIterations: input.maxIterations,
    maxTokens: input.maxTokens
  });

  if (!executionMode.liveMode) {
    warnings.push("Verification-only mode is active; it cannot emit governed VERIFIED or prove live CLI readiness.");
  } else if (!engineAvailability.available) {
    warnings.push(`Requested engine '${engine}' is not ready: ${engineAvailability.detail}`);
  } else if (engine === "codex" && codexProbe && !codexProbe.ok) {
    warnings.push(codexProbe.summary);
  }

  if ((input.verificationPlan?.length ?? 0) === 0) {
    warnings.push("No verificationPlan was provided; Martin can run, but completion confidence will be lower.");
  }
  warnings.push(...malformedVerifiers);

  if (denyAllWritableSurface) {
    warnings.push("The deniedPaths policy removes every writable path; mutation-capable execution is blocked.");
  } else if ((input.allowedPaths?.length ?? 0) === 0) {
    warnings.push("No allowedPaths were provided; Martin will rely on the broader repo root scope.");
  }
  if (overlappingScopes.length > 0) {
    warnings.push(
      `Some path patterns appear in both allowedPaths and deniedPaths: ${overlappingScopes.join(", ")}.`
    );
  }

  const plan = buildPlanProposal(workingDirectory, input, { signals });
  const runContract = buildRunContract(workingDirectory, input, { signals, plan });
  const policy = buildPolicyPackDefinition(input.policyPack, signals);

  const engineReady =
    !executionMode.liveMode ||
    (engine !== "auto" && engineAvailability.available && (engine !== "codex" || codexProbe?.ok !== false));
  const blocksMutationExecution = executionMode.liveMode && denyAllWritableSurface;
  const ok = engineReady && malformedVerifiers.length === 0 && !blocksMutationExecution;
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
          (blocksMutationExecution
            ? "The path policy leaves no writable surface."
            : malformedVerifiers[0]) ?? (engine === "codex" && codexProbe && !codexProbe.ok
            ? codexProbe.summary
            : engineAvailability.detail)
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
      ...(input.pricePerMTokenUsd !== undefined ? { pricePerMTokenUsd: input.pricePerMTokenUsd } : {}),
      budget,
      verificationPlan: input.verificationPlan ?? [],
      ...(input.allowedPaths ? { allowedPaths: input.allowedPaths } : {}),
      ...(input.deniedPaths ? { deniedPaths: input.deniedPaths } : {}),
      workspaceId: input.workspaceId ?? "ws_mcp",
      projectId: input.projectId ?? "proj_mcp"
    },
    execution: {
      requestedEngine: engine,
      engineAvailability: {
        available: engineAvailability.available,
        detail: engineAvailability.detail,
        ...(engineAvailability.resolvedPath ? { resolvedPath: engineAvailability.resolvedPath } : {}),
        ...(engineAvailability.candidatePaths?.length
          ? { candidatePaths: engineAvailability.candidatePaths }
          : {}),
        ...(engineAvailability.transport ? { transport: engineAvailability.transport } : {})
      },
      ...(codexProbe
        ? {
            codexDiagnostics: {
              selectedPath: codexProbe.command,
              hostPlatform: codexProbe.diagnosis.hostPlatform,
              installKind: codexProbe.diagnosis.installKind,
              nativeInstallValid: codexProbe.diagnosis.nativeInstallValid,
              invocationMode: codexProbe.diagnosis.invocationMode,
              sandboxMode: codexProbe.diagnosis.sandboxMode,
              sandboxCompatible: codexProbe.diagnosis.sandboxCompatible,
              ...(codexProbe.diagnosis.nativeDependencyStatus
                ? { nativeDependencyStatus: codexProbe.diagnosis.nativeDependencyStatus }
                : {}),
              ...(codexProbe.diagnosis.nativeDependencyPackage
                ? { nativeDependencyPackage: codexProbe.diagnosis.nativeDependencyPackage }
                : {}),
              launchReady: codexProbe.ok,
              summary: codexProbe.summary,
              ...(codexProbe.diagnosis.remediation ? { remediation: codexProbe.diagnosis.remediation } : {}),
              ...(codexProbe.candidateProbeResults?.length
                ? { candidateProbeResults: codexProbe.candidateProbeResults }
                : {})
            }
          }
        : {}),
      runsRoot: resolveRunsRoot(process.env),
      pathScope: {
        repoRoot: workingDirectory,
        allowedPathsCount: allowedPaths.length,
        deniedPathsCount: deniedPaths.length,
        hasScopeConflicts: overlappingScopes.length > 0,
        hasWritableSurface: !denyAllWritableSurface
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
    ...await resolvePreflightUpdateAvailable(deliveryFetchPromise, mcpVersion)
  };
}

async function resolvePreflightUpdateAvailable(
  fetchPromise: Promise<import("@martin/contracts").DeliveryMessage | null>,
  currentVersion: string
): Promise<{ updateAvailable?: UpdateAvailableField }> {
  try {
    const message = await fetchPromise;
    if (!message) return {};
    if (message.action.type !== "upgrade_mcp") return {};
    const targetVersion = message.action.targetVersion;
    if (!targetVersion) return {};
    if (!isNewerVersion(currentVersion, targetVersion)) return {};

    const ledgerPath = resolveDefaultLedgerPath();
    const record = loadDeliveryRecord(ledgerPath);
    const nowMs = Date.now();

    if (!isCooldownExpired(record, nowMs)) return {};
    if (isDismissed(record, message.id)) return {};

    try {
      saveDeliveryRecord(ledgerPath, recordShown(record, message, nowMs));
    } catch { /* ledger write failure must not surface */ }

    return {
      updateAvailable: {
        targetVersion,
        kind: "mcp",
        message: message.body
      }
    };
  } catch {
    return {};
  }
}
