import { spawn } from "node:child_process";

import {
  createAgentCliAdapter,
  type CodexCliAdapterOptions as LegacyCodexCliAdapterOptions
} from "./claude-cli.js";
import {
  buildCodexExecArgs,
  buildCodexStdin,
  probeCodexCapabilities,
  type CodexCapabilityProfile
} from "./codex-launcher.js";
import { createSpawnPlan, type SpawnLike } from "./cli-bridge.js";

export interface CodexCliAdapterOptions extends Omit<LegacyCodexCliAdapterOptions, "command"> {
  /** Exact resolved executable selected by the Codex launch probe. */
  command?: string;
  /**
   * Optional pre-probed capability profile. Production callers normally omit
   * this because probeCodexCapabilities caches profiles by exact binary path
   * for the process lifetime. Exposed for deterministic integrations/tests.
   */
  capabilityProfile?: CodexCapabilityProfile;
}

function createCodexSpawnRouter(input: {
  selectedBinary: string;
  workingDirectory: string;
  injectedSpawn?: SpawnLike;
}): SpawnLike {
  if (input.injectedSpawn) {
    return (command, args = [], options) =>
      input.injectedSpawn?.(
        command === "codex" ? input.selectedBinary : command,
        args,
        options
      ) as ReturnType<SpawnLike>;
  }

  return (command, args = [], options) => {
    const executable = command === "codex" ? input.selectedBinary : command;
    const cwd = typeof options?.cwd === "string" ? options.cwd : input.workingDirectory;
    const plan = createSpawnPlan(executable, [...args], cwd, false);
    return spawn(plan.command, plan.args, options);
  };
}

/**
 * Capability-driven Codex CLI adapter.
 *
 * Provider identity remains `codex` even when doctor/preflight selected an
 * absolute native binary or npm shim. The selected binary's cached capability
 * profile builds both the real argv and stdin transport, while the spawn router
 * sends only the Codex subprocess to that exact executable. Git/verifier
 * subprocesses retain their normal commands.
 */
export function createCodexCliAdapter(options: CodexCliAdapterOptions = {}) {
  const workingDirectory = options.workingDirectory ?? process.cwd();
  const selectedBinary = options.command ?? "codex";
  const capabilityProfile =
    options.capabilityProfile ?? probeCodexCapabilities(selectedBinary);
  const sandbox = options.sandbox ?? "workspace-write";
  const extraArgs = options.extraArgs ?? [];
  const launchModel = options.model;
  const spawnImpl = createCodexSpawnRouter({
    selectedBinary,
    workingDirectory,
    ...(options.spawnImpl ? { injectedSpawn: options.spawnImpl } : {})
  });

  return createAgentCliAdapter({
    // Keep semantic provider identity stable for usage parsing, pricing,
    // diagnostics, and adapter metadata. The spawn router maps this to the
    // exact selected binary at process launch time.
    command: "codex",
    adapterIdSuffix: "codex",
    model: options.model,
    label: options.label ?? "Codex CLI adapter",
    workingDirectory,
    timeoutMs: options.timeoutMs,
    verifyTimeoutMs: options.verifyTimeoutMs,
    supportsJsonOutput: false,
    spawnImpl,
    argsBuilder: (prompt) =>
      buildCodexExecArgs({
        command: selectedBinary,
        workingDirectory,
        sandbox,
        ...(launchModel ? { model: launchModel } : {}),
        extraArgs,
        mode: "prompt",
        prompt,
        capabilityProfile
      }),
    stdinBuilder: (prompt) => buildCodexStdin(capabilityProfile, prompt)
  });
}
