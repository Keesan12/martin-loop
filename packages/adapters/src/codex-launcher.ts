import {
  buildCodexExecArgs as buildCapabilityDrivenCodexExecArgs,
  type CodexCapabilityProfile,
  type CodexExecArgsOptions
} from "./codex-capabilities.js";

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

export {
  buildCodexStdin,
  cacheCodexCapabilityProfile,
  clearCodexCapabilityCacheForTests,
  codexWriteStrategies,
  probeCodexCapabilities,
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
  probeCodexLaunch,
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
