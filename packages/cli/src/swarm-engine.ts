// SPDX-FileCopyrightText: MartinLoop contributors
//
// SPDX-License-Identifier: Apache-2.0

import {
  createClaudeCliAdapter,
  createCodexCliAdapter,
  createGeminiCliAdapter,
  createOpenAiCompatibleAdapter,
  probeCodexLaunch,
  type CodexAutonomyResolution,
  type CodexCapabilityProfile,
} from "@martin/adapters";
import type { MartinAdapter } from "@martin/core";
import type { SwarmChildAdapterFactory } from "../../core/dist/swarm/live-runtime.js";
import { SWARM_LIVE_ENGINES, type SwarmLiveEngineProfile } from "@martin/contracts";

import { CliCommandError } from "./ux.js";

const LIVE_ENGINES = SWARM_LIVE_ENGINES;
const FORBIDDEN_MODEL_SENTINELS = new Set(["auto", "proof", "stub", "fallback", "simulation", "default"]);

interface SwarmEngineFactories {
  claude(options: { workingDirectory: string; model: string; readOnly: boolean }): MartinAdapter;
  codex(options: {
    workingDirectory: string;
    model: string;
    sandbox: "read-only" | "workspace-write";
    command?: string;
    capabilityProfile?: CodexCapabilityProfile;
    autonomyResolution?: CodexAutonomyResolution;
  }): MartinAdapter;
  gemini(options: { workingDirectory: string; model: string; readOnly: boolean }): MartinAdapter;
  openai(options: { workingDirectory: string; model: string }): MartinAdapter;
}

export interface CodexLaunchBinding {
  command: string;
  capabilityProfile: CodexCapabilityProfile;
  autonomyResolution: CodexAutonomyResolution;
}

export type CodexLaunchResolver = (input: {
  workingDirectory: string;
  model: string;
}) => CodexLaunchBinding;

export function resolveCodexSwarmLaunchBinding(input: {
  workingDirectory: string;
  model: string;
}): CodexLaunchBinding {
  const probed = probeCodexLaunch(input);
  if (!probed.ok || !probed.capabilityProfile || !probed.autonomyResolution) {
    throw new CliCommandError(
      "policy_blocked",
      `Codex governed launch negotiation failed: ${probed.summary}`,
    );
  }
  return {
    command: probed.command,
    capabilityProfile: probed.capabilityProfile,
    autonomyResolution: probed.autonomyResolution,
  };
}

const productionFactories: SwarmEngineFactories = {
  claude: (options) => createClaudeCliAdapter(options),
  codex: (options) => createCodexCliAdapter(options),
  gemini: (options) => createGeminiCliAdapter(options),
  openai: (options) => {
    const adapter = createOpenAiCompatibleAdapter(options);
    return {
      ...adapter,
      metadata: {
        ...adapter.metadata,
        providerId: "openai",
      },
    };
  },
};

export function createExplicitSwarmAdapterFactory(
  selected: SwarmLiveEngineProfile,
  factories: SwarmEngineFactories = productionFactories,
  injectedCodexLaunch?: CodexLaunchBinding | CodexLaunchResolver,
): SwarmChildAdapterFactory {
  assertConcreteSwarmEngineProfile(selected);
  if (selected.engine === "codex" && !injectedCodexLaunch) {
    throw new CliCommandError(
      "policy_blocked",
      "Codex governed launch binding is required before creating live swarm adapters.",
    );
  }
  const binding = Object.freeze({ engine: selected.engine, model: selected.model.trim() });

  return (input) => {
    if (input.engine.engine !== binding.engine || input.engine.model !== binding.model) {
      throw new CliCommandError(
        "policy_blocked",
        "Swarm child engine binding does not match the exact approved plan.",
      );
    }
    const options = { workingDirectory: input.workspace.path, model: binding.model };
    const readOnly = input.task.mutationMode === "read_only";
    switch (binding.engine) {
      case "claude":
        return factories.claude({ ...options, readOnly });
      case "codex": {
        const launchBinding = typeof injectedCodexLaunch === "function"
          ? injectedCodexLaunch({
              workingDirectory: input.workspace.path,
              model: binding.model,
            })
          : injectedCodexLaunch;
        if (!launchBinding) {
          throw new CliCommandError(
            "policy_blocked",
            "Codex governed launch binding is required before creating a live swarm child adapter.",
          );
        }
        return factories.codex({
          ...options,
          sandbox: readOnly ? "read-only" : "workspace-write",
          ...launchBinding,
        });
      }
      case "gemini":
        return factories.gemini({ ...options, readOnly });
      case "openai":
        return factories.openai(options);
    }
  };
}

export function assertConcreteSwarmEngineProfile(profile: SwarmLiveEngineProfile): void {
  if (!LIVE_ENGINES.includes(profile.engine)) {
    throw new CliCommandError(
      "invalid_input",
      "Live swarm requires one concrete live engine: claude, codex, gemini, or openai.",
    );
  }
  const model = typeof profile.model === "string" ? profile.model.trim().toLowerCase() : "";
  if (!model || profile.model !== profile.model.trim() || FORBIDDEN_MODEL_SENTINELS.has(model)) {
    throw new CliCommandError("invalid_input", "Live swarm requires one explicit concrete model.");
  }
}
