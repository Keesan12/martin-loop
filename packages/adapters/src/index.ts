// SPDX-FileCopyrightText: MartinLoop contributors
//
// SPDX-License-Identifier: Apache-2.0

export {
  createDirectProviderAdapter,
  type DirectProviderAdapterOptions
} from "./direct-provider.js";
export {
  createStubDirectProviderAdapter,
  type StubDirectProviderAdapterOptions
} from "./stub-direct-provider.js";
export {
  createStubAgentCliAdapter,
  type StubAgentCliAdapterOptions
} from "./stub-agent-cli.js";
export {
  createAgentCliAdapter,
  createClaudeCliAdapter,
  createCodexCliAdapter,
  createGeminiCliAdapter,
  type AgentCliAdapterOptions,
  type ClaudeCliAdapterOptions,
  type CodexCliAdapterOptions,
  type GeminiCliAdapterOptions,
  type CliArgsBuilder
} from "./claude-cli.js";
export {
  createVerifierOnlyAdapter,
  type VerifierOnlyAdapterOptions
} from "./verifier-only.js";
export {
  createOpenAiCompatibleAdapter,
  resolveOpenAiCompatibleRuntimeConfig,
  type OpenAiCompatibleAdapterOptions
} from "./openai-compatible.js";
export {
  detectCodexHostPlatform,
  diagnoseCodexHost,
  probeCodexLaunch,
  resolveCliCommandAvailability,
  type CliCommandAvailability,
  type CodexHostDiagnosis,
  type CodexHostPlatform,
  type CodexLaunchProbeResult
} from "./codex-launcher.js";
export {
  createSpawnPlan,
  type SpawnLike,
  type SpawnPlan,
  type SubprocessResult,
  type VerificationOutcome
} from "./cli-bridge.js";
