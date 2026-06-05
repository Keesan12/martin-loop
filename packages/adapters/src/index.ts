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
  type AgentCliAdapterOptions,
  type ClaudeCliAdapterOptions,
  type CodexCliAdapterOptions,
  type CliArgsBuilder
} from "./claude-cli.js";
export {
  createVerifierOnlyAdapter,
  type VerifierOnlyAdapterOptions
} from "./verifier-only.js";
export {
  createOpenAiCompatibleAdapter,
  type OpenAiCompatibleAdapterOptions
} from "./openai-compatible.js";
export {
  createSpawnPlan,
  readGitChangedFiles,
  type SpawnLike,
  type SpawnPlan,
  type SubprocessResult,
  type VerificationOutcome
} from "./cli-bridge.js";
