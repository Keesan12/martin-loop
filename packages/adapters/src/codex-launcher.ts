import { fileURLToPath } from "node:url";
import { normalizeProviderExecutionTimeoutMs } from "@martin/contracts";
import {
  buildCodexExecArgs as buildCapabilityDrivenCodexExecArgs,
  markCodexAutonomyResolutionVerifiedByLaunchProbe,
  type CodexCapabilityProfile,
  type CodexExecArgsOptions
} from "./codex-capabilities.js";
import {
  diagnoseCodexHost,
  probeCodexLaunch as probeCodexLaunchHost,
  type CliCommandAvailability,
  type CodexLaunchProbeResult
} from "./codex-host.js";
import {
  spawnSupervisedProcess,
  type ProcessSpawnLike,
  type ProcessTreeCleanupResult,
  type SpawnSupervisedProcessOptions,
  type SupervisedProcessResult
} from "./process-supervisor.js";

/**
 * Compatibility facade for callers that still populate the original
 * `approval` profile field. Internally automation modes and approval policies
 * remain separate capabilities, but either shape drives the same dynamic
 * builder without restoring any hard-coded flag assumption.
 */
export function buildCodexExecArgs(options: CodexExecArgsOptions): string[] {
  const profile = options.capabilityProfile;
  if (!profile?.approval || profile.automation || profile.approvalPolicy) {
    return buildCapabilityDrivenCodexExecArgs(options);
  }

  const normalizedProfile: CodexCapabilityProfile =
    profile.approval.semantics === "automation-mode"
      ? { ...profile, automation: profile.approval }
      : { ...profile, approvalPolicy: profile.approval };

  return buildCapabilityDrivenCodexExecArgs({
    ...options,
    capabilityProfile: normalizedProfile
  });
}

/**
 * Public launch-probe facade. Only a successful probe may brand an autonomy
 * resolution as safe for adapter execution; structurally similar objects
 * supplied directly by callers remain untrusted.
 */
export function probeCodexLaunch(
  input: Parameters<typeof probeCodexLaunchHost>[0]
): CodexLaunchProbeResult {
  const result = probeCodexLaunchHost(input);
  if (result.ok && result.autonomyResolution) {
    markCodexAutonomyResolutionVerifiedByLaunchProbe(result.autonomyResolution);
  }
  return result;
}

export type CodexLaunchProbeAsyncResult = CodexLaunchProbeResult & {
  processCleanup: ProcessTreeCleanupResult;
};

interface CodexLaunchProbeAsyncTestSeams {
  spawnSupervisedProcessImpl?: (
    command: string,
    args: readonly string[],
    options: SpawnSupervisedProcessOptions
  ) => Promise<SupervisedProcessResult>;
}

export async function probeCodexLaunchAsync(input: {
  workingDirectory: string;
  availability: CliCommandAvailability;
  providerExecutionTimeoutMs?: number;
  model?: string;
  signal?: AbortSignal;
  spawnImpl?: ProcessSpawnLike;
}, testSeams: CodexLaunchProbeAsyncTestSeams = {}): Promise<CodexLaunchProbeAsyncResult> {
  const timeoutMs = normalizeProviderExecutionTimeoutMs(input.providerExecutionTimeoutMs);
  const payload = Buffer.from(JSON.stringify({
    workingDirectory: input.workingDirectory,
    availability: input.availability,
    providerExecutionTimeoutMs: timeoutMs,
    ...(input.model ? { model: input.model } : {})
  }), "utf8").toString("base64url");
  const workerPath = fileURLToPath(new URL("./codex-launch-probe-worker.js", import.meta.url));
  const executeSupervised = testSeams.spawnSupervisedProcessImpl ?? spawnSupervisedProcess;
  const execution = await executeSupervised(process.execPath, [workerPath, payload], {
    cwd: input.workingDirectory,
    timeoutMs,
    ...(input.signal ? { signal: input.signal } : {}),
    ...(input.spawnImpl ? { spawnImpl: input.spawnImpl } : {}),
    requireTreeClosureOnSuccess: true
  });

  if (!execution.completed || execution.exitCode !== 0) {
    const diagnosis = diagnoseCodexHost(input.availability);
    const reason = execution.cleanup.state === "failed"
      ? `Codex readiness process-tree cleanup failed: ${execution.cleanup.message}`
      : input.signal?.aborted || execution.terminationReason === "aborted"
        ? "Codex readiness probe was cancelled before completion."
        : execution.timedOut
          ? `Codex readiness probe exceeded the configured ${timeoutMs} ms timeout.`
          : `Codex readiness probe failed: ${execution.stderr.trim() || execution.cleanup.state}.`;
    return {
      ok: false,
      summary: reason,
      availability: input.availability,
      diagnosis,
      command: input.availability.resolvedPath ?? input.availability.command,
      args: [],
      stderr: execution.stderr,
      processCleanup: execution.cleanup
    };
  }

  const serialized = execution.stdout.trim().split(/\r?\n/u).at(-1);
  if (!serialized) {
    throw new Error("Codex readiness probe worker returned no result.");
  }
  const result = JSON.parse(serialized) as CodexLaunchProbeResult;
  if (result.ok && result.autonomyResolution) {
    markCodexAutonomyResolutionVerifiedByLaunchProbe(result.autonomyResolution);
  }
  return { ...result, processCleanup: execution.cleanup };
}

export {
  buildCodexStdin,
  cacheCodexCapabilityProfile,
  clearCodexCapabilityCacheForTests,
  codexWriteStrategies,
  isCodexAutonomyResolutionVerifiedByLaunchProbe,
  probeCodexCapabilities,
  resolveCodexAutonomyCandidates,
  type CodexAutonomyResolution,
  type CodexApprovalCapability,
  type CodexCapabilityFlag,
  type CodexCapabilityProfile,
  type CodexExecArgsOptions,
  type CodexFlagScope,
  type CodexPromptTransport,
  type CodexSandboxCapability,
  type CodexWriteStrategy
} from "./codex-capabilities.js";

export {
  checkCodexSandboxPreflight,
  detectCodexHostPlatform,
  diagnoseCodexHost,
  probeFilesystemWriteCapability,
  resolveCliCommandAvailability,
  type CliCommandAvailability,
  type CodexHostDiagnosis,
  type CodexHostPlatform,
  type CodexInstallKind,
  type CodexInvocationMode,
  type CodexLaunchProbeResult,
  type CodexProbeCandidateResult,
  type CodexSandboxPreflightOk,
  type CodexSandboxPreflightOutcome,
  type CodexSandboxPreflightReadOnly
} from "./codex-host.js";
