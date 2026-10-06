import {
  createAgentCliAdapter,
  type CodexCliAdapterOptions as LegacyCodexCliAdapterOptions
} from "./claude-cli.js";
import {
  buildCodexExecArgs,
  buildCodexStdin,
  isCodexAutonomyResolutionVerifiedByLaunchProbe,
  probeCodexCapabilities,
  type CodexAutonomyResolution,
  type CodexCapabilityProfile
} from "./codex-launcher.js";

export interface CodexCliAdapterOptions extends Omit<LegacyCodexCliAdapterOptions, "command"> {
  /** Exact resolved executable selected by the Codex launch probe. */
  command?: string;
  /**
   * Optional pre-probed capability profile. Production callers normally omit
   * this because probeCodexCapabilities caches profiles by exact binary path
   * for the process lifetime. Exposed for deterministic integrations/tests.
   */
  capabilityProfile?: CodexCapabilityProfile;
  autonomyResolution?: CodexAutonomyResolution;
}

/**
 * Capability-driven Codex CLI adapter.
 *
 * Provider identity remains `codex` even when doctor/preflight selected an
 * absolute native binary or npm shim. The selected binary's cached capability
 * profile builds both the real argv and stdin transport. The generic adapter's
 * execution-command boundary sends only the Codex subprocess to that exact
 * executable, while Git/verifier subprocesses retain normal OS-owned spawning.
 */
export function createCodexCliAdapter(options: CodexCliAdapterOptions = {}) {
  const workingDirectory = options.workingDirectory ?? process.cwd();
  const selectedBinary = options.command ?? options.capabilityProfile?.binaryPath ?? "codex";
  const capabilityProfile =
    options.capabilityProfile ?? probeCodexCapabilities(selectedBinary);
  const autonomyResolution = options.autonomyResolution;
  if (capabilityProfile.binaryPath !== selectedBinary) {
    throw new Error("Codex exact binary capability profile mismatch.");
  }
  if (autonomyResolution && autonomyResolution.binaryPath !== selectedBinary) {
    throw new Error("Codex exact binary autonomy resolution mismatch.");
  }
  if (autonomyResolution && !isCodexAutonomyResolutionVerifiedByLaunchProbe(autonomyResolution)) {
    throw new Error("Codex autonomy resolution was not verified by the launch probe.");
  }
  const sandbox = options.sandbox ?? "workspace-write";
  const extraArgs = options.extraArgs ?? [];
  const launchModel = options.model;
  return createAgentCliAdapter({
    // Keep semantic provider identity stable for usage parsing, pricing,
    // diagnostics, and adapter metadata. executionCommand selects the exact
    // binary without disguising production OS spawning as a test injection.
    command: "codex",
    executionCommand: selectedBinary,
    adapterIdSuffix: "codex",
    model: options.model,
    label: options.label ?? "Codex CLI adapter",
    workingDirectory,
    timeoutMs: options.timeoutMs,
    agentExecutionIntent: options.agentExecutionIntent,
    providerExecutionTimeoutMs: options.providerExecutionTimeoutMs,
    verifyTimeoutMs: options.verifyTimeoutMs,
    supportsJsonOutput: false,
    streamingUsageCap: true,
    streamingTokenCap: true,
    streamingUsageDetailsIncludedInTotals: true,
    spawnImpl: options.spawnImpl,
    argsBuilder: (prompt) =>
      buildCodexExecArgs({
        command: selectedBinary,
        workingDirectory,
        sandbox,
        ...(launchModel ? { model: launchModel } : {}),
        extraArgs,
        mode: "prompt",
        prompt,
        capabilityProfile,
        ...(autonomyResolution ? { autonomyResolution } : {})
      }),
    stdinBuilder: (prompt) => buildCodexStdin(capabilityProfile, prompt)
  });
}
