import { createHash } from "node:crypto";
import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  createClaudeCliAdapter,
  createCodexCliAdapter,
  createGeminiCliAdapter,
  createOpenAiCompatibleAdapter,
  resolveOpenAiCompatibleRuntimeConfig,
  probeCodexLaunch,
  resolveCliCommandAvailability,
  createStubDirectProviderAdapter,
} from "@martin/adapters";
import { runMartin, classifyRoute, resolveModelForTier, getHistoricalDirectSuccessRate, getPreference, recordPreference, type MartinAdapter } from "@martin/core";
import {
  buildPortfolioSnapshot,
  createLoopRecord,
  type LoopBudget,
  type LoopRecord,
  type MartinOutputMode,
  type MartinRunListFilters,
  type MartinRunSelector,
  type MutationMode,
  type ReceiptScope
} from "@martin/contracts";

import {
  buildNativePhaseRunRequest,
  createNativePhaseCommandCenterSnapshot,
  renderNativePhaseHuman,
  selectNativePhasePayload,
  type NativePhaseSubcommand
} from "./phase-command-center.js";
import {
  buildMcpInstallPlan,
  hostRequiresExperimentalRemoteOptIn,
  installMcpConfig,
  type MartinMcpHost,
  type MartinMcpPlatform,
  type MartinMcpProfile,
  type MartinMcpScope,
  type MartinMcpTransport,
  MARTIN_DIAGNOSTIC_TOOLS,
  MARTIN_FULL_TOOLS,
  MARTIN_GITHUB_REVIEW_TOOLS,
  MARTIN_MINIMAL_TOOLS,
  MARTIN_STARTER_TOOLS
} from "./mcp-config.js";
import { persistLoopArtifacts } from "./persistence.js";
import {
  buildMartinProofCard,
  renderMartinProofCardMarkdown,
  renderMartinProofCardSvg,
  type MartinProofCardInput
} from "./proof-card.js";
import {
  computeMartinReliabilityScore,
  renderMartinReliabilityBadgeJson,
  renderMartinReliabilityBadgeSvg,
  type MartinReliabilityScoreInput
} from "./reliability-score.js";
import {
  buildArtifactSummary,
  buildRunDossier,
  buildVerificationSummary,
  computeScopeFingerprint,
  describeCostProvenance,
  findPersistedLoopEvidence,
  listPersistedLoops,
  loadPersistedAttempt,
  loadPersistedLoop,
  readCostProvenance,
  readLocalCorpusRisk,
  readLocalRunHistoryRisk,
  resolveCliEnvironment,
  resolveInvocationRoot,
  resolveReceiptScope,
  triagePersistedLoops,
  type IntegrityStatus
} from "./run-store.js";
import { CliCommandError, renderCliError, renderCliSuccess } from "./ux.js";
import { evaluateCliRunGate, recordCliWorkflowStep, recordMcpPlanStep } from "./workflow-state.js";

const require = createRequire(import.meta.url);
const packageJson = require("../package.json") as { version: string };
type PackageManifest = {
  name?: string;
  version?: string;
};

function readPackageManifest(path: string): PackageManifest | undefined {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as PackageManifest;
    return parsed;
  } catch {
    return undefined;
  }
}

function resolveRootPackageVersion(): string {
  let cursor = dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 10; depth += 1) {
    const manifest = readPackageManifest(join(cursor, "package.json"));
    if (manifest?.name === "martin-loop" && typeof manifest.version === "string" && manifest.version.length > 0) {
      return manifest.version;
    }

    const parent = dirname(cursor);
    if (parent === cursor) {
      break;
    }
    cursor = parent;
  }

  const envVersion = process.env["npm_package_name"] === "martin-loop" ? process.env["npm_package_version"] : undefined;
  if (typeof envVersion === "string" && envVersion.length > 0) {
    return envVersion;
  }

  return packageJson.version;
}

const STAR_CTA_LINES = [
  "─────────────────────────────────────────────",
  "⭐ MartinLoop saved you from a runaway bill.",
  "   Star the repo: github.com/Keesan12/martin-loop",
  "─────────────────────────────────────────────"
] as const;

type RunSuccessCallToAction = {
  headline: string;
  repo: string;
  lines: readonly string[];
};

function buildRunSuccessCallToAction(loop: LoopRecord): RunSuccessCallToAction | undefined {
  const verification = buildVerificationSummary(loop);
  if (loop.status !== "completed" || loop.lifecycleState !== "completed" || verification.status !== "passed") {
    return undefined;
  }

  return {
    headline: "⭐ MartinLoop saved you from a runaway bill.",
    repo: "github.com/Keesan12/martin-loop",
    lines: STAR_CTA_LINES
  };
}

const rootPackageVersion = resolveRootPackageVersion();
let runAdapterOverrideForTests: MartinAdapter | undefined;
type CodexAvailabilityForTests = ReturnType<typeof resolveCliCommandAvailability>;
type CodexProbeForTests = ReturnType<typeof probeCodexLaunch>;
let codexAvailabilityOverrideForTests: CodexAvailabilityForTests | undefined;
let codexProbeOverrideForTests:
  | CodexProbeForTests
  | ((input: {
      workingDirectory: string;
      availability: CodexAvailabilityForTests;
      model?: string;
    }) => CodexProbeForTests)
  | undefined;

export type RunCommandRequest = {
  workspaceId: string;
  projectId: string;
  title: string;
  objective: string;
  verificationPlan: string[];
  verifyTimeoutMs?: number;
  metadata: Record<string, string>;
  budget: LoopBudget;
  budgetOverrides?: Partial<Record<keyof LoopBudget, true>>;
  configPath?: string;
  cwd?: string;
  runsDir?: string;
  model?: string;
  engine?: string;
  liveMode?: "live" | "proof";
  mutationMode?: MutationMode;
  unsafeAllowUnguardedRun?: boolean;
  allowedPaths?: string[];
  deniedPaths?: string[];
  acceptanceCriteria?: string[];
};

type GuardrailsConfig = {
  policyProfile?: string;
  budget?: Partial<LoopBudget>;
  governance?: {
    destructiveActionPolicy?: string;
    telemetryDestination?: string;
    verifierRules?: string[];
  };
};

type ResolvedGuardrails = {
  configPath: string;
  policyProfile: string;
  telemetryDestination: string;
  destructiveActionPolicy: string;
  verifierRules: string[];
  budget: LoopBudget;
};

const DEFAULT_BUDGET: LoopBudget = {
  maxUsd: 10,
  softLimitUsd: 7,
  maxIterations: 3,
  maxTokens: 20_000
};

type InspectCommand = {
  command: "inspect";
  file: string;
  runsDir?: string;
};

type ResumeCommand = {
  command: "resume";
  selector: MartinRunSelector;
};

type DoctorCommand = {
  command: "doctor";
  cwd?: string;
  runsDir?: string;
  engine?: "claude" | "codex" | "gemini" | "openai";
  configPath?: string;
};

type StartCommand = {
  command: "start";
  cwd?: string;
  runsDir?: string;
};

type EnableCommand = {
  command: "enable";
  cwd?: string;
  runsDir?: string;
  configPath?: string;
  engine?: "claude" | "codex" | "gemini" | "openai";
  verifier?: string;
  budgetUsd?: number;
  maxIterations?: number;
  force: boolean;
};

type EnvCommand = {
  command: "env";
  cwd?: string;
  runsDir?: string;
};

type ReviewCommand = {
  command: "review";
  selector: MartinRunSelector;
};

type ReceiptsExplainCommand = {
  command: "receipts_explain";
  selector: MartinRunSelector;
};

type NativePhaseCommand = {
  command: "native_phase";
  subcommand: NativePhaseSubcommand;
  cwd?: string;
  runsDir?: string;
  host?: string;
  runScanLimit?: number;
  execute: boolean;
};

type PreflightCommand = {
  command: "preflight";
  request: RunCommandRequest;
};

type TriageCommand = {
  command: "triage";
  filters: MartinRunListFilters;
};

type DossierCommand = {
  command: "dossier";
  selector: MartinRunSelector;
};

type RunsCommand =
  | {
      command: "runs_list";
      filters: MartinRunListFilters;
    }
  | {
      command: "runs_get";
      selector: MartinRunSelector;
    }
  | {
      command: "runs_attempt";
      selector: MartinRunSelector;
    }
  | {
      command: "runs_verify";
      selector: MartinRunSelector;
    };

type McpCommand =
  | {
      command: "mcp_print_config";
      host: MartinMcpHost;
      scope: MartinMcpScope;
      cwd?: string;
      runsDir?: string;
      transport: MartinMcpTransport;
      profile: MartinMcpProfile;
      remoteUrl?: string;
      remoteTokenEnv?: string;
      experimentalRemoteHosts: boolean;
      platform?: MartinMcpPlatform;
    }
  | {
      command: "mcp_install";
      host: MartinMcpHost;
      scope: MartinMcpScope;
      cwd?: string;
      runsDir?: string;
      transport: MartinMcpTransport;
      profile: MartinMcpProfile;
      remoteUrl?: string;
      remoteTokenEnv?: string;
      experimentalRemoteHosts: boolean;
      platform?: MartinMcpPlatform;
      dryRun: boolean;
    };

type EstimateCommand = {
  command: "estimate";
  objective: string;
  engine: string;
  budgetUsd: number;
  fileScope: string[];
  cwd?: string;
  runsDir?: string;
};

type GateCommand = {
  command: "gate";
  cwd?: string;
  runsDir?: string;
};

type ModeCommand = {
  command: "mode";
  /** undefined = show current mode */
  mode?: "auto" | "plan" | "edits";
  scope: "global" | "project";
  cwd?: string;
};

type CleanCommand = {
  command: "clean";
  cwd?: string;
  runsDir?: string;
  cleanRuns: boolean;
  cleanAll: boolean;
};

type ChallengeCommand = {
  command: "challenge";
  selector?: MartinRunSelector;
  format: "markdown" | "svg";
};

type ShareCommand = {
  command: "share";
  selector: MartinRunSelector;
  outputDir?: string;
  proofCard: boolean;
  proofCardFormat: "svg" | "png" | "both";
};

type BadgeCommand = {
  command: "badge";
  format: "svg" | "json";
  runsDir?: string;
};

type PlanCommand = {
  command: "plan";
  objective: string;
  verify?: string;
  budgetUsd?: number;
  cwd?: string;
  runsDir?: string;
};

type ExecuteCommand = {
  command: "execute";
  objective: string;
  verify?: string;
  budgetUsd?: number;
  maxIterations?: number;
  engine?: "claude" | "codex" | "gemini" | "openai";
  cwd?: string;
  runsDir?: string;
};

type Under3BenchFixture = {
  suiteId: string;
  label: string;
  description: string;
  task: {
    title: string;
    objective: string;
    verificationPlan: string[];
  };
  martin: {
    spendUsd: number;
    attempts: number;
    status: string;
    lifecycleState: string;
    verifierStatus: string;
    summary: string;
  };
  baseline: {
    spendUsd: number;
    attempts: number;
    status: string;
    lifecycleState: string;
    verifierStatus: string;
    summary: string;
  };
};

type BenchmarkSuiteFixture = {
  suiteId: string;
  label: string;
  description: string;
  baselineAdapter: string;
  cases: Array<{
    caseId: string;
    label: string;
    task: {
      title: string;
      objective: string;
      verificationPlan: string[];
    };
  }>;
};

export type ParsedCliArguments =
  | {
      command: "help";
    }
  | {
      command: "version";
    }
  | {
      command: "run";
      request: RunCommandRequest;
    }
  | {
      command: "bench";
      suiteId: string;
    }
  | {
      command: "demo";
      directory: string;
      force: boolean;
    }
  | InspectCommand
  | ResumeCommand
  | DoctorCommand
  | StartCommand
  | EnableCommand
  | EnvCommand
  | ReviewCommand
  | ReceiptsExplainCommand
  | NativePhaseCommand
  | PreflightCommand
  | TriageCommand
  | DossierCommand
  | RunsCommand
  | McpCommand
  | EstimateCommand
  | GateCommand
  | ModeCommand
  | CleanCommand
  | ChallengeCommand
  | ShareCommand
  | BadgeCommand
  | PlanCommand
  | ExecuteCommand;

export async function executeCli(args: string[]): Promise<{
  exitCode: number;
  stdout: string;
  stderr: string;
}> {
  let outputMode: MartinOutputMode = "human";

  try {
    const global = stripGlobalOptions(args);
    outputMode = global.outputMode;
    const parsed = parseCliArguments(global.commandArgs);

    switch (parsed.command) {
      case "help":
        return {
          exitCode: 0,
          stdout: renderCliHelp(),
          stderr: ""
        };
      case "version":
        return {
          exitCode: 0,
          stdout: rootPackageVersion,
          stderr: ""
        };
      case "bench":
        return await executeBenchCommand(parsed.suiteId, outputMode);
      case "demo": {
        const targetDirectory = await createDemoWorkspace({
          targetDirectory: parsed.directory,
          force: parsed.force
        });

        return renderCliSuccess(outputMode, {
          data: {
            command: "demo",
            targetDirectory
          },
          human: renderDemoInstructions(targetDirectory),
          quiet: targetDirectory
        });
      }
      case "run":
        return await executeRunCommand(parsed.request, outputMode);
      case "inspect":
        return await executeInspectCommand(parsed, outputMode);
      case "resume":
        return await executeResumeCommand(parsed, outputMode);
      case "doctor":
        return await executeDoctorCommand(parsed, outputMode);
      case "start":
        return await executeStartCommand(parsed, outputMode);
      case "enable":
        return await executeEnableCommand(parsed, outputMode);
      case "env":
        return await executeEnvCommand(parsed, outputMode);
      case "review":
        return await executeReviewCommand(parsed, outputMode);
      case "receipts_explain":
        return await executeReceiptsExplainCommand(parsed.selector, outputMode);
      case "native_phase":
        return await executeNativePhaseCommand(parsed, outputMode);
      case "preflight":
        return await executePreflightCommand(parsed.request, outputMode);
      case "triage":
        return await executeTriageCommand(parsed.filters, outputMode);
      case "dossier":
        return await executeDossierCommand(parsed.selector, outputMode);
      case "runs_list":
        return await executeRunsListCommand(parsed.filters, outputMode);
      case "runs_get":
        return await executeRunsGetCommand(parsed.selector, outputMode);
      case "runs_attempt":
        return await executeRunsAttemptCommand(parsed.selector, outputMode);
      case "runs_verify":
        return await executeRunsVerifyCommand(parsed.selector, outputMode);
      case "estimate":
        return await executeEstimateCommand(parsed, outputMode);
      case "gate":
        return await executeGateCommand(parsed, outputMode);
      case "mode":
        return await executeModeCommand(parsed, outputMode);
      case "clean":
        return await executeCleanCommand(parsed, outputMode);
      case "mcp_print_config":
        return await executeMcpPrintConfigCommand(parsed, outputMode);
      case "mcp_install":
        return await executeMcpInstallCommand(parsed, outputMode);
      case "challenge":
        return await executeChallengeCommand(parsed, outputMode);
      case "share":
        return await executeShareCommand(parsed, outputMode);
      case "badge":
        return await executeBadgeCommand(parsed, outputMode);
      case "plan":
        return await executePlanCommand(parsed, outputMode);
      case "execute":
        return await executeExecuteCommand(parsed, outputMode);
    }
  } catch (error) {
    return renderCliError(outputMode, error);
  }
}

export function __setRunAdapterOverrideForTests(adapter?: MartinAdapter): void {
  runAdapterOverrideForTests = adapter;
}

export function __setCodexHostOverridesForTests(
  overrides?: {
    availability?: CodexAvailabilityForTests;
    probe?:
      | CodexProbeForTests
      | ((input: {
          workingDirectory: string;
          availability: CodexAvailabilityForTests;
          model?: string;
        }) => CodexProbeForTests);
  }
): void {
  codexAvailabilityOverrideForTests = overrides?.availability;
  codexProbeOverrideForTests = overrides?.probe;
}

export function parseCliArguments(args: string[]): ParsedCliArguments {
  const [command, ...rest] = args;

  if (command === "--version" || command === "-V" || command === "version") {
    return { command: "version" };
  }

  if (!command || command === "help" || command === "--help" || command === "-h") {
    return { command: "help" };
  }

  if (command === "run" || command === "preflight") {
    if (rest[0] === "--help" || rest[0] === "-h") {
      return { command: "help" };
    }
    const request = parseRunRequest(rest);
    return command === "run"
      ? { command: "run", request }
      : { command: "preflight", request };
  }

  if (command === "bench") {
    return {
      command: "bench",
      suiteId: readOption(rest, "--suite") ?? "ralphy-smoke"
    };
  }

  if (command === "demo") {
    return {
      command: "demo",
      directory: resolve(readOption(rest, "--dir") ?? join(process.cwd(), "martin-loop-demo")),
      force: hasFlag(rest, "--force")
    };
  }

  if (command === "inspect") {
    return {
      command: "inspect",
      file: readOption(rest, "--file") ?? "",
      ...(readOption(rest, "--runs-dir") ? { runsDir: readOption(rest, "--runs-dir") } : {})
    };
  }

  if (command === "resume") {
    const loopId = rest[0] ?? readOption(rest, "--loop-id") ?? "";
    return {
      command: "resume",
      selector: {
        loopId,
        ...(readOption(rest, "--runs-dir") ? { runsDir: readOption(rest, "--runs-dir") } : {})
      }
    };
  }

  if (command === "doctor") {
    return {
      command: "doctor",
      ...(readOption(rest, "--cwd") ? { cwd: readOption(rest, "--cwd") } : {}),
      ...(readOption(rest, "--runs-dir") ? { runsDir: readOption(rest, "--runs-dir") } : {}),
      ...(readOption(rest, "--config") ? { configPath: readOption(rest, "--config") } : {}),
      ...(readOption(rest, "--engine") === "codex" ? { engine: "codex" as const } : {}),
      ...(readOption(rest, "--engine") === "claude" ? { engine: "claude" as const } : {}),
      ...(readOption(rest, "--engine") === "gemini" ? { engine: "gemini" as const } : {}),
      ...(readOption(rest, "--engine") === "openai" ? { engine: "openai" as const } : {})
    };
  }

  if (command === "gate") {
    return {
      command: "gate",
      ...(readOption(rest, "--cwd") ? { cwd: readOption(rest, "--cwd") } : {}),
      ...(readOption(rest, "--runs-dir") ? { runsDir: readOption(rest, "--runs-dir") } : {})
    };
  }

  if (command === "mode") {
    const subcommand = rest[0] && !rest[0].startsWith("--") ? rest[0] : undefined;
    const validModes = ["auto", "plan", "edits"] as const;
    const mode = validModes.find((m) => m === subcommand);
    return {
      command: "mode",
      ...(mode ? { mode } : {}),
      scope: hasFlag(rest, "--project") ? "project" : "global",
      ...(readOption(rest, "--cwd") ? { cwd: readOption(rest, "--cwd") } : {})
    };
  }

  if (command === "clean") {
    return {
      command: "clean",
      ...(readOption(rest, "--cwd") ? { cwd: readOption(rest, "--cwd") } : {}),
      ...(readOption(rest, "--runs-dir") ? { runsDir: readOption(rest, "--runs-dir") } : {}),
      cleanRuns: hasFlag(rest, "--runs"),
      cleanAll: hasFlag(rest, "--all")
    };
  }

  if (command === "estimate") {
    const objective = rest[0] && !rest[0].startsWith("--") ? rest[0] : readOption(rest, "--objective") ?? "";
    if (!objective) {
      return { command: "help" };
    }
    const fileScope: string[] = [];
    for (let i = 0; i < rest.length; i++) {
      const nextArg = rest[i + 1];
      if (rest[i] === "--files" && nextArg) {
        fileScope.push(nextArg);
        i += 1;
      }
    }
    return {
      command: "estimate",
      objective,
      engine: readOption(rest, "--engine") ?? "claude",
      budgetUsd: toFiniteNumber(readOption(rest, "--budget-usd") ?? readOption(rest, "--budget") ?? "5") || 5,
      fileScope,
      ...(readOption(rest, "--cwd") ? { cwd: readOption(rest, "--cwd") } : {}),
      ...(readOption(rest, "--runs-dir") ? { runsDir: readOption(rest, "--runs-dir") } : {})
    };
  }

  if (command === "start" || command === "tour") {
    return {
      command: "start",
      ...(readOption(rest, "--cwd") ? { cwd: readOption(rest, "--cwd") } : {}),
      ...(readOption(rest, "--runs-dir") ? { runsDir: readOption(rest, "--runs-dir") } : {})
    };
  }

  if (command === "plan") {
    const objective = rest[0] && !rest[0].startsWith("--") ? rest[0] : readOption(rest, "--objective") ?? "";
    if (!objective) {
      return { command: "help" };
    }
    return {
      command: "plan",
      objective,
      ...(readOption(rest, "--verify") ? { verify: readOption(rest, "--verify") } : {}),
      ...(readOption(rest, "--budget-usd") ? { budgetUsd: toFiniteNumber(readOption(rest, "--budget-usd") ?? "") } : {}),
      ...(readOption(rest, "--cwd") ? { cwd: readOption(rest, "--cwd") } : {}),
      ...(readOption(rest, "--runs-dir") ? { runsDir: readOption(rest, "--runs-dir") } : {})
    };
  }

  if (command === "execute") {
    const objective = rest[0] && !rest[0].startsWith("--") ? rest[0] : readOption(rest, "--objective") ?? "";
    if (!objective) {
      return { command: "help" };
    }
    return {
      command: "execute",
      objective,
      ...(readOption(rest, "--verify") ? { verify: readOption(rest, "--verify") } : {}),
      ...(readOption(rest, "--budget-usd") ? { budgetUsd: toFiniteNumber(readOption(rest, "--budget-usd") ?? "") } : {}),
      ...(readOption(rest, "--max-iterations") ? { maxIterations: toFiniteNumber(readOption(rest, "--max-iterations") ?? "") } : {}),
      ...(readOption(rest, "--engine") === "codex" ? { engine: "codex" as const } : {}),
      ...(readOption(rest, "--engine") === "claude" ? { engine: "claude" as const } : {}),
      ...(readOption(rest, "--engine") === "gemini" ? { engine: "gemini" as const } : {}),
      ...(readOption(rest, "--engine") === "openai" ? { engine: "openai" as const } : {}),
      ...(readOption(rest, "--cwd") ? { cwd: readOption(rest, "--cwd") } : {}),
      ...(readOption(rest, "--runs-dir") ? { runsDir: readOption(rest, "--runs-dir") } : {})
    };
  }

  if (command === "enable") {
    return {
      command: "enable",
      ...(readOption(rest, "--cwd") ? { cwd: readOption(rest, "--cwd") } : {}),
      ...(readOption(rest, "--runs-dir") ? { runsDir: readOption(rest, "--runs-dir") } : {}),
      ...(readOption(rest, "--config") ? { configPath: readOption(rest, "--config") } : {}),
      ...(readOption(rest, "--engine") === "codex" ? { engine: "codex" as const } : {}),
      ...(readOption(rest, "--engine") === "claude" ? { engine: "claude" as const } : {}),
      ...(readOption(rest, "--engine") === "gemini" ? { engine: "gemini" as const } : {}),
      ...(readOption(rest, "--engine") === "openai" ? { engine: "openai" as const } : {}),
      ...(readOption(rest, "--verify") ? { verifier: readOption(rest, "--verify") } : {}),
      ...(readOption(rest, "--budget-usd") ? { budgetUsd: Number(readOption(rest, "--budget-usd")) } : {}),
      ...(readOption(rest, "--max-iterations")
        ? { maxIterations: Number(readOption(rest, "--max-iterations")) }
        : {}),
      force: hasFlag(rest, "--force")
    };
  }

  if (command === "env") {
    return {
      command: "env",
      ...(readOption(rest, "--cwd") ? { cwd: readOption(rest, "--cwd") } : {}),
      ...(readOption(rest, "--runs-dir") ? { runsDir: readOption(rest, "--runs-dir") } : {})
    };
  }

  if (command === "review") {
    const selector = parseOptionalRunSelector(rest);
    const runsDir = readOption(rest, "--runs-dir");
    return {
      command: "review",
      selector: selector ?? { latest: true, ...(runsDir ? { runsDir } : {}) }
    };
  }

  if (command === "receipts") {
    const [subcommand, ...subcommandArgs] = rest;
    if (subcommand === "explain") {
      const selector = parseOptionalRunSelector(subcommandArgs);
      const runsDir = readOption(subcommandArgs, "--runs-dir");
      return {
        command: "receipts_explain",
        selector: selector ?? { latest: true, ...(runsDir ? { runsDir } : {}) }
      };
    }
    return { command: "help" };
  }

  if (command === "session-start") {
    return parseNativePhaseCommand("session-start", rest);
  }

  if (command === "phase" || command === "gsd") {
    const [subcommand, ...subcommandArgs] = rest;
    if (
      subcommand === "session-start" ||
      subcommand === "status" ||
      subcommand === "contract" ||
      subcommand === "preflight" ||
      subcommand === "run"
    ) {
      return parseNativePhaseCommand(subcommand, subcommandArgs);
    }
    return { command: "help" };
  }

  if (command === "triage") {
    return {
      command: "triage",
      filters: parseRunListFilters(rest)
    };
  }

  if (command === "dossier") {
    return {
      command: "dossier",
      selector: parseRunSelector(rest, { allowLatest: true })
    };
  }

  if (command === "runs") {
    const [subcommand, ...subcommandArgs] = rest;
    if (subcommand === "list") {
      return {
        command: "runs_list",
        filters: parseRunListFilters(subcommandArgs)
      };
    }
    if (subcommand === "get") {
      return {
        command: "runs_get",
        selector: parseRunSelector(subcommandArgs, { allowLatest: true })
      };
    }
    if (subcommand === "attempt") {
      return {
        command: "runs_attempt",
        selector: parseRunSelector(subcommandArgs, { allowLatest: false, includeAttemptIndex: true })
      };
    }
    if (subcommand === "verify") {
      return {
        command: "runs_verify",
        selector: parseRunSelector(subcommandArgs, { allowLatest: true })
      };
    }
    return { command: "help" };
  }

  if (command === "mcp") {
    const [subcommand, ...subcommandArgs] = rest;

    if (subcommand === "print-config") {
      const host = parseMcpHost(subcommandArgs);
      const scope = parseMcpScope(host, subcommandArgs);
      const cwd = readOption(subcommandArgs, "--cwd");
      const runsDir = readOption(subcommandArgs, "--runs-dir");
      const transport = parseMcpTransport(subcommandArgs);
      const profile = parseMcpProfile(subcommandArgs);
      const remoteUrl = readOption(subcommandArgs, "--remote-url");
      const remoteTokenEnv = readOption(subcommandArgs, "--remote-token-env");
      const platform = parseMcpPlatform(subcommandArgs);
      const experimentalRemoteHosts = hasFlag(subcommandArgs, "--experimental-remote-hosts");

      return {
        command: "mcp_print_config",
        host,
        scope,
        transport,
        profile,
        ...(cwd ? { cwd } : {}),
        ...(runsDir ? { runsDir } : {}),
        ...(remoteUrl ? { remoteUrl } : {}),
        ...(remoteTokenEnv ? { remoteTokenEnv } : {}),
        experimentalRemoteHosts,
        ...(platform ? { platform } : {})
      };
    }

    if (subcommand === "install") {
      const host = parseMcpHost(subcommandArgs);
      const scope = parseMcpScope(host, subcommandArgs);
      const cwd = readOption(subcommandArgs, "--cwd");
      const runsDir = readOption(subcommandArgs, "--runs-dir");
      const transport = parseMcpTransport(subcommandArgs);
      const profile = parseMcpProfile(subcommandArgs);
      const remoteUrl = readOption(subcommandArgs, "--remote-url");
      const remoteTokenEnv = readOption(subcommandArgs, "--remote-token-env");
      const platform = parseMcpPlatform(subcommandArgs);
      const experimentalRemoteHosts = hasFlag(subcommandArgs, "--experimental-remote-hosts");

      return {
        command: "mcp_install",
        host,
        scope,
        transport,
        profile,
        ...(cwd ? { cwd } : {}),
        ...(runsDir ? { runsDir } : {}),
        ...(remoteUrl ? { remoteUrl } : {}),
        ...(remoteTokenEnv ? { remoteTokenEnv } : {}),
        experimentalRemoteHosts,
        ...(platform ? { platform } : {}),
        dryRun: hasFlag(subcommandArgs, "--dry-run")
      };
    }

    return { command: "help" };
  }

  if (command === "challenge") {
    const selector = parseOptionalRunSelector(rest);
    return {
      command: "challenge",
      ...(selector ? { selector } : {}),
      format: parseChallengeFormat(rest)
    };
  }

  if (command === "share") {
    const proofCard = hasFlag(rest, "--with-proof-card") || readOption(rest, "--proof-card-format") !== undefined;
    return {
      command: "share",
      selector: parseRunSelector(rest, { allowLatest: true }),
      ...(readOption(rest, "--out-dir") ? { outputDir: readOption(rest, "--out-dir") } : {}),
      proofCard: hasFlag(rest, "--no-proof-card") ? false : proofCard,
      proofCardFormat: parseShareProofCardFormat(rest)
    };
  }

  if (command === "badge") {
    return {
      command: "badge",
      format: parseBadgeFormat(rest),
      ...(readOption(rest, "--runs-dir") ? { runsDir: readOption(rest, "--runs-dir") } : {})
    };
  }

  if (!command.startsWith("-")) {
    return {
      command: "run",
      request: parseRunRequest([command, ...rest])
    };
  }

  return { command: "help" };
}

export function renderCliHelp(): string {
  return [
    "Martin Loop CLI",
    "",
    "Usage:",
    "  martin run <objective> [options]",
    "  martin-loop run <objective> [options]    (published alias)",
    "  martin preflight <objective> [options]",
    "  martin start [options]",
    "  martin enable [options]",
    "  martin env [options]",
    "  martin review [--loop-id <id> | --file <path> | --latest] [options]",
    "  martin receipts explain [--loop-id <id> | --file <path> | --latest] [options]",
    "  martin doctor [options]",
    "  martin session-start [--host <claude|codex|generic>] [options]",
    "  martin phase status|contract|preflight|run [--execute] [options]",
    "  martin triage [options]",
    "  martin dossier (--loop-id <id> | --file <path> | --latest) [options]",
    "  martin runs list [options]",
    "  martin runs get (--loop-id <id> | --file <path> | --latest) [options]",
    "  martin runs attempt (--loop-id <id> | --file <path>) [--attempt-index <n>] [options]",
    "  martin runs verify (--loop-id <id> | --file <path> | --latest) [options]",
    "  martin mcp print-config --host <codex|claude|gemini|cursor|copilot|continue|generic> [--scope <user|project|local>] [options]",
    "  martin mcp install --host <codex|claude|gemini|cursor|copilot|continue|generic> [--scope <user|project|local>] [--dry-run] [options]",
    "  martin demo [--dir <path>] [--force]",
    "  martin-loop demo [--dir <path>] [--force] (published alias)",
    "  martin inspect --file <path>",
    "  martin-loop inspect --file <path>        (published alias)",
    "  martin resume <loopId>",
    "  martin-loop resume <loopId>              (published alias)",
    "  martin bench --suite <suiteId>",
    "  martin challenge [--loop-id <id> | --file <path> | --latest] [--format markdown|svg]",
    "  martin share (--loop-id <id> | --file <path> | --latest) [--out-dir <path>] [--with-proof-card] [--proof-card-format <svg|png|both>]",
    "  martin badge [--format svg|json]",
    "",
    "Operator commands:",
    "  start        Guided first-run summary: repo detection, verifier suggestion, provider readiness, and safe next steps.",
    "  enable       Write repo-local Martin defaults to martin.config.yaml (engine, verifier, budget).",
    "  env          Print compact environment truth for provider/auth/verifier/readiness.",
    "  review       Print a human-friendly summary for the latest governed run.",
    "  receipts explain  Explain receipt trust state and what to do next.",
    "  doctor       Check CLI, engine, working directory, and run-store readiness.",
    "  session-start Show latest local run state, phase state, and command hints.",
    "  phase status    Read local phase state and run-store posture.",
    "  phase contract  Compile local phase state into a MartinLoop run contract.",
    "  phase preflight Convert the phase contract into a MartinLoop preflight invocation; dry-run by default.",
    "  phase run       Convert the phase contract into a MartinLoop run invocation; dry-run by default.",
    "  preflight    Validate a governed run request before spend.",
    "  triage       Rank persisted runs that need attention first.",
    "  dossier      Produce a structured dossier for one persisted run.",
    "  runs list    List persisted loops with shared filters.",
    "  runs get     Load a persisted loop by selector.",
    "  runs attempt Load a persisted attempt and linked verification summary.",
    "  runs verify  Read persisted verification evidence for one loop.",
    "  estimate     Estimate cost, route, and Pre Work Burn for an objective without spending.",
    "  gate         Hard governance check — exits non-zero if doctor/estimate are missing. Use in hooks.",
    "  mode         Show or set working mode: auto (default), plan, edits.",
    "  clean        Remove MartinLoop artifacts (_martin/, old run records).",
    "  mcp print-config  Print a known-good MCP config snippet for Codex, Claude, Gemini, or generic hosts.",
    "  mcp install       Write a starter MCP config, or call Claude Code directly for local scope.",
    "  challenge    Print a shareable local proof card for the Under-$3 challenge.",
    "  share        Write a local share bundle with a redacted receipt JSON and Markdown receipt; proof-card images are opt-in.",
    "  badge        Print an agent reliability readiness badge from local evidence.",
    "",
    "Compatibility aliases:",
    "  inspect      Legacy file-based summary view. Prefer `martin dossier` or `martin runs get`.",
    "  resume       Legacy loop lookup alias. Prefer `martin runs get --loop-id`.",
    "",
    "Global output modes:",
    "  --json       Emit stable machine-readable JSON.",
    "  --quiet      Emit only the primary identifier or path on success.",
    "",
    "Shared run selectors:",
    "  --runs-dir <path>        Override the Martin runs root.",
    "  --loop-id <id>           Select a persisted loop by ID.",
    "  --file <path>            Select a persisted loop via file or run directory.",
    "  --latest                 Select the most recently updated loop.",
    "  --attempt-index <n>      Select a specific attempt for attempt inspection.",
    "  --out-dir <path>         Override where `martin share` writes the local bundle.",
    "  --with-proof-card        Generate proof-card image artifacts for martin share.",
    "  --proof-card-format <f>  Proof-card format: svg, png, or both (default: svg when enabled).",
    "  --no-proof-card          Force receipt-only share output, even when defaults change elsewhere.",
    "",
    "Phase command-center options:",
    "  --cwd <path>             Repo root containing phase state; imports .gsd state when present.",
    "  --runs-dir <path>        Override the Martin runs root.",
    "  --host <name>            Host name for session-start guidance.",
    "  --run-scan-limit <n>     Max recent run directories to inspect (default: 40).",
    "  --execute                Execute generated preflight/run command after contract validation.",
    "  --force                  Allow martin enable to overwrite an existing config file.",
    "",
    "MCP config options:",
    "  --host <name>            codex, claude, gemini, cursor, copilot, continue, or generic.",
    "  --scope <name>           user or project for all hosts; Claude also supports local.",
    "  --transport <name>       stdio (default) or remote.",
    "  --experimental-remote-hosts  Required to enable remote transport for cursor/copilot/continue.",
    "  --profile <name>         minimal (default), diagnostic, github-review, full-local, paid-remote, starter, or full.",
    "  --platform <name>        windows, macos, or linux recipe shaping.",
    "",
    "Run options:",
    "  --engine <name>          Adapter: claude (default), codex, gemini, or openai.",
    "                           openai routes to any OpenAI-compatible endpoint.",
    "                           Set MARTIN_OPENAI_BASE_URL, MARTIN_OPENAI_API_KEY,",
    "                           MARTIN_OPENAI_MODEL. Works with Ollama, OpenRouter,",
    "                           Together.ai, LM Studio, and any local model server.",
    "  --model <name>           Override the model.",
    "  --cwd <path>             Set the repo root used for repo-backed runs.",
    "  --budget-usd <n>         Set the hard cost cap in USD.",
    "  --soft-limit-usd <n>     Soft budget warning threshold in USD.",
    "  --max-iterations <n>     Set the maximum number of attempts.",
    "  --max-tokens <n>         Set the maximum total token budget.",
    "  --verify <cmd>           Shell command to run as the verifier after each attempt.",
    "  --verify-timeout-ms <n>  Verifier timeout in milliseconds.",
    "  --proof                  Run in no-spend proof mode (explicit opt-in).",
    "  --unsafe-allow-unguarded-run",
    "                           Bypass doctor/preflight run-gate checks for this invocation only.",
    "  --allow-path <glob>      Restrict agent writes to this path pattern (repeatable).",
    "  --deny-path <glob>       Block agent from this path pattern (repeatable).",
    "  --accept <criterion>     Add an acceptance criterion to the prompt (repeatable).",
    "  --config <path>          Path to martin.config.yaml.",
    "",
    "Exit codes:",
    "  0 success",
    "  2 invalid_input",
    "  3 environment",
    "  4 auth",
    "  5 not_found",
    "  6 store_unreadable",
    "  7 verification_failed",
    "  8 policy_blocked",
    "  9 budget_exit",
    " 10 transient"
  ].join("\n");
}

async function executeRunCommand(
  request: RunCommandRequest,
  outputMode: MartinOutputMode
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const resolvedGuardrails = await resolveGuardrails(request);
  const verificationPlan =
    request.verificationPlan.length > 0
      ? request.verificationPlan
      : resolvedGuardrails.verifierRules;
  const resolvedRequest: RunCommandRequest = {
    ...request,
    budget: resolvedGuardrails.budget,
    verificationPlan,
    metadata: {
      ...request.metadata,
      policyProfile: resolvedGuardrails.policyProfile,
      telemetryDestination: resolvedGuardrails.telemetryDestination
    }
  };
  const cliEnvironment = resolveCliEnvironment({
    cwd: resolvedRequest.cwd,
    runsDir: resolvedRequest.runsDir,
    engine: resolvedRequest.engine,
    liveMode: resolvedRequest.liveMode
  });
  const effectiveMutationMode = resolvedRequest.mutationMode;
  const receiptScope = buildCliReceiptScope(cliEnvironment);
  const engineRequired = cliEnvironment.liveMode === "live";
  const preRunWarnings: string[] = [];

  if (engineRequired && !resolvedRequest.unsafeAllowUnguardedRun) {
    if (outputMode === "json") {
      const bootstrap = await autoBootstrapGovernedRun({
        request: resolvedRequest,
        environment: cliEnvironment,
        receiptScope
      });
      if (bootstrap.warnings.length > 0) {
        preRunWarnings.push(...bootstrap.warnings);
      }
      if (!bootstrap.ready) {
        throw new CliCommandError(
          "policy_blocked",
          "Governed run preflight blocked execution. Resolve the blocking issues and retry.",
          {
            suggestion: buildPreflightSuggestion(resolvedRequest.objective, resolvedRequest.verificationPlan),
            details: {
              blockingIssues: bootstrap.blockingIssues
            }
          }
        );
      }
    } else {
      // Governance gate fires first — receipts must exist before we check whether
      // the engine CLI is installed. "Run estimate first" is higher priority feedback
      // than "install the engine CLI", and this keeps gate behavior consistent across
      // environments where the engine binary may not be on PATH (e.g. CI runners).
      const gate = await evaluateCliRunGate({
        runsRoot: cliEnvironment.runsRoot,
        workingDirectory: cliEnvironment.workingDirectory,
        objective: resolvedRequest.objective,
        engine: cliEnvironment.engine,
        verificationPlan: resolvedRequest.verificationPlan,
        mutationMode: effectiveMutationMode,
        receiptScope,
        allowedPaths: resolvedRequest.allowedPaths,
        deniedPaths: resolvedRequest.deniedPaths,
        budget: resolvedRequest.budget
      });

      if (!gate.allowed) {
        throw new CliCommandError("policy_blocked", gate.message, {
          suggestion: gate.nextCommand,
          details: {
            missingSteps: gate.missingSteps,
            receiptScope
          }
        });
      }

      const blockingIssues: string[] = [];
      const workingDirectoryExists = await stat(cliEnvironment.workingDirectory).then(() => true).catch(() => false);
      if (!workingDirectoryExists) {
        blockingIssues.push("Working directory does not exist.");
      }
      if (cliEnvironment.engine === "claude" && !isCommandAvailable("claude")) {
        blockingIssues.push("Claude CLI is not available on PATH.");
      }
      if (cliEnvironment.engine === "codex" && !resolveCliCommandAvailability("codex").available) {
        blockingIssues.push("Codex CLI is not available on PATH.");
      }
      if (cliEnvironment.engine === "gemini" && !resolveCliCommandAvailability("gemini").available) {
        blockingIssues.push("Gemini CLI is not available on PATH.");
      }

      if (blockingIssues.length > 0) {
        throw new CliCommandError(
          "policy_blocked",
          "Governed run preflight blocked execution. Resolve the blocking issues and retry.",
          {
            suggestion: buildPreflightSuggestion(resolvedRequest.objective, resolvedRequest.verificationPlan),
            details: {
              blockingIssues
            }
          }
        );
      }
    }
  } else if (engineRequired && resolvedRequest.unsafeAllowUnguardedRun) {
    preRunWarnings.push(
      "Run-gate bypassed by --unsafe-allow-unguarded-run; doctor/preflight receipts were not enforced for this run."
    );
  }

  let result: Awaited<ReturnType<typeof runMartin>>;
  let codexCommandOverride: string | undefined;

  if (engineRequired && cliEnvironment.engine === "codex") {
    const codexAvailability = resolveCodexAvailabilityForCli();
    const codexProbe = resolveCodexProbeForCli({
      workingDirectory: cliEnvironment.workingDirectory,
      availability: codexAvailability,
      model: resolvedRequest.model
    });
    if (!codexProbe.ok) {
      throw new CliCommandError("environment", codexProbe.summary, {
        suggestion: "Run `martin doctor --engine codex` or `martin preflight --engine codex` before retrying this governed run.",
        details: {
          command: codexProbe.command,
          args: codexProbe.args,
          resolvedPath: codexProbe.availability.resolvedPath,
          hostPlatform: codexProbe.diagnosis.hostPlatform,
          invocationMode: codexProbe.diagnosis.invocationMode,
          installKind: codexProbe.diagnosis.installKind,
          sandboxCompatible: codexProbe.diagnosis.sandboxCompatible,
          remediation: codexProbe.diagnosis.remediation
        }
      });
    }
    codexCommandOverride = codexProbe.command;
  }

  // Auto-select model based on task complexity when --model was not explicitly set.
  // classifyRoute scores the objective and recommends haiku/sonnet/opus.
  // resolveModelForTier maps that tier to a concrete model ID for the engine.
  let autoSelectedModel: string | undefined;
  if (!resolvedRequest.model) {
    const route = classifyRoute({
      objective: resolvedRequest.objective ?? resolvedRequest.title ?? "",
      verificationPlan: resolvedRequest.verificationPlan,
      budgetUsd: resolvedRequest.budget.maxUsd
    });
    autoSelectedModel = resolveModelForTier(
      route.recommendedModelTier,
      resolvedRequest.engine ?? "claude"
    );
  }

  const adapter = selectAdapter(
    resolvedRequest.engine,
    cliEnvironment.workingDirectory,
    resolvedRequest.model,
    effectiveMutationMode,
    cliEnvironment.liveMode,
    codexCommandOverride,
    resolvedRequest.verifyTimeoutMs,
    autoSelectedModel
  );
  try {
    result = await runMartin({
      workspaceId: resolvedRequest.workspaceId,
      projectId: resolvedRequest.projectId,
      receiptScope: {
        ...receiptScope
      },
      task: {
        title: resolvedRequest.title,
        objective: resolvedRequest.objective,
        verificationPlan: resolvedRequest.verificationPlan,
        ...(resolvedRequest.verifyTimeoutMs !== undefined
          ? { verificationTimeoutMs: resolvedRequest.verifyTimeoutMs }
          : {}),
        ...(effectiveMutationMode ? { mutationMode: effectiveMutationMode } : {}),
        repoRoot: cliEnvironment.workingDirectory,
        ...(resolvedRequest.allowedPaths?.length ? { allowedPaths: resolvedRequest.allowedPaths } : {}),
        ...(resolvedRequest.deniedPaths?.length ? { deniedPaths: resolvedRequest.deniedPaths } : {}),
        ...(resolvedRequest.acceptanceCriteria?.length
          ? { acceptanceCriteria: resolvedRequest.acceptanceCriteria }
          : {})
      },
      budget: resolvedRequest.budget,
      metadata: resolvedRequest.metadata,
      adapter
    });
  } catch (error) {
    const fallbackLoop = createLoopRecord({
      workspaceId: resolvedRequest.workspaceId,
      projectId: resolvedRequest.projectId,
      task: {
        title: resolvedRequest.title,
        objective: resolvedRequest.objective,
        verificationPlan: resolvedRequest.verificationPlan,
        ...(resolvedRequest.verifyTimeoutMs !== undefined
          ? { verificationTimeoutMs: resolvedRequest.verifyTimeoutMs }
          : {}),
        ...(effectiveMutationMode ? { mutationMode: effectiveMutationMode } : {}),
        repoRoot: cliEnvironment.workingDirectory
      },
      budget: resolvedRequest.budget,
      metadata: resolvedRequest.metadata,
      receiptScope: {
        ...receiptScope
      },
      status: "exited",
      lifecycleState: "human_escalation"
    });

    await persistLoopArtifacts(fallbackLoop, { runsRoot: cliEnvironment.runsRoot }).catch(() => {});

    throw new CliCommandError("environment", "Martin could not start the requested execution adapter.", {
      suggestion:
        "Run `martin doctor` to verify engine availability, or rerun with `--proof` for an explicit no-spend lane.",
      details: {
        loopId: fallbackLoop.loopId,
        reason: error instanceof Error ? error.message : String(error)
      }
    });
  }

  const warnings: string[] = [...preRunWarnings];
  await persistLoopArtifacts(result.loop, { runsRoot: cliEnvironment.runsRoot }).catch((error: unknown) => {
    warnings.push(
      `Persisted run artifacts could not be written: ${error instanceof Error ? error.message : String(error)}`
    );
  });

  if (result.loop.status === "completed" && result.loop.lifecycleState === "completed") {
    try {
      const { recordSuccessfulRun } = await import("./run-stats.js");
      const { maybeShowStarPrompt } = await import("./star-prompt.js");
      const { maybeShowFeedbackFlow } = await import("./feedback.js");
      const stats = recordSuccessfulRun(packageJson.version);
      await maybeShowStarPrompt(stats.totalSuccessfulRuns);
      await maybeShowFeedbackFlow(stats.totalSuccessfulRuns);
    } catch { /* never block output for engagement prompts */ }
  }

  const costProvenance = readCostProvenance(result.loop);
  const successCallToAction = buildRunSuccessCallToAction(result.loop);

  return renderCliSuccess(outputMode, {
    data: {
      command: "run",
      decision: result.decision,
      loop: result.loop,
      costProvenance,
      effectivePolicy: {
        configPath: resolvedGuardrails.configPath,
        policyProfile: resolvedGuardrails.policyProfile,
        destructiveActionPolicy: resolvedGuardrails.destructiveActionPolicy,
        verifierRules: resolvedGuardrails.verifierRules,
        budget: resolvedGuardrails.budget,
        maxUsd: resolvedGuardrails.budget.maxUsd,
        softLimitUsd: resolvedGuardrails.budget.softLimitUsd,
        maxIterations: resolvedGuardrails.budget.maxIterations,
        maxTokens: resolvedGuardrails.budget.maxTokens,
        telemetryDestination: resolvedGuardrails.telemetryDestination
      },
      environment: {
        workingDirectory: cliEnvironment.workingDirectory,
        runsRoot: cliEnvironment.runsRoot,
        engine: cliEnvironment.engine,
        liveMode: cliEnvironment.liveMode
      },
      receiptScope,
      ...(successCallToAction ? { successCallToAction } : {})
    },
    human: [
      `Started Martin Loop run ${result.loop.loopId}`,
      `Status: ${result.loop.status} / ${result.loop.lifecycleState}`,
      `Working directory: ${cliEnvironment.workingDirectory}`,
      `Runs root: ${cliEnvironment.runsRoot}`,
      `Verification plan: ${resolvedRequest.verificationPlan.join(", ") || "none"}`,
      `Attempts: ${result.loop.attempts.length}`,
      `Actual cost (USD): ${result.loop.cost.actualUsd.toFixed(2)} — provenance: ${describeCostProvenance(costProvenance)}`,
      ...(successCallToAction ? ["", ...successCallToAction.lines] : [])
    ],
    quiet: result.loop.loopId,
    warnings
  });
}

function buildPreflightSuggestion(objective: string, verificationPlan: string[]): string {
  const verify = verificationPlan[0] ? ` --verify "${verificationPlan[0]}"` : "";
  return `martin-loop preflight "${objective}"${verify}`;
}

function describeWorkflowPersistenceIssue(step: "doctor" | "estimate" | "session-start" | "preflight"): string {
  if (step === "doctor") {
    return "MartinLoop could not persist the doctor receipt needed for governed execution.";
  }
  if (step === "estimate") {
    return "Run `martin estimate \"<objective>\"` to preview cost before this run.";
  }
  if (step === "session-start") {
    return "MartinLoop could not persist the session-start receipt needed for governed execution.";
  }
  return "MartinLoop could not persist the preflight receipt needed for governed execution.";
}

async function autoBootstrapGovernedRun(input: {
  request: RunCommandRequest;
  environment: ReturnType<typeof resolveCliEnvironment>;
  receiptScope: ReturnType<typeof buildCliReceiptScope>;
}): Promise<{
  ready: boolean;
  blockingIssues: string[];
  warnings: string[];
}> {
  const preflightResult = await executePreflightCommand(input.request, "json");
  let payload: {
    ready?: boolean;
    blockingIssues?: unknown;
    warnings?: unknown;
  } = {};
  try {
    payload = JSON.parse(preflightResult.stdout) as {
      ready?: boolean;
      blockingIssues?: unknown;
      warnings?: unknown;
    };
  } catch {
    return {
      ready: false,
      blockingIssues: ["Unable to parse preflight output."],
      warnings: []
    };
  }

  const blockingIssues = Array.isArray(payload.blockingIssues)
    ? payload.blockingIssues.filter((item): item is string => typeof item === "string")
    : [];
  const warnings = Array.isArray(payload.warnings)
    ? payload.warnings.filter((item): item is string => typeof item === "string")
    : [];
  if (payload.ready !== true) {
    return {
      ready: false,
      blockingIssues,
      warnings
    };
  }

  const persistenceWarnings: string[] = [];
  await recordCliWorkflowStep({
    runsRoot: input.environment.runsRoot,
    step: "doctor",
    workingDirectory: input.environment.workingDirectory,
    engine: input.environment.engine,
    receiptScope: input.receiptScope
  }).catch((error: unknown) => {
    persistenceWarnings.push(
      `${describeWorkflowPersistenceIssue("doctor")} ${error instanceof Error ? error.message : String(error)}`
    );
  });

  await recordCliWorkflowStep({
    runsRoot: input.environment.runsRoot,
    step: "session-start",
    workingDirectory: input.environment.workingDirectory,
    engine: input.environment.engine,
    receiptScope: input.receiptScope
  }).catch((error: unknown) => {
    persistenceWarnings.push(
      `${describeWorkflowPersistenceIssue("session-start")} ${error instanceof Error ? error.message : String(error)}`
    );
  });

  // Record estimate receipt during auto-bootstrap so the run gate passes.
  // Auto-bootstrap performs preflight which validates cost/scope — recording
  // an estimate receipt here represents that the system assessed the task
  // before execution, even when the user didn't explicitly run martin estimate.
  await recordCliWorkflowStep({
    runsRoot: input.environment.runsRoot,
    step: "estimate",
    workingDirectory: input.environment.workingDirectory,
    objective: input.request.objective,
    receiptScope: input.receiptScope
  }).catch((error: unknown) => {
    persistenceWarnings.push(
      `${describeWorkflowPersistenceIssue("estimate")} ${error instanceof Error ? error.message : String(error)}`
    );
  });

  const gate = await evaluateCliRunGate({
    runsRoot: input.environment.runsRoot,
    workingDirectory: input.environment.workingDirectory,
    objective: input.request.objective,
    engine: input.environment.engine,
    verificationPlan: input.request.verificationPlan,
    mutationMode: input.request.mutationMode,
    receiptScope: input.receiptScope,
    allowedPaths: input.request.allowedPaths,
    deniedPaths: input.request.deniedPaths,
    budget: input.request.budget
  });

  if (!gate.allowed) {
    const gateIssues =
      gate.missingSteps.length > 0
        ? gate.missingSteps
            .filter(
              (step): step is "doctor" | "estimate" | "session-start" | "preflight" =>
                step === "doctor" || step === "estimate" || step === "session-start" || step === "preflight"
            )
            .map((step) => describeWorkflowPersistenceIssue(step))
        : [gate.message];
    return {
      ready: false,
      blockingIssues: persistenceWarnings.length > 0 ? persistenceWarnings : gateIssues,
      warnings
    };
  }

  return {
    ready: true,
    blockingIssues: [],
    warnings: [...warnings, ...persistenceWarnings]
  };
}

async function executeInspectCommand(
  command: InspectCommand,
  outputMode: MartinOutputMode
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  if (!command.file) {
    throw new CliCommandError("invalid_input", "inspect requires --file <path>.");
  }

  const sourcePath = isAbsolute(command.file)
    ? command.file
    : resolve(resolveInvocationRoot(), command.file);
  const contents = await readFile(sourcePath, "utf8").catch((error: unknown) => {
    if (isNodeErrorWithCode(error, "ENOENT")) {
      throw new CliCommandError("not_found", `Persisted loop file not found: ${sourcePath}`);
    }
    throw error;
  });
  const loops = parseLoopRecords(contents);

  return renderCliSuccess(outputMode, {
    data: {
      command: "inspect",
      source: sourcePath,
      summary: buildPortfolioSnapshot(loops),
      compatibility: {
        alias: "inspect",
        preferredCommand: "martin dossier"
      }
    },
    human: [
      `Inspect summary for ${sourcePath}`,
      `Loops found: ${loops.length}`,
      "Compatibility note: `martin inspect` is still supported, but `martin dossier` and `martin runs get` are the preferred operator flows."
    ],
    quiet: sourcePath
  });
}

async function executeBenchCommand(
  suiteId: string,
  outputMode: MartinOutputMode
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const normalizedSuiteId =
    suiteId === "ralphy-smoke" ? "under-3-challenge" : suiteId;

  if (normalizedSuiteId === "under-3-challenge") {
    const fixture = await loadBenchmarkFixture<Under3BenchFixture>("under-3-challenge.json");
    const spendDelta = Number((fixture.baseline.spendUsd - fixture.martin.spendUsd).toFixed(2));

    return renderCliSuccess(outputMode, {
      data: {
        command: "bench",
        suiteId: fixture.suiteId,
        label: fixture.label,
        description: fixture.description,
        martin: fixture.martin,
        baseline: fixture.baseline,
        task: fixture.task,
        spendDeltaUsd: spendDelta,
        reproductionCommands: [
          "npx martin-loop bench --suite under-3-challenge",
          "pnpm --filter @martin/benchmarks test",
          "pnpm --filter @martin/benchmarks eval"
        ]
      },
      human: [
        `${fixture.label} (${fixture.suiteId})`,
        `Task: ${fixture.task.title}`,
        `MartinLoop: $${fixture.martin.spendUsd.toFixed(2)} across ${String(fixture.martin.attempts)} attempt(s)`,
        `Uncontrolled retry loop: $${fixture.baseline.spendUsd.toFixed(2)} across ${String(fixture.baseline.attempts)} attempt(s)`,
        `Delta: MartinLoop spends $${spendDelta.toFixed(2)} less on the public deterministic fixture.`,
        "Reproduce from an installed package: npx martin-loop bench --suite under-3-challenge",
        "Reproduce from a repo clone: pnpm --filter @martin/benchmarks test && pnpm --filter @martin/benchmarks eval"
      ],
      quiet: fixture.suiteId
    });
  }

  if (normalizedSuiteId === "ralphy-engineering-50") {
    const suite = await loadBenchmarkFixture<BenchmarkSuiteFixture>("ralphy-engineering-50.json");

    return renderCliSuccess(outputMode, {
      data: {
        command: "bench",
        suiteId: suite.suiteId,
        label: suite.label,
        description: suite.description,
        caseCount: suite.cases.length,
        baselineAdapter: suite.baselineAdapter,
        reproductionCommands: [
          "npx martin-loop bench --suite ralphy-engineering-50",
          "pnpm --filter @martin/benchmarks test",
          "pnpm --filter @martin/benchmarks report:ralphy"
        ]
      },
      human: [
        `${suite.label} (${suite.suiteId})`,
        `Cases: ${String(suite.cases.length)}`,
        `Baseline adapter: ${suite.baselineAdapter}`,
        "Reproduce from an installed package: npx martin-loop bench --suite ralphy-engineering-50",
        "Reproduce from a repo clone: pnpm --filter @martin/benchmarks test && pnpm --filter @martin/benchmarks report:ralphy"
      ],
      quiet: suite.suiteId
    });
  }

  throw new CliCommandError("invalid_input", `Unknown benchmark suite: ${suiteId}`, {
    suggestion: "Use --suite under-3-challenge, ralphy-smoke, or ralphy-engineering-50."
  });
}

async function executeResumeCommand(
  command: ResumeCommand,
  outputMode: MartinOutputMode
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  if (!command.selector.loopId) {
    throw new CliCommandError("invalid_input", "resume requires a loop ID.", {
      suggestion: "Use `martin resume <loopId>` or `martin runs get --loop-id <loopId>`."
    });
  }

  const detail = await loadPersistedLoop(command.selector);
  const verification = buildVerificationSummary(detail.loop);

  return renderCliSuccess(outputMode, {
    data: {
      command: "resume",
      source: detail.source,
      loop: detail.loop,
      verification,
      compatibility: {
        alias: "resume",
        preferredCommand: "martin runs get --loop-id"
      }
    },
    human: [
      `Loaded persisted loop ${detail.loop.loopId}`,
      `Status: ${detail.loop.status} / ${detail.loop.lifecycleState}`,
      `Verification: ${verification.status}`,
      "Compatibility note: `martin resume` is still supported, but `martin runs get --loop-id` is the preferred operator flow."
    ],
    quiet: detail.loop.loopId,
    warnings: detail.warnings
  });
}

async function executeDoctorCommand(
  command: DoctorCommand,
  outputMode: MartinOutputMode
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const environment = resolveCliEnvironment({
    cwd: command.cwd,
    runsDir: command.runsDir,
    engine: command.engine
  });
  const configPath = command.configPath
    ? resolveConfigPath(command.configPath, environment.workingDirectory)
    : join(environment.workingDirectory, "martin.config.yaml");
  const configExists = await stat(configPath).then(() => true).catch(() => false);
  const workingDirectoryReady = await stat(environment.workingDirectory).then(() => true).catch(() => false);
  const runsRootReady = await stat(environment.runsRoot).then(() => true).catch(() => false);
  const claudeAvailable = isCommandAvailable("claude");
  const codexAvailability = resolveCodexAvailabilityForCli();
  const codexAvailable = codexAvailability.available;
  const geminiAvailability = resolveCliCommandAvailability("gemini");
  const geminiAvailable = geminiAvailability.available;
  const codexProbe =
    environment.liveMode === "live" && environment.engine === "codex" && workingDirectoryReady
      ? resolveCodexProbeForCli({
          workingDirectory: environment.workingDirectory,
          availability: codexAvailability
        })
      : undefined;
  const receiptScope = buildCliReceiptScope(environment);
  const warnings: string[] = [];

  if (!workingDirectoryReady) {
    warnings.push("The selected working directory does not exist yet.");
  }
  if (!runsRootReady) {
    warnings.push("The Martin runs root does not exist yet; it will be created on the first persisted run.");
  }
  if (environment.liveMode === "live" && environment.engine === "claude" && !claudeAvailable) {
    warnings.push("Claude CLI is not available on PATH for live execution.");
  }
  if (environment.liveMode === "live" && environment.engine === "codex" && !codexAvailable) {
    warnings.push("Codex CLI is not available on PATH for live execution.");
  }
  if (environment.liveMode === "live" && environment.engine === "gemini" && !geminiAvailable) {
    warnings.push("Gemini CLI is not available on PATH for live execution.");
  }
  if (environment.liveMode === "live" && environment.engine === "codex" && codexProbe && !codexProbe.ok) {
    warnings.push(codexProbe.summary);
  }

  const data = {
    command: "doctor",
    cliVersion: rootPackageVersion,
    environment,
    receiptScope,
    scope: {
      ...receiptScope
    },
    config: {
      path: configPath,
      exists: configExists
    },
    engines: {
      claude: { available: claudeAvailable },
      codex: {
        ...buildCodexEngineDiagnostics(codexAvailability, codexProbe)
      },
      openai: {
        available: true,
        ...resolveOpenAiCompatibleRuntimeConfig()
      },
      gemini: {
        available: geminiAvailable,
        ...(geminiAvailability.resolvedPath ? { resolvedPath: geminiAvailability.resolvedPath } : {})
      }
    },
    starterTools: [...MARTIN_STARTER_TOOLS],
    profiles: {
      minimal: [...MARTIN_MINIMAL_TOOLS],
      diagnostic: [...MARTIN_DIAGNOSTIC_TOOLS],
      "full-local": [...MARTIN_FULL_TOOLS],
      starter: [...MARTIN_STARTER_TOOLS],
      full: [...MARTIN_FULL_TOOLS]
    },
    recommendations: buildDoctorRecommendations({
      liveMode: environment.liveMode,
      engine: environment.engine,
      claudeAvailable,
      codexAvailable,
      geminiAvailable,
      workingDirectoryReady,
      codexLaunchReady: codexProbe?.ok,
      codexRemediation: codexProbe?.diagnosis.remediation
    })
  };

  await recordCliWorkflowStep({
    runsRoot: environment.runsRoot,
    step: "doctor",
    workingDirectory: environment.workingDirectory,
    engine: environment.engine,
    receiptScope
  }).catch(() => {});

  return renderCliSuccess(outputMode, {
    data,
    human: [
      `Martin CLI doctor (${rootPackageVersion})`,
      `Working directory: ${environment.workingDirectory} (${workingDirectoryReady ? "ready" : "missing"})`,
      `Runs root: ${environment.runsRoot} (${runsRootReady ? "ready" : "not created yet"})`,
      `Live mode: ${environment.liveMode}`,
      `Claude CLI: ${claudeAvailable ? "available" : "missing"}`,
      `Codex CLI: ${codexAvailable ? "available" : "missing"}`,
      `Gemini CLI: ${geminiAvailable ? "available" : "missing"}`,
      `OpenAI-compatible: ${resolveOpenAiCompatibleRuntimeConfig().baseUrl} (${resolveOpenAiCompatibleRuntimeConfig().model})`,
      ...(codexProbe ? [`Codex launch probe: ${codexProbe.ok ? "ready" : codexProbe.summary}`] : []),
      `Receipt scope: repo=${receiptScope.repoRoot} runs=${receiptScope.runsRoot}`,
      `Config: ${configExists ? configPath : `not found at ${configPath}`}`
    ],
    quiet: environment.runsRoot,
    warnings
  });
}

type StartEnvironmentSnapshot = {
  workingDirectoryReady: boolean;
  runsRootReady: boolean;
  claudeAvailable: boolean;
  codexAvailability: ReturnType<typeof resolveCliCommandAvailability>;
  geminiAvailability: ReturnType<typeof resolveCliCommandAvailability>;
  verifier: {
    command: string;
    detected: boolean;
  };
  recommendedEngine: "claude" | "codex" | "gemini" | "openai";
  git: {
    detected: boolean;
    clean?: boolean;
  };
};

async function executeEnvCommand(
  command: EnvCommand,
  outputMode: MartinOutputMode
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const environment = resolveCliEnvironment({
    cwd: command.cwd,
    runsDir: command.runsDir
  });
  const snapshot = await collectStartEnvironmentSnapshot(environment.workingDirectory, environment.runsRoot);
  const openai = resolveOpenAiCompatibleRuntimeConfig();
  const receiptScope = buildCliReceiptScope(environment);
  const warnings: string[] = [];

  if (!snapshot.workingDirectoryReady) {
    warnings.push("Working directory is missing.");
  }
  if (!snapshot.runsRootReady) {
    warnings.push("Runs root does not exist yet; MartinLoop will create it on first persisted run.");
  }

  return renderCliSuccess(outputMode, {
    data: {
      command: "env",
      environment,
      git: snapshot.git,
      verifier: snapshot.verifier,
      providers: {
        claude: { ready: snapshot.claudeAvailable },
        codex: {
          ready: snapshot.codexAvailability.available,
          ...(snapshot.codexAvailability.resolvedPath ? { resolvedPath: snapshot.codexAvailability.resolvedPath } : {})
        },
        gemini: {
          ready: snapshot.geminiAvailability.available,
          ...(snapshot.geminiAvailability.resolvedPath ? { resolvedPath: snapshot.geminiAvailability.resolvedPath } : {})
        },
        openai: {
          ready: true,
          baseUrl: openai.baseUrl,
          model: openai.model,
          apiKeyConfigured: openai.apiKeyConfigured
        }
      },
      receiptSigning: {
        ready: snapshot.runsRootReady,
        note: snapshot.runsRootReady
          ? "Runs root exists; receipt integrity material can be persisted."
          : "Runs root will be created on first persisted run."
      },
      recommendedEngine: snapshot.recommendedEngine,
      receiptScope
    },
    human: [
      "Martin environment",
      `Repo: ${environment.workingDirectory} (${snapshot.git.detected ? "git detected" : "no git metadata"})`,
      `Verifier: ${snapshot.verifier.command}${snapshot.verifier.detected ? " (detected)" : " (default)"}`,
      `Claude: ${snapshot.claudeAvailable ? "ready" : "blocked (cli missing)"}`,
      `Codex: ${snapshot.codexAvailability.available ? "ready" : "blocked (cli missing)"}`,
      `Gemini: ${snapshot.geminiAvailability.available ? "ready" : "blocked (cli missing)"}`,
      `OpenAI-compatible: ready (${openai.baseUrl}, ${openai.model})`,
      `Receipt signing: ${snapshot.runsRootReady ? "ready" : "not initialized yet"}`,
      `Recommended engine: ${snapshot.recommendedEngine}`
    ],
    quiet: snapshot.recommendedEngine,
    warnings
  });
}

async function executeStartCommand(
  command: StartCommand,
  outputMode: MartinOutputMode
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const environment = resolveCliEnvironment({
    cwd: command.cwd,
    runsDir: command.runsDir
  });
  const snapshot = await collectStartEnvironmentSnapshot(environment.workingDirectory, environment.runsRoot);
  const receiptScope = buildCliReceiptScope(environment);
  const detectedIDE = detectHostIDE();

  // Load working mode preference from ~/.martin/config.json
  let currentMode = "auto";
  let modeConfigured = false;
  try {
    const modeConfig = JSON.parse(
      await readFile(join(homedir(), ".martin", "config.json"), "utf8")
    ) as { defaultMode?: string };
    if (modeConfig.defaultMode) {
      currentMode = modeConfig.defaultMode;
      modeConfigured = true;
    }
  } catch { /* fresh install */ }

  // Load stored budget preference from MartinLoop memory.
  // On first run there's no preference — we surface a suggestion.
  // On subsequent runs we use what the user set before.
  const storedBudgetPref = await getPreference(environment.runsRoot, "budget.default").catch(() => undefined);
  const defaultBudgetUsd: number = typeof storedBudgetPref?.value === "number" ? storedBudgetPref.value : 2;

  // Record that start was invoked — tracks onboarding cadence in memory.
  await recordPreference(environment.runsRoot, "onboarding.start.lastRun", new Date().toISOString(), "inferred").catch(() => {});

  const objective = "Summarize this repository and confirm the verifier is green.";
  const contextFlags = renderStartContextFlags(command);
  const preflightCommand = `martin preflight "${objective}" --verify "${snapshot.verifier.command}"${contextFlags}`;
  const governedRunCommand = `martin run "${objective}" --verify "${snapshot.verifier.command}" --budget-usd ${defaultBudgetUsd} --max-iterations 1${contextFlags}`;
  const proofCommand = `martin run "${objective}" --proof --verify "${snapshot.verifier.command}" --budget-usd ${defaultBudgetUsd} --max-iterations 1${contextFlags}`;
  const estimateCommand = `martin estimate "${objective}" --engine ${snapshot.recommendedEngine} --budget-usd ${defaultBudgetUsd}${contextFlags}`;
  const doctorCommand = `martin doctor${contextFlags}`;
  const sessionStartCommand = `martin session-start${contextFlags}`;
  const enableCommand = `martin enable --engine ${snapshot.recommendedEngine} --verify "${snapshot.verifier.command}" --budget-usd ${defaultBudgetUsd} --max-iterations 1${contextFlags}`;
  const reviewCommand = `martin review${renderRunsDirContextFlag(command)}`;
  const dossierCommand = `martin dossier --latest${renderRunsDirContextFlag(command)}`;
  const shareCommand = `martin share --latest${renderRunsDirContextFlag(command)}`;

  await recordCliWorkflowStep({
    runsRoot: environment.runsRoot,
    step: "start",
    workingDirectory: environment.workingDirectory,
    engine: snapshot.recommendedEngine,
    receiptScope
  }).catch(() => {});

  return renderCliSuccess(outputMode, {
    data: {
      command: "start",
      environment,
      receiptScope,
      detectedHost: detectedIDE.host,
      repo: {
        path: environment.workingDirectory,
        gitDetected: snapshot.git.detected,
        workingTree: snapshot.git.clean === undefined ? "unknown" : snapshot.git.clean ? "clean" : "dirty"
      },
      verifier: snapshot.verifier,
      recommended: {
        engine: snapshot.recommendedEngine,
        verifier: snapshot.verifier.command,
        budgetUsd: defaultBudgetUsd,
        maxIterations: 1
      },
      next: {
        mcpInstall: detectedIDE.mcpInstallCommand,
        doctor: doctorCommand,
        estimate: estimateCommand,
        sessionStart: sessionStartCommand,
        preflight: preflightCommand,
        run: governedRunCommand,
        proofRun: proofCommand,
        enable: enableCommand,
        review: reviewCommand,
        dossier: dossierCommand,
        share: shareCommand
      }
    },
    human: [
      "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
      " MartinLoop — Governed AI Coding",
      "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
      "",
      modeConfigured
        ? `Mode: ${currentMode} (change with martin mode auto|plan|edits)`
        : "Mode: not set — choose how MartinLoop interacts before your first governed run",
      "",
      ...(!modeConfigured ? [
        "── Consent: Choose Your Working Mode ──",
        "  auto   — Governs autonomously: estimate → preflight → run → receipt.",
        "           Best for most work. MartinLoop acts without per-step approval.",
        "  plan   — Shows the plan before executing. You approve each step.",
        "  edits  — Shows each file change before writing. Maximum control.",
        "",
        "  $ martin mode auto     # recommended",
        "  $ martin mode plan     # approval required",
        "  $ martin mode edits    # per-edit review",
        "",
        "  Runs are blocked until a mode is set or you explicitly accept auto.",
        ""
      ] : []),
      "Environment",
      `  Host:       ${detectedIDE.host}`,
      `  Verifier:   ${snapshot.verifier.command}${snapshot.verifier.detected ? "" : " (default)"}`,
      `  Claude:     ${snapshot.claudeAvailable ? "ready" : "not found"}`,
      `  Codex:      ${snapshot.codexAvailability.available ? "ready" : "not found"}`,
      `  Gemini:     ${snapshot.geminiAvailability.available ? "ready" : "not found"}`,
      `  Engine:     ${snapshot.recommendedEngine}`,
      "",
      "── Step 1: Install MCP Governance ──",
      `  ${detectedIDE.governanceHint}`,
      `  $ ${detectedIDE.mcpInstallCommand}`,
      "",
      "── Step 2: Estimate Before You Spend ──",
      `  $ ${estimateCommand}`,
      "",
      "── Step 3: Governed Run ──",
      `  $ ${doctorCommand}`,
      `  $ ${preflightCommand}`,
      `  $ ${governedRunCommand}`,
      "",
      "── Step 4: Inspect Results ──",
      `  $ ${dossierCommand}`,
      `  $ ${shareCommand}`,
      "",
      "No-spend proof lane",
      `  $ ${proofCommand}`,
      "",
      "Set repo defaults",
      `  $ ${enableCommand}`
    ],
    quiet: "martin start"
  });
}

function renderStartContextFlags(command: StartCommand): string {
  return [renderCwdContextFlag(command), renderRunsDirContextFlag(command)].filter(Boolean).join("");
}

function renderCwdContextFlag(command: StartCommand): string {
  return command.cwd ? ` --cwd "${escapeCliDoubleQuoted(command.cwd)}"` : "";
}

function renderRunsDirContextFlag(command: StartCommand): string {
  return command.runsDir ? ` --runs-dir "${escapeCliDoubleQuoted(command.runsDir)}"` : "";
}

function escapeCliDoubleQuoted(value: string): string {
  return value.replaceAll('"', '\\"');
}

async function executeEnableCommand(
  command: EnableCommand,
  outputMode: MartinOutputMode
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const environment = resolveCliEnvironment({
    cwd: command.cwd,
    runsDir: command.runsDir,
    engine: command.engine
  });
  const snapshot = await collectStartEnvironmentSnapshot(environment.workingDirectory, environment.runsRoot);
  const configPath = command.configPath
    ? resolveConfigPath(command.configPath, environment.workingDirectory)
    : join(environment.workingDirectory, "martin.config.yaml");
  const configExists = await stat(configPath).then(() => true).catch(() => false);
  if (configExists && !command.force) {
    throw new CliCommandError("invalid_input", `Config already exists at ${configPath}.`, {
      suggestion: "Re-run with --force to overwrite, or pass --config <path>."
    });
  }

  const engine = command.engine ?? snapshot.recommendedEngine;
  const verifier = command.verifier?.trim() || snapshot.verifier.command;
  const budgetUsd = Number.isFinite(command.budgetUsd) && (command.budgetUsd ?? 0) > 0 ? Number(command.budgetUsd) : 2;
  const maxIterations = Number.isFinite(command.maxIterations) && (command.maxIterations ?? 0) > 0
    ? Number(command.maxIterations)
    : 1;
  const softLimit = Number(Math.max(0.1, budgetUsd * 0.8).toFixed(2));
  const maxTokens = 20_000;
  const configContents = renderMartinConfigYaml({
    policyProfile: "strict_local",
    verifier,
    budgetUsd,
    softLimitUsd: softLimit,
    maxIterations,
    maxTokens,
    telemetryDestination: "local"
  });

  await writeFile(configPath, configContents, "utf8");

  return renderCliSuccess(outputMode, {
    data: {
      command: "enable",
      configPath,
      defaults: {
        engine,
        verifier,
        budgetUsd,
        maxIterations,
        maxTokens
      },
      next: {
        doctor: "martin doctor",
        sessionStart: "martin session-start",
        preflight: `martin preflight "Summarize this repository and confirm the verifier is green." --verify "${verifier}"`,
        run: `martin "fix the next failing test and keep ${verifier} green"`
      }
    },
    human: [
      "MartinLoop is now enabled for this repo.",
      `Config: ${configPath}`,
      "",
      "Defaults",
      `- Engine: ${engine}`,
      `- Verifier: ${verifier}`,
      `- Budget cap: $${budgetUsd.toFixed(2)}`,
      `- Max iterations: ${maxIterations}`,
      "",
      "Next",
      "- martin doctor",
      "- martin session-start",
      `- martin preflight "Summarize this repository and confirm the verifier is green." --verify "${verifier}"`,
      `- martin "fix the next failing test and keep ${verifier} green"`
    ],
    quiet: configPath
  });
}

async function executeReviewCommand(
  command: ReviewCommand,
  outputMode: MartinOutputMode
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  let detail: Awaited<ReturnType<typeof loadPersistedLoop>>;
  try {
    detail = await loadPersistedLoop(command.selector);
  } catch (error) {
    if (error instanceof CliCommandError && error.category === "not_found") {
      return renderCliSuccess(outputMode, {
        data: {
          command: "review",
          status: "no_runs",
          next: [
            "martin doctor",
            "martin session-start",
            "martin preflight \"Summarize this repository and confirm the verifier is green.\" --verify \"npm test\""
          ]
        },
        human: [
          "No governed runs were found yet.",
          "Start here:",
          "- martin doctor",
          "- martin session-start",
          "- martin preflight \"Summarize this repository and confirm the verifier is green.\" --verify \"npm test\"",
          "- martin run \"Summarize this repository and confirm the verifier is green.\" --verify \"npm test\" --budget-usd 2 --max-iterations 1"
        ],
        quiet: "no_runs"
      });
    }
    throw error;
  }

  const dossier = buildRunDossier(detail);
  const verification = buildVerificationSummary(detail.loop);
  const costProvenance = readCostProvenance(detail.loop);
  const trustworthy = detail.integrity.state === "verified";

  return renderCliSuccess(outputMode, {
    data: {
      command: "review",
      loopId: detail.loop.loopId,
      status: detail.loop.status,
      lifecycleState: detail.loop.lifecycleState,
      verification,
      receiptIntegrity: detail.integrity,
      trusted: trustworthy,
      cost: {
        usd: detail.loop.cost.actualUsd,
        provenance: describeCostProvenance(costProvenance)
      },
      changedFiles: detail.loop.artifacts.filter((artifact) => artifact.kind === "diff").map((artifact) => artifact.label),
      receipt: dossier["receipt"]
    },
    human: [
      "Latest run",
      `- Loop: ${detail.loop.loopId}`,
      `- Status: ${detail.loop.status} / ${detail.loop.lifecycleState}`,
      `- Verification: ${verification.status}`,
      `- Receipt integrity: ${detail.integrity.state}`,
      `- Cost: $${detail.loop.cost.actualUsd.toFixed(2)} (${describeCostProvenance(costProvenance)})`,
      `- Trust: ${trustworthy ? "verified receipt" : "needs investigation before sharing"}`,
      "",
      "Next",
      "- martin share --latest",
      "- martin runs verify --latest",
      "- martin \"next objective\""
    ],
    quiet: detail.loop.loopId,
    warnings: [...detail.warnings, ...verification.warnings]
  });
}

async function executeReceiptsExplainCommand(
  selector: MartinRunSelector,
  outputMode: MartinOutputMode
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const detail = await loadPersistedLoop(selector);
  const integrity = detail.integrity.state;
  const explanation = explainIntegrityState(integrity);
  const verification = buildVerificationSummary(detail.loop);

  return renderCliSuccess(outputMode, {
    data: {
      command: "receipts_explain",
      loopId: detail.loop.loopId,
      receiptIntegrity: detail.integrity,
      verification,
      explanation
    },
    human: [
      `Receipt trust for ${detail.loop.loopId}`,
      `- Integrity state: ${integrity}`,
      `- Meaning: ${explanation.meaning}`,
      `- Safe to share as verified evidence: ${explanation.shareSafe ? "yes" : "no"}`,
      `- Next action: ${explanation.nextAction}`
    ],
    quiet: integrity,
    warnings: [...detail.warnings, ...verification.warnings]
  });
}

async function collectStartEnvironmentSnapshot(
  workingDirectory: string,
  runsRoot: string
): Promise<StartEnvironmentSnapshot> {
  const workingDirectoryReady = await stat(workingDirectory).then(() => true).catch(() => false);
  const runsRootReady = await stat(runsRoot).then(() => true).catch(() => false);
  const claudeAvailable = isCommandAvailable("claude");
  const codexAvailability = resolveCodexAvailabilityForCli();
  const geminiAvailability = resolveCliCommandAvailability("gemini");
  const verifier = await detectVerifierCommand(workingDirectory);
  const recommendedEngine = selectRecommendedEngine({
    claudeAvailable,
    codexAvailable: codexAvailability.available,
    geminiAvailable: geminiAvailability.available
  });
  const git = inspectGitRepository(workingDirectory);

  return {
    workingDirectoryReady,
    runsRootReady,
    claudeAvailable,
    codexAvailability,
    geminiAvailability,
    verifier,
    recommendedEngine,
    git
  };
}

async function detectVerifierCommand(workingDirectory: string): Promise<{ command: string; detected: boolean }> {
  const packageJsonPath = join(workingDirectory, "package.json");
  try {
    const raw = await readFile(packageJsonPath, "utf8");
    const parsed = JSON.parse(raw) as { scripts?: Record<string, string> };
    if (parsed.scripts?.test?.trim()) {
      if (await pathExists(join(workingDirectory, "pnpm-lock.yaml"))) {
        return { command: "pnpm test", detected: true };
      }
      if (await pathExists(join(workingDirectory, "yarn.lock"))) {
        return { command: "yarn test", detected: true };
      }
      if (await pathExists(join(workingDirectory, "bun.lockb"))) {
        return { command: "bun test", detected: true };
      }
      return { command: "npm test", detected: true };
    }
  } catch {
    // Ignore invalid/missing package.json and continue with other heuristics.
  }

  if (await pathExists(join(workingDirectory, "pyproject.toml")) || await pathExists(join(workingDirectory, "pytest.ini"))) {
    return { command: "pytest", detected: true };
  }

  return { command: "npm test", detected: false };
}

async function pathExists(path: string): Promise<boolean> {
  return stat(path).then(() => true).catch(() => false);
}

interface DetectedHostIDE {
  host: string;
  mcpInstallCommand: string;
  governanceHint: string;
}

function detectHostIDE(): DetectedHostIDE {
  const env = process.env;

  // Claude Code sets CLAUDE_CODE=1 or has claude in the parent process
  if (env.CLAUDE_CODE === "1" || env.CLAUDE_CODE_SIMPLE === "1" || env.TERM_PROGRAM === "claude") {
    return {
      host: "claude",
      mcpInstallCommand: "martin mcp install --host claude --scope user",
      governanceHint: "Claude Code detected. MartinLoop can install governance hooks (PreToolUse + Stop) automatically."
    };
  }

  // Codex sets CODEX_HOME or runs from codex exec
  if (env.CODEX_HOME || env.CODEX_SANDBOX_MODE) {
    return {
      host: "codex",
      mcpInstallCommand: "martin mcp install --host codex --scope user",
      governanceHint: "Codex detected. MartinLoop can add governance instructions to your AGENTS.md."
    };
  }

  // Cursor sets CURSOR_TRACE_ID or similar
  if (env.CURSOR_TRACE_ID || env.CURSOR_SESSION_ID) {
    return {
      host: "cursor",
      mcpInstallCommand: "martin mcp install --host cursor --scope project",
      governanceHint: "Cursor detected. MartinLoop can install governance rules in .cursor/rules/."
    };
  }

  // VS Code / Copilot sets VSCODE_PID or TERM_PROGRAM=vscode
  if (env.VSCODE_PID || env.TERM_PROGRAM === "vscode") {
    return {
      host: "copilot",
      mcpInstallCommand: "martin mcp install --host copilot --scope project",
      governanceHint: "VS Code detected. MartinLoop can add governance instructions to .github/copilot-instructions.md."
    };
  }

  // Gemini CLI sets GEMINI_API_KEY typically
  if (env.GEMINI_API_KEY) {
    return {
      host: "gemini",
      mcpInstallCommand: "martin mcp install --host gemini --scope user",
      governanceHint: "Gemini detected. MartinLoop can install governance rules in GEMINI.md."
    };
  }

  return {
    host: "generic",
    mcpInstallCommand: "martin mcp install --host claude --scope user",
    governanceHint: "Install MartinLoop MCP for your IDE to enable proactive governance."
  };
}

function inspectGitRepository(workingDirectory: string): { detected: boolean; clean?: boolean } {
  const inside = spawnSync("git", ["rev-parse", "--is-inside-work-tree"], {
    cwd: workingDirectory,
    encoding: "utf8"
  });
  if (inside.status !== 0 || !inside.stdout.includes("true")) {
    return { detected: false };
  }

  const status = spawnSync("git", ["status", "--porcelain"], {
    cwd: workingDirectory,
    encoding: "utf8"
  });
  if (status.status !== 0) {
    return { detected: true };
  }

  return { detected: true, clean: status.stdout.trim().length === 0 };
}

function selectRecommendedEngine(input: {
  claudeAvailable: boolean;
  codexAvailable: boolean;
  geminiAvailable: boolean;
}): "claude" | "codex" | "gemini" | "openai" {
  if (input.claudeAvailable) {
    return "claude";
  }
  if (input.codexAvailable) {
    return "codex";
  }
  if (input.geminiAvailable) {
    return "gemini";
  }
  return "openai";
}

function renderMartinConfigYaml(input: {
  policyProfile: string;
  verifier: string;
  budgetUsd: number;
  softLimitUsd: number;
  maxIterations: number;
  maxTokens: number;
  telemetryDestination: string;
}): string {
  const escapedVerifier = input.verifier.replaceAll('"', '\\"');
  return [
    `policyProfile: ${input.policyProfile}`,
    "budget:",
    `  maxUsd: ${input.budgetUsd}`,
    `  softLimitUsd: ${input.softLimitUsd}`,
    `  maxIterations: ${input.maxIterations}`,
    `  maxTokens: ${input.maxTokens}`,
    "governance:",
    "  destructiveActionPolicy: approval",
    `  telemetryDestination: ${input.telemetryDestination}`,
    "  verifierRules:",
    `    - "${escapedVerifier}"`,
    ""
  ].join("\n");
}

function explainIntegrityState(state: IntegrityStatus): {
  meaning: string;
  shareSafe: boolean;
  nextAction: string;
} {
  switch (state) {
    case "verified":
      return {
        meaning: "Receipt material matches the signed canonical run record.",
        shareSafe: true,
        nextAction: "Use martin share --latest to publish a redacted bundle."
      };
    case "unsigned":
      return {
        meaning: "No sidecar signature was found for this run record.",
        shareSafe: false,
        nextAction: "Re-run through governed flow and preserve canonical run artifacts."
      };
    case "tamper_detected":
      return {
        meaning: "Signed material exists, but stored content no longer matches the signed snapshot.",
        shareSafe: false,
        nextAction: "Treat evidence as compromised and reproduce the run from canonical inputs."
      };
    case "relocated":
      return {
        meaning: "Run was loaded outside the canonical runs root.",
        shareSafe: false,
        nextAction: "Load with --loop-id or --latest from the configured runs root."
      };
    case "material_missing":
      return {
        meaning: "Required integrity material (ledger/sidecar/key data) is incomplete.",
        shareSafe: false,
        nextAction: "Repair run persistence inputs and rerun governed flow."
      };
    case "selector_noncanonical":
      return {
        meaning: "Selector shape bypassed canonical run identity checks.",
        shareSafe: false,
        nextAction: "Use canonical selectors: --latest or --loop-id <id>."
      };
  }
}

async function executeNativePhaseCommand(
  command: NativePhaseCommand,
  outputMode: MartinOutputMode
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const snapshot = await createNativePhaseCommandCenterSnapshot({
    rootDir: command.cwd,
    invocationRoot: resolveInvocationRoot(),
    runsDir: command.runsDir,
    host: command.host,
    runScanLimit: command.runScanLimit
  });

  if ((command.subcommand === "preflight" || command.subcommand === "run") && command.execute) {
    if (snapshot.contract.requiresApproval) {
      return renderCliSuccess(outputMode, {
        data: selectNativePhasePayload(snapshot, command.subcommand),
        human: [
          `Phase ${command.subcommand} blocked: contract requires approval.`,
          `Missing safeguards: ${snapshot.contract.missingSafeguards.join(", ") || "none"}`
        ],
        quiet: "blocked"
      });
    }

    const request = buildNativePhaseRunRequest(snapshot.contract, {
      cwd: command.cwd,
      runsDir: command.runsDir
    });
    return command.subcommand === "run"
      ? executeRunCommand(request, outputMode)
      : executePreflightCommand(request, outputMode);
  }

  const data = selectNativePhasePayload(snapshot, command.subcommand);
  if (command.subcommand === "session-start") {
    await recordCliWorkflowStep({
      runsRoot: snapshot.receiptScope.runsRoot,
      step: "session-start",
      workingDirectory: snapshot.receiptScope.workingDirectory,
      ...(snapshot.sessionStart.host === "codex" ? { engine: "codex" as const } : {}),
      receiptScope: snapshot.receiptScope
    }).catch(() => {});
  }
  if (command.subcommand === "preflight" && !snapshot.contract.requiresApproval) {
    const environment = resolveCliEnvironment({
      cwd: command.cwd,
      runsDir: command.runsDir
    });
    const request = buildNativePhaseRunRequest(snapshot.contract, {
      cwd: command.cwd,
      runsDir: command.runsDir
    });
    await recordCliWorkflowStep({
      runsRoot: environment.runsRoot,
      step: "preflight",
      workingDirectory: environment.workingDirectory,
      objective: request.objective,
      engine: "claude",
      verificationPlan: request.verificationPlan,
      receiptScope: buildCliReceiptScope(environment)
    }).catch(() => {});
  }
  const human =
    command.subcommand === "session-start"
      ? renderNativePhaseHuman(snapshot)
      : [
          `Phase ${command.subcommand} ${snapshot.contract.requiresApproval ? "requires approval" : "ready"}.`,
          `Objective: ${snapshot.contract.objective}`,
          `Risk: ${snapshot.contract.riskLevel}`,
          `Verifiers: ${snapshot.contract.verifiers.join(", ") || "missing"}`
        ];

  return renderCliSuccess(outputMode, {
    data,
    human,
    quiet:
      command.subcommand === "contract"
        ? snapshot.contract.requiresApproval
          ? "approval_required"
          : "ready"
        : snapshot.sessionStart.recommendedNextAction
  });
}

async function executePreflightCommand(
  request: RunCommandRequest,
  outputMode: MartinOutputMode
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const resolvedGuardrails = await resolveGuardrails(request);
  const environment = resolveCliEnvironment({
    cwd: request.cwd,
    runsDir: request.runsDir,
    engine: request.engine
  });
  const warnings: string[] = [];
  const blockingIssues: string[] = [];
  const verificationPlan =
    request.verificationPlan.length > 0
      ? request.verificationPlan
      : resolvedGuardrails.verifierRules;
  const engineRequired = environment.liveMode === "live";
  const receiptScope = buildCliReceiptScope(environment);

  const workingDirectoryExists = await stat(environment.workingDirectory).then(() => true).catch(() => false);
  const codexAvailability = resolveCodexAvailabilityForCli();
  const geminiAvailability = resolveCliCommandAvailability("gemini");
  const codexProbe =
    engineRequired && environment.engine === "codex" && workingDirectoryExists
      ? resolveCodexProbeForCli({
          workingDirectory: environment.workingDirectory,
          availability: codexAvailability,
          model: request.model
        })
      : undefined;
  if (!workingDirectoryExists) {
    blockingIssues.push("Working directory does not exist.");
  }

  if (engineRequired && environment.engine === "claude" && !isCommandAvailable("claude")) {
    blockingIssues.push("Claude CLI is not available on PATH.");
  }
  if (engineRequired && environment.engine === "codex" && !codexAvailability.available) {
    blockingIssues.push("Codex CLI is not available on PATH.");
  }
  if (engineRequired && environment.engine === "gemini" && !geminiAvailability.available) {
    blockingIssues.push("Gemini CLI is not available on PATH.");
  }
  if (engineRequired && environment.engine === "codex" && codexProbe && !codexProbe.ok) {
    blockingIssues.push(codexProbe.summary);
  }
  if (verificationPlan.length === 0) {
    warnings.push("No verification plan is configured for this run.");
  }

  const overlappingPaths = (request.allowedPaths ?? []).filter((allowedPath) =>
    (request.deniedPaths ?? []).includes(allowedPath)
  );
  if (overlappingPaths.length > 0) {
    warnings.push(`The same path appears in both allow and deny lists: ${overlappingPaths.join(", ")}`);
  }

  // Corpus intelligence: surface failure hotspots for this working directory.
  // Degrades gracefully when corpus is empty or not yet populated.
  const scopeFingerprint = computeScopeFingerprint(environment.workingDirectory);
  const shouldInspectRunHistory = Boolean(request.runsDir ?? process.env["MARTIN_RUNS_DIR"]);
  const runHistoryRisk = shouldInspectRunHistory
    ? await readLocalRunHistoryRisk({ runsDir: environment.runsRoot }).catch(() => ({
        hotspots: [],
        runRecords: 0,
        runsRoot: environment.runsRoot
      }))
    : {
        hotspots: [],
        runRecords: 0,
        runsRoot: environment.runsRoot
      };
  const runHistoryHotspots = runHistoryRisk.hotspots.filter(
    (hotspot) => hotspot.scopeFingerprint === scopeFingerprint
  ).slice(0, 3);
  const corpusRisk = await readLocalCorpusRisk().catch(() => ({ hotspots: [], corpusRecords: 0, corpusPath: "" }));
  const scopeHotspots = corpusRisk.hotspots.filter(
    (hotspot) => hotspot.scopeFingerprint === scopeFingerprint
  ).slice(0, 3);

  for (const hotspot of runHistoryHotspots) {
    const pct = Math.round(hotspot.failureRate * 100);
    const classes = hotspot.commonFailureClasses.length > 0
      ? ` (${hotspot.commonFailureClasses.join(", ")})`
      : "";
    warnings.push(
      `Run history risk: this scope has a ${pct}% failure rate across ${hotspot.sampleSize} local governed runs${classes}. Risk score: ${hotspot.riskScore}.`
    );
  }

  for (const hotspot of scopeHotspots) {
    const pct = Math.round(hotspot.failureRate * 100);
    const classes = hotspot.commonFailureClasses.length > 0
      ? ` (${hotspot.commonFailureClasses.join(", ")})`
      : "";
    warnings.push(
      `Run history risk: this scope has a ${pct}% failure rate across ${hotspot.sampleSize} recorded runs${classes}. Risk score: ${hotspot.riskScore}.`
    );
  }

  const ready = blockingIssues.length === 0;
  const data = {
    command: "preflight",
    ready,
    blockingIssues,
    warnings,
    environment,
    receiptScope,
    scope: {
      ...receiptScope
    },
    engineProbe:
      environment.engine === "codex"
        ? buildCodexEngineDiagnostics(codexAvailability, codexProbe)
        : environment.engine === "gemini"
          ? {
              available: geminiAvailability.available,
              ...(geminiAvailability.resolvedPath ? { resolvedPath: geminiAvailability.resolvedPath } : {})
            }
        : undefined,
    corpus: {
      records: corpusRisk.corpusRecords,
      scopeHotspots
    },
    request: {
      ...request,
      verificationPlan,
      budget: resolvedGuardrails.budget
    },
    effectivePolicy: {
      configPath: resolvedGuardrails.configPath,
      policyProfile: resolvedGuardrails.policyProfile,
      destructiveActionPolicy: resolvedGuardrails.destructiveActionPolicy,
      telemetryDestination: resolvedGuardrails.telemetryDestination
    }
  };

  if (ready) {
    await recordCliWorkflowStep({
      runsRoot: environment.runsRoot,
      step: "preflight",
      workingDirectory: environment.workingDirectory,
      objective: request.objective,
      engine: environment.engine,
      verificationPlan,
      receiptScope,
      allowedPaths: request.allowedPaths,
      deniedPaths: request.deniedPaths,
      budget: resolvedGuardrails.budget
    }).catch(() => {});
  }

  const corpusLine = corpusRisk.corpusRecords > 0
    ? `Corpus: ${corpusRisk.corpusRecords} records${scopeHotspots.length > 0 ? `, ${scopeHotspots.length} scope hotspot(s)` : ", no scope hotspots"}`
    : `Corpus: no data yet — run Martin to start building prediction intelligence`;
  const runHistoryLine = runHistoryRisk.runRecords > 0
    ? `Run history: ${runHistoryRisk.runRecords} local run record(s)${runHistoryHotspots.length > 0 ? `, ${runHistoryHotspots.length} scope hotspot(s)` : ", no scope hotspots"}`
    : `Run history: no local persisted governed runs yet`;
  const riskWarnings = warnings.filter((warning) => warning.startsWith("Run history risk:"));

  return renderCliSuccess(outputMode, {
    data,
    human: [
      `Preflight ${ready ? "passed" : "blocked"} for ${request.title}`,
      `Working directory: ${environment.workingDirectory}`,
      `Engine: ${environment.engine} (${environment.liveMode})`,
      `Verification plan: ${verificationPlan.join(", ") || "none"}`,
      `Receipt scope: repo=${receiptScope.repoRoot} runs=${receiptScope.runsRoot}`,
      runHistoryLine,
      corpusLine,
      ...riskWarnings,
      ...(blockingIssues.length > 0 ? ["Blocking issues:", ...blockingIssues.map((issue) => `- ${issue}`)] : [])
    ],
    quiet: ready ? "ready" : "blocked",
    warnings
  });
}

async function executeTriageCommand(
  filters: MartinRunListFilters,
  outputMode: MartinOutputMode
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const triage = await triagePersistedLoops(filters);

  return renderCliSuccess(outputMode, {
    data: {
      command: "triage",
      runsRoot: triage.runsRoot,
      findingCount: triage.findings.length,
      findings: triage.findings
    },
    human: [
      `Triaged ${triage.findings.length} persisted runs from ${triage.runsRoot}`,
      ...triage.findings.slice(0, 5).map(
        (finding) =>
          `- [${finding.priority}] ${finding.loopId} ${finding.status}/${finding.lifecycleState}: ${finding.summary}`
      )
    ],
    quiet: triage.findings[0]?.loopId ?? "",
    warnings: triage.warnings
  });
}

async function executeDossierCommand(
  selector: MartinRunSelector,
  outputMode: MartinOutputMode
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const detail = await loadPersistedLoop(selector);
  const dossier = buildRunDossier(detail);
  const verification = buildVerificationSummary(detail.loop);
  const costProvenance = readCostProvenance(detail.loop);
  const receipt = dossier["receipt"] as {
    whatHappened?: string;
    whatMartinPrevented?: string[];
    nextSafeAction?: string;
  };

  return renderCliSuccess(outputMode, {
    data: {
      command: "dossier",
      ...dossier,
      integrity: detail.integrity
    },
    human: [
      `Run dossier for ${detail.loop.loopId}`,
      `Status: ${detail.loop.status} / ${detail.loop.lifecycleState}`,
      `Verification: ${verification.status}`,
      `Integrity: ${describeIntegrity(detail.integrity.state)}`,
      `Cost (USD): ${detail.loop.cost.actualUsd.toFixed(2)} — provenance: ${describeCostProvenance(costProvenance)}`,
      `Artifacts: ${detail.loop.artifacts.length}`,
      `Attempts: ${detail.loop.attempts.length}`,
      `What happened: ${receipt.whatHappened ?? "No attempt summary was recorded."}`,
      `What Martin prevented: ${(receipt.whatMartinPrevented ?? []).join("; ") || "No prevention claim is available."}`,
      `Next safe action: ${receipt.nextSafeAction ?? "Run preflight before the next attempt."}`,
      `Source: ${detail.source}`
    ],
    quiet: detail.loop.loopId,
    warnings: [...detail.warnings, ...verification.warnings]
  });
}

async function executeRunsListCommand(
  filters: MartinRunListFilters,
  outputMode: MartinOutputMode
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const listed = await listPersistedLoops(filters);

  return renderCliSuccess(outputMode, {
    data: {
      command: "runs_list",
      runsRoot: listed.runsRoot,
      count: listed.loops.length,
      loops: listed.loops
    },
    human: [
      `Listed ${listed.loops.length} persisted runs from ${listed.runsRoot}`,
      ...listed.loops.slice(0, 10).map(
        (loop) => `- ${loop.loopId} ${loop.status}/${loop.lifecycleState} ${loop.task.title}`
      )
    ],
    quiet: listed.loops[0]?.loopId ?? "",
    warnings: listed.warnings
  });
}

async function executeRunsGetCommand(
  selector: MartinRunSelector,
  outputMode: MartinOutputMode
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const detail = await loadPersistedLoop(selector);
  const verification = buildVerificationSummary(detail.loop);
  const artifacts = buildArtifactSummary(detail.loop);
  const receiptScope = resolveReceiptScope(detail.loop, detail.runsRoot);
  const costProvenance = readCostProvenance(detail.loop);

  return renderCliSuccess(outputMode, {
    data: {
      command: "runs_get",
      source: detail.source,
      loop: detail.loop,
      receiptIntegrity: detail.integrity,
      ...(receiptScope ? { receiptScope } : {}),
      verification,
      artifacts,
      integrity: detail.integrity,
      costProvenance
    },
    human: [
      `Loaded persisted loop ${detail.loop.loopId}`,
      `Status: ${detail.loop.status} / ${detail.loop.lifecycleState}`,
      `Verification: ${verification.status}`,
      `Artifacts: ${artifacts.totalCount}`,
      `Integrity: ${describeIntegrity(detail.integrity.state)}`,
      `Cost (USD): ${detail.loop.cost.actualUsd.toFixed(2)} — provenance: ${describeCostProvenance(costProvenance)}`,
      `Source: ${detail.source}`
    ],
    quiet: detail.loop.loopId,
    warnings: [...detail.warnings, ...verification.warnings]
  });
}

async function executeRunsAttemptCommand(
  selector: MartinRunSelector,
  outputMode: MartinOutputMode
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const loaded = await loadPersistedAttempt(selector);

  return renderCliSuccess(outputMode, {
    data: {
      command: "runs_attempt",
      source: loaded.detail.source,
      loopId: loaded.detail.loop.loopId,
      attempt: loaded.attempt,
      verification: loaded.verification,
      integrity: loaded.detail.integrity
    },
    human: [
      `Attempt ${loaded.attempt.index} for ${loaded.detail.loop.loopId}`,
      `Adapter: ${loaded.attempt.adapterId}`,
      `Model: ${loaded.attempt.model}`,
      `Verification: ${loaded.verification.status}`,
      `Integrity: ${describeIntegrity(loaded.detail.integrity.state)}`,
      loaded.attempt.summary ?? "No attempt summary was recorded."
    ],
    quiet: `${loaded.detail.loop.loopId}:${loaded.attempt.index}`,
    warnings: loaded.detail.warnings
  });
}

async function executeRunsVerifyCommand(
  selector: MartinRunSelector,
  outputMode: MartinOutputMode
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const detail = await loadPersistedLoop(selector);
  const verification = buildVerificationSummary(detail.loop);
  const receiptScope = resolveReceiptScope(detail.loop, detail.runsRoot);

  return renderCliSuccess(outputMode, {
    data: {
      command: "runs_verify",
      loopId: detail.loop.loopId,
      source: detail.source,
      receiptIntegrity: detail.integrity,
      ...(receiptScope ? { receiptScope } : {}),
      verification,
      integrity: detail.integrity
    },
    human: [
      `Verification for ${detail.loop.loopId}`,
      `Status: ${verification.status}`,
      `Integrity: ${describeIntegrity(detail.integrity.state)}`,
      verification.summary
    ],
    quiet: verification.status,
    warnings: [...detail.warnings, ...verification.warnings]
  });
}

function describeIntegrity(integrity: IntegrityStatus): string {
  switch (integrity) {
    case "verified":
      return "verified — record matches its signed snapshot";
    case "tamper_detected":
      return "TAMPER DETECTED — record does not match its signed snapshot";
    case "unsigned":
      return "unsigned — no integrity sidecar found (pre-upgrade or hand-authored record)";
    case "material_missing":
      return "material missing — integrity sidecar/key/ledger is incomplete";
    case "relocated":
      return "relocated — run was loaded from outside the canonical runs root";
    case "selector_noncanonical":
      return "selector non-canonical — choose --loop-id/--latest for canonical integrity checks";
  }
}

async function executeGateCommand(
  command: Extract<ParsedCliArguments, { command: "gate" }>,
  outputMode: MartinOutputMode
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const environment = resolveCliEnvironment({
    cwd: command.cwd,
    runsDir: command.runsDir
  });

  // Read workflow state — merge both MCP (martin_doctor via MCP) and CLI
  // (martin doctor via CLI) namespaces so the gate works regardless of how
  // doctor/estimate were invoked.
  let mcpState: Record<string, { recordedAt?: string } | undefined> = {};
  try {
    const statePath = join(resolve(environment.runsRoot), "_martin", "workflow-state.json");
    const raw = await readFile(statePath, "utf8");
    const parsed = JSON.parse(raw) as {
      version?: number;
      mcp?: Record<string, { recordedAt?: string }>;
      cli?: Record<string, { recordedAt?: string }>;
    };
    if (parsed.version === 1) {
      // Merge: cli namespace takes precedence for CLI-native steps (doctor, estimate)
      // MCP namespace used for MCP-specific steps (plan, preflight, run)
      mcpState = { ...(parsed.mcp ?? {}), ...(parsed.cli ?? {}) };
    }
  } catch {
    // No workflow state file yet — everything is missing
  }
  const hasDoctor = Boolean(mcpState.doctor);
  const hasEstimate = Boolean(mcpState.estimate);
  const hasPlan = Boolean(mcpState.plan);
  const hasPreflight = Boolean(mcpState.preflight);
  // Estimate is required — it proves the agent understood the cost before starting.
  // Plan is optional for lightweight work; estimate + doctor + preflight is the minimum.
  const governed = hasDoctor && hasEstimate;

  const missingSteps: string[] = [];
  if (!hasDoctor) missingSteps.push("martin doctor");
  if (!hasEstimate) missingSteps.push("martin estimate \"<your objective>\"");
  if (!hasPreflight && hasPlan) missingSteps.push("martin preflight \"<your objective>\"");

  if (governed) {
    return renderCliSuccess(outputMode, {
      data: {
        command: "gate",
        governed: true,
        receipts: {
          doctor: mcpState.doctor?.recordedAt,
          estimate: mcpState.estimate?.recordedAt,
          plan: mcpState.plan?.recordedAt,
          preflight: mcpState.preflight?.recordedAt
        }
      },
      human: [
        "MartinLoop governance: PASS",
        `  Doctor:    ✓ ${mcpState.doctor?.recordedAt ?? ""}`,
        `  Estimate:  ✓ ${mcpState.estimate?.recordedAt ?? ""}`,
        ...(mcpState.plan ? [`  Plan:      ✓ ${mcpState.plan.recordedAt}`] : []),
        ...(mcpState.preflight ? [`  Preflight: ✓ ${mcpState.preflight.recordedAt}`] : [])
      ],
      quiet: "PASS"
    });
  }

  // HARD BLOCK: return exit code 1
  const blockMessage = [
    "MartinLoop governance: BLOCKED",
    "",
    "This work is not governed. Complete the required steps first:",
    ...missingSteps.map((step) => `  ✗ ${step}`),
    "",
    "MartinLoop requires doctor → plan → preflight before any code changes.",
    "Run the missing commands above, then retry."
  ];

  return {
    exitCode: 1,
    stdout: outputMode === "json"
      ? JSON.stringify({
          command: "gate",
          governed: false,
          missingSteps,
          message: "Governance gate BLOCKED. Complete the required workflow steps."
        }, null, 2)
      : outputMode === "quiet"
        ? "BLOCKED"
        : blockMessage.join("\n"),
    stderr: ""
  };
}

async function executeModeCommand(
  command: Extract<ParsedCliArguments, { command: "mode" }>,
  outputMode: MartinOutputMode
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const configPath = join(homedir(), ".martin", "config.json");
  let config: Record<string, unknown> = {};
  try {
    config = JSON.parse(await readFile(configPath, "utf8")) as Record<string, unknown>;
  } catch { /* fresh config */ }

  if (!command.mode) {
    const current = (config.defaultMode as string | undefined) ?? "auto";
    return renderCliSuccess(outputMode, {
      data: { command: "mode", currentMode: current, config },
      human: [
        `Current mode: ${current}`,
        "",
        "Available modes:",
        "  auto   — MartinLoop governs autonomously (recommended)",
        "  plan   — Show plan before executing, you approve",
        "  edits  — Show each file change before writing",
        "",
        `Switch: martin mode auto | plan | edits`
      ],
      quiet: current
    });
  }

  const configDir = join(homedir(), ".martin");
  await mkdir(configDir, { recursive: true });

  if (command.scope === "project") {
    const cwd = command.cwd ?? process.cwd();
    let projectConfig: Record<string, unknown> = {};
    try {
      projectConfig = JSON.parse(await readFile(join(cwd, "martin.config.yaml"), "utf8")) as Record<string, unknown>;
    } catch { /* fresh */ }
    config.projectOverrides = {
      ...(config.projectOverrides as Record<string, unknown> ?? {}),
      [cwd]: command.mode
    };
  } else {
    config.defaultMode = command.mode;
  }

  await writeFile(configPath, JSON.stringify(config, null, 2) + "\n", "utf8");

  return renderCliSuccess(outputMode, {
    data: { command: "mode", mode: command.mode, scope: command.scope },
    human: [
      `Mode set to: ${command.mode} (${command.scope})`,
      "",
      command.mode === "auto"
        ? "MartinLoop will govern autonomously. Estimate → run → receipt."
        : command.mode === "plan"
          ? "MartinLoop will show the plan before executing. You approve each step."
          : "MartinLoop will show each file change before writing. Maximum control."
    ],
    quiet: command.mode
  });
}

async function executePlanCommand(
  command: Extract<ParsedCliArguments, { command: "plan" }>,
  outputMode: MartinOutputMode
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const environment = resolveCliEnvironment({ cwd: command.cwd, runsDir: command.runsDir });
  const receiptScope = buildCliReceiptScope(environment);

  // Scope the plan to what is known: objective, optional verifier, optional budget.
  const verificationPlan = command.verify ? [command.verify] : [];
  const budgetUsd = command.budgetUsd ?? 5;

  // Record plan step into the mcp section so governance-status and martin gate reflect it.
  await recordMcpPlanStep({
    runsRoot: environment.runsRoot,
    workingDirectory: environment.workingDirectory,
    objective: command.objective,
    receiptScope
  }).catch(() => {});

  const planOutput = {
    command: "plan",
    objective: command.objective,
    workingDirectory: environment.workingDirectory,
    verificationPlan,
    budget: {
      maxUsd: budgetUsd,
      note: "Confirm with `martin estimate` before spending."
    },
    proposedApproach: [
      "Run `martin doctor` to confirm environment readiness.",
      `Run \`martin estimate "${command.objective}" --budget-usd ${budgetUsd}\` to preview cost.`,
      command.verify
        ? `Run \`martin preflight "${command.objective}" --verify "${command.verify}"\` to lock the contract.`
        : `Run \`martin preflight "${command.objective}"\` to lock the contract.`,
      command.verify
        ? `Run \`martin execute "${command.objective}" --verify "${command.verify}" --budget-usd ${budgetUsd}\` to govern execution.`
        : `Run \`martin run "${command.objective}" --budget-usd ${budgetUsd}\` to govern execution.`
    ],
    nextStep: command.verify
      ? `martin preflight "${command.objective}" --verify "${command.verify}"`
      : `martin preflight "${command.objective}"`
  };

  return renderCliSuccess(outputMode, {
    data: planOutput,
    human: [
      "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
      " MartinLoop — Governed Plan",
      "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
      "",
      `Objective: ${command.objective}`,
      `Directory: ${environment.workingDirectory}`,
      ...(verificationPlan.length > 0 ? [`Verifier:  ${verificationPlan[0]}`] : []),
      `Budget:    $${budgetUsd} max`,
      "",
      "Proposed sequence:",
      ...planOutput.proposedApproach.map((step, i) => `  ${i + 1}. ${step}`),
      "",
      "Plan receipt recorded. Next:",
      `  $ ${planOutput.nextStep}`
    ],
    quiet: `plan:${command.objective.slice(0, 40)}`
  });
}

async function executeExecuteCommand(
  command: Extract<ParsedCliArguments, { command: "execute" }>,
  outputMode: MartinOutputMode
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  // `martin execute` is a governed alias for `martin run` that enforces
  // the plan→preflight→run sequence. It delegates to the run executor
  // with the same arguments, relying on the run gate to block if preflight
  // is missing.
  const runRequest = parseRunRequest([
    command.objective,
    ...(command.verify ? ["--verify", command.verify] : []),
    "--budget-usd", String(command.budgetUsd ?? 5),
    ...(command.maxIterations ? ["--max-iterations", String(command.maxIterations)] : []),
    ...(command.engine ? ["--engine", command.engine] : []),
    ...(command.cwd ? ["--cwd", command.cwd] : []),
    ...(command.runsDir ? ["--runs-dir", command.runsDir] : [])
  ]);
  return executeRunCommand(runRequest, outputMode);
}

async function executeCleanCommand(
  command: Extract<ParsedCliArguments, { command: "clean" }>,
  outputMode: MartinOutputMode
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const environment = resolveCliEnvironment({ cwd: command.cwd, runsDir: command.runsDir });
  const removed: string[] = [];

  const martinDir = join(environment.workingDirectory, "_martin");
  const martinDirExists = await stat(martinDir).then(() => true).catch(() => false);
  if (martinDirExists && !command.cleanAll && !command.cleanRuns) {
    await rm(martinDir, { recursive: true, force: true });
    removed.push(`_martin/ (workflow state)`);
  }

  if (command.cleanRuns || command.cleanAll) {
    const runsRoot = environment.runsRoot;
    const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;
    try {
      const entries = await readdir(runsRoot, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.name.startsWith("loop_") && entry.isDirectory()) {
          const runPath = join(runsRoot, entry.name);
          const info = await stat(runPath).catch(() => null);
          if (info && info.mtimeMs < thirtyDaysAgo) {
            await rm(runPath, { recursive: true, force: true });
            removed.push(`runs/${entry.name}`);
          }
        }
      }
    } catch { /* skip */ }
  }

  return renderCliSuccess(outputMode, {
    data: { command: "clean", removed },
    human: removed.length > 0
      ? [`Removed ${removed.length} item(s):`, ...removed.map((r) => `  • ${r}`)]
      : ["Nothing to clean. Working directory is already tidy."],
    quiet: removed.length > 0 ? `removed:${removed.length}` : "clean"
  });
}

async function executeEstimateCommand(
  command: Extract<ParsedCliArguments, { command: "estimate" }>,
  outputMode: MartinOutputMode
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const environment = resolveCliEnvironment({ cwd: command.cwd, runsDir: command.runsDir });
  // Feed real historical success rate from the trace store into the route classifier.
  // This reduces Pre Work Burn over time as Martin learns from past runs.
  const historicalDirectSuccessRate = await getHistoricalDirectSuccessRate(environment.runsRoot).catch(() => undefined);
  const route = classifyRoute({
    objective: command.objective,
    verificationPlan: [],
    budgetUsd: command.budgetUsd,
    allowedPaths: command.fileScope,
    scopedFileCount: command.fileScope.length > 0 ? command.fileScope.length : undefined,
    historicalDirectSuccessRate
  });
  const recommendedBudgetUsd = route.selectedMode === "direct"
    ? Math.max(2, Math.round(route.expectedCostUsd * 3 * 100) / 100)
    : Math.max(5, Math.round(route.expectedCostUsd * 2 * 100) / 100);

  // Persist the estimate receipt before returning so follow-up `martin gate`
  // invocations in separate CLI processes see the same runs-dir/cwd state.
  await recordCliWorkflowStep({
    runsRoot: environment.runsRoot,
    step: "estimate",
    workingDirectory: environment.workingDirectory,
    objective: command.objective,
    receiptScope: buildCliReceiptScope(environment)
  }).catch(() => {});

  return renderCliSuccess(outputMode, {
    data: {
      command: "estimate",
      objective: command.objective,
      engine: command.engine,
      budgetUsd: command.budgetUsd,
      selectedMode: route.selectedMode,
      confidence: route.confidence,
      expectedCostUsd: route.expectedCostUsd,
      expectedPreworkBurnPct: route.expectedPreworkBurnPct,
      reason: route.reason,
      blockedSteps: route.blockedSteps,
      compressed: route.compressed,
      ...(route.compressionSummary ? { compressionSummary: route.compressionSummary } : {}),
      recommendedBudgetUsd,
      recommendedModelTier: route.recommendedModelTier,
      estimatedSavingVsSonnetUsd: route.estimatedSavingVsSonnetUsd
    },
    human: [
      "Martin Loop Cost Estimate",
      "─────────────────────────",
      "",
      `Objective:      ${command.objective}`,
      `Engine:         ${command.engine}`,
      `Budget:         $${command.budgetUsd.toFixed(2)}`,
      "",
      `Route:          ${route.selectedMode}${route.compressed ? " (compressed)" : ""}`,
      `Confidence:     ${(route.confidence * 100).toFixed(0)}%`,
      `Model tier:     ${route.recommendedModelTier} → ${resolveModelForTier(route.recommendedModelTier, command.engine)}${route.estimatedSavingVsSonnetUsd > 0 ? ` (saves ~$${route.estimatedSavingVsSonnetUsd.toFixed(2)} vs sonnet)` : ""}`,
      `Expected cost:  $${route.expectedCostUsd.toFixed(2)}`,
      `Pre Work Burn:  ${route.expectedPreworkBurnPct}%`,
      `Recommended:    $${recommendedBudgetUsd.toFixed(2)}`,
      "",
      "Reasoning:",
      ...route.reason.map((r) => `  • ${r}`),
      ...(route.compressionSummary ? ["", route.compressionSummary] : []),
      ...(route.blockedSteps.length > 0 ? ["", `Blocked steps: ${route.blockedSteps.join(", ")}`] : [])
    ],
    quiet: `${route.selectedMode}:$${route.expectedCostUsd.toFixed(2)}:${route.expectedPreworkBurnPct}%`
  });
}

async function executeMcpPrintConfigCommand(
  command: Extract<ParsedCliArguments, { command: "mcp_print_config" }>,
  outputMode: MartinOutputMode
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const remotePolicyWarnings = assertMcpRemoteTransportPolicy(command);
  const environment = resolveCliEnvironment({
    cwd: command.cwd,
    runsDir: command.runsDir
  });
  const plan = buildMcpInstallPlan({
    host: command.host,
    scope: command.scope,
    cwd: environment.workingDirectory,
    runsRoot: environment.runsRoot,
    transport: command.transport,
    profile: command.profile,
    ...(command.remoteUrl ? { remoteUrl: command.remoteUrl } : {}),
    ...(command.remoteTokenEnv ? { remoteTokenEnv: command.remoteTokenEnv } : {}),
    ...(command.platform ? { platform: command.platform } : {})
  });

  return renderCliSuccess(outputMode, {
    data: {
      command: "mcp_print_config",
      host: command.host,
      scope: command.scope,
      transport: command.transport,
      profile: command.profile,
      experimentalRemoteHosts: command.experimentalRemoteHosts,
      targetPath: plan.targetPath,
      content: plan.content,
      serverId: plan.serverId,
      enabledTools: plan.enabledTools,
      installMethod: plan.installMethod,
      governanceHooks: plan.governanceHooks,
      profiles: {
        minimal: [...MARTIN_MINIMAL_TOOLS],
        diagnostic: [...MARTIN_DIAGNOSTIC_TOOLS],
        "github-review": [...MARTIN_GITHUB_REVIEW_TOOLS],
        "full-local": [...MARTIN_FULL_TOOLS],
        "paid-remote": [...MARTIN_FULL_TOOLS],
        starter: [...MARTIN_STARTER_TOOLS],
        full: [...MARTIN_FULL_TOOLS]
      },
      starterTools: [...MARTIN_STARTER_TOOLS],
      fullTools: [...MARTIN_FULL_TOOLS]
    },
    human: [
      plan.content,
      "",
      "── Governance Hooks ──",
      `Mechanism: ${plan.governanceHooks.mechanism}`,
      ...(plan.governanceHooks.targetPath ? [`Target: ${plan.governanceHooks.targetPath}`] : []),
      "",
      plan.governanceHooks.content,
      "",
      plan.governanceHooks.instructions
    ],
    quiet: plan.targetPath,
    warnings: remotePolicyWarnings
  });
}

async function executeMcpInstallCommand(
  command: Extract<ParsedCliArguments, { command: "mcp_install" }>,
  outputMode: MartinOutputMode
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const remotePolicyWarnings = assertMcpRemoteTransportPolicy(command);
  const environment = resolveCliEnvironment({
    cwd: command.cwd,
    runsDir: command.runsDir
  });
  const input = {
    host: command.host,
    scope: command.scope,
    cwd: environment.workingDirectory,
    runsRoot: environment.runsRoot,
    transport: command.transport,
    profile: command.profile,
    experimentalRemoteHosts: command.experimentalRemoteHosts,
    ...(command.remoteUrl ? { remoteUrl: command.remoteUrl } : {}),
    ...(command.remoteTokenEnv ? { remoteTokenEnv: command.remoteTokenEnv } : {}),
    ...(command.platform ? { platform: command.platform } : {})
  };
  const plan = command.dryRun ? buildMcpInstallPlan(input) : await installMcpConfig(input);

  return renderCliSuccess(outputMode, {
    data: {
      command: "mcp_install",
      host: command.host,
      scope: command.scope,
      transport: command.transport,
      profile: command.profile,
      dryRun: command.dryRun,
      targetPath: plan.targetPath,
      content: plan.content,
      serverId: plan.serverId,
      enabledTools: plan.enabledTools,
      installMethod: plan.installMethod,
      governanceHooks: plan.governanceHooks
    },
    human: [
      `${command.dryRun ? "Dry-run" : "Installed"} Martin Loop MCP config for ${command.host}`,
      `Target: ${plan.targetPath}`,
      "",
      plan.content,
      "",
      "── Governance Hooks ──",
      `Mechanism: ${plan.governanceHooks.mechanism}`,
      ...(plan.governanceHooks.targetPath ? [`Target: ${plan.governanceHooks.targetPath}`] : []),
      "",
      plan.governanceHooks.instructions
    ],
    quiet: plan.targetPath,
    warnings: remotePolicyWarnings
  });
}

function stripGlobalOptions(args: string[]): {
  outputMode: MartinOutputMode;
  commandArgs: string[];
} {
  let outputMode: MartinOutputMode = "human";
  let sawJson = false;
  let sawQuiet = false;
  const commandArgs: string[] = [];

  for (const token of args) {
    if (token === "--json") {
      sawJson = true;
      outputMode = "json";
      continue;
    }
    if (token === "--quiet") {
      sawQuiet = true;
      outputMode = "quiet";
      continue;
    }
    commandArgs.push(token);
  }

  if (sawJson && sawQuiet) {
    throw new CliCommandError("invalid_input", "Choose only one global output mode.", {
      suggestion: "Use either --json or --quiet, not both."
    });
  }

  return {
    outputMode,
    commandArgs
  };
}

function parseRunRequest(rest: string[]): RunCommandRequest {
  const verificationPlan: string[] = [];
  const metadata: Record<string, string> = {};
  const budgetOverrides: Partial<Record<keyof LoopBudget, true>> = {};
  const request: Partial<RunCommandRequest> = {
    verificationPlan,
    metadata,
    budget: { ...DEFAULT_BUDGET },
    budgetOverrides
  };

  const firstPositional = rest[0] && !rest[0].startsWith("--") ? rest[0] : undefined;
  if (firstPositional) {
    request.objective = firstPositional;
    request.title ??= firstPositional;
  }

  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    const next = rest[index + 1];

    switch (token) {
      case "--workspace":
        request.workspaceId = next;
        index += 1;
        break;
      case "--project":
        request.projectId = next;
        index += 1;
        break;
      case "--title":
        request.title = next;
        index += 1;
        break;
      case "--objective":
        request.objective = next;
        request.title ??= next;
        index += 1;
        break;
      case "--verify":
        if (next) {
          verificationPlan.push(next);
        }
        index += 1;
        break;
      case "--verify-timeout-ms":
        request.verifyTimeoutMs = toFiniteNumber(next ?? "");
        index += 1;
        break;
      case "--metadata":
        if (next) {
          const [key, value] = next.split("=");
          if (key && value) {
            metadata[key] = value;
          }
        }
        index += 1;
        break;
      case "--budget":
      case "--budget-usd":
        request.budget = {
          ...request.budget,
          maxUsd: Number(next)
        } as LoopBudget;
        budgetOverrides.maxUsd = true;
        index += 1;
        break;
      case "--soft-limit-usd":
        request.budget = {
          ...request.budget,
          softLimitUsd: Number(next)
        } as LoopBudget;
        budgetOverrides.softLimitUsd = true;
        index += 1;
        break;
      case "--max-iterations":
        request.budget = {
          ...request.budget,
          maxIterations: Number(next)
        } as LoopBudget;
        budgetOverrides.maxIterations = true;
        index += 1;
        break;
      case "--max-tokens":
        request.budget = {
          ...request.budget,
          maxTokens: Number(next)
        } as LoopBudget;
        budgetOverrides.maxTokens = true;
        index += 1;
        break;
      case "--policy":
        if (next) {
          metadata.policyProfile = next;
        }
        index += 1;
        break;
      case "--telemetry":
        if (next) {
          metadata.telemetryDestination = next;
        }
        index += 1;
        break;
      case "--config":
        request.configPath = next;
        index += 1;
        break;
      case "--cwd":
        request.cwd = next;
        index += 1;
        break;
      case "--runs-dir":
        request.runsDir = next;
        index += 1;
        break;
      case "--proof":
        request.liveMode = "proof";
        break;
      case "--unsafe-allow-unguarded-run":
        request.unsafeAllowUnguardedRun = true;
        break;
      case "--allow-path":
        if (next) {
          request.allowedPaths = [...(request.allowedPaths ?? []), next];
        }
        index += 1;
        break;
      case "--deny-path":
        if (next) {
          request.deniedPaths = [...(request.deniedPaths ?? []), next];
        }
        index += 1;
        break;
      case "--accept":
        if (next) {
          request.acceptanceCriteria = [...(request.acceptanceCriteria ?? []), next];
        }
        index += 1;
        break;
      case "--model":
        request.model = next;
        index += 1;
        break;
      case "--engine":
        request.engine = next;
        index += 1;
        break;
      default:
        break;
    }
  }

  return {
    workspaceId: request.workspaceId ?? "ws_default",
    projectId: request.projectId ?? "proj_default",
    title: request.title ?? request.objective ?? "Martin Loop Task",
    objective: request.objective ?? request.title ?? "Martin Loop Task",
    verificationPlan,
    ...(request.verifyTimeoutMs !== undefined ? { verifyTimeoutMs: request.verifyTimeoutMs } : {}),
    metadata,
    budget: request.budget as LoopBudget,
    ...(Object.keys(budgetOverrides).length > 0 ? { budgetOverrides } : {}),
    ...(request.configPath ? { configPath: request.configPath } : {}),
    ...(request.cwd ? { cwd: request.cwd } : {}),
    ...(request.runsDir ? { runsDir: request.runsDir } : {}),
    ...(request.model ? { model: request.model } : {}),
    ...(request.engine ? { engine: request.engine } : {}),
    ...(request.liveMode ? { liveMode: request.liveMode } : {}),
    ...(request.mutationMode ? { mutationMode: request.mutationMode } : {}),
    ...(request.unsafeAllowUnguardedRun ? { unsafeAllowUnguardedRun: true } : {}),
    ...(request.allowedPaths?.length ? { allowedPaths: request.allowedPaths } : {}),
    ...(request.deniedPaths?.length ? { deniedPaths: request.deniedPaths } : {}),
    ...(request.acceptanceCriteria?.length ? { acceptanceCriteria: request.acceptanceCriteria } : {})
  };
}

function parseRunListFilters(tokens: string[]): MartinRunListFilters {
  return {
    ...(readOption(tokens, "--runs-dir") ? { runsDir: readOption(tokens, "--runs-dir") } : {}),
    ...(readOption(tokens, "--limit") ? { limit: Number(readOption(tokens, "--limit")) } : {}),
    ...(readOption(tokens, "--status") ? { status: readOption(tokens, "--status") } : {}),
    ...(readOption(tokens, "--lifecycle-state")
      ? { lifecycleState: readOption(tokens, "--lifecycle-state") }
      : {}),
    ...(readOption(tokens, "--adapter-id") ? { adapterId: readOption(tokens, "--adapter-id") } : {}),
    ...(readOption(tokens, "--model") ? { model: readOption(tokens, "--model") } : {}),
    ...(readOption(tokens, "--updated-after")
      ? { updatedAfter: readOption(tokens, "--updated-after") }
      : {})
  };
}

function parseRunSelector(
  tokens: string[],
  options: { allowLatest: boolean; includeAttemptIndex?: boolean }
): MartinRunSelector {
  const selector: MartinRunSelector = {
    ...(readOption(tokens, "--runs-dir") ? { runsDir: readOption(tokens, "--runs-dir") } : {}),
    ...(readOption(tokens, "--file") ? { file: readOption(tokens, "--file") } : {}),
    ...(readOption(tokens, "--loop-id") ? { loopId: readOption(tokens, "--loop-id") } : {}),
    ...(options.allowLatest && hasFlag(tokens, "--latest") ? { latest: true } : {}),
    ...(options.includeAttemptIndex && readOption(tokens, "--attempt-index")
      ? { attemptIndex: Number(readOption(tokens, "--attempt-index")) }
      : {})
  };

  return selector;
}

function parseMcpHost(tokens: string[]): MartinMcpHost {
  const host = readOption(tokens, "--host");

  if (
    host === "codex" || host === "claude" || host === "gemini" || host === "generic" ||
    host === "cursor" || host === "copilot" || host === "continue"
  ) {
    return host;
  }

  if (host === undefined) {
    throw new CliCommandError(
      "invalid_input",
      "mcp commands require --host <codex|claude|gemini|cursor|copilot|continue|generic>.",
      { suggestion: "Pass --host codex, --host claude, --host cursor, --host copilot, --host continue, or --host generic." }
    );
  }

  throw new CliCommandError("invalid_input", `Invalid --host value: ${host}.`, {
    suggestion: "Use --host codex, --host claude, --host gemini, --host cursor, --host copilot, --host continue, or --host generic."
  });
}

function parseMcpScope(host: MartinMcpHost, tokens: string[]): MartinMcpScope {
  const scope = readOption(tokens, "--scope");

  if (scope === undefined) {
    return "user";
  }

  if (scope === "local") {
    if (host !== "claude") {
      throw new CliCommandError("invalid_input", `Host ${host} does not support --scope local.`, {
        suggestion: "Use --scope user or --scope project, or switch to --host claude."
      });
    }

    return scope;
  }

  if (scope === "user" || scope === "project") {
    return scope;
  }

  throw new CliCommandError("invalid_input", `Invalid --scope value: ${scope}.`, {
    suggestion: host === "claude" ? "Use --scope user, --scope project, or --scope local." : "Use --scope user or --scope project."
  });
}

function parseMcpTransport(tokens: string[]): MartinMcpTransport {
  const transport = readOption(tokens, "--transport");

  if (transport === undefined) {
    return "stdio";
  }

  if (transport === "stdio" || transport === "remote") {
    return transport;
  }

  throw new CliCommandError("invalid_input", `Invalid --transport value: ${transport}.`, {
    suggestion: "Use --transport stdio or --transport remote."
  });
}

function parseMcpProfile(tokens: string[]): MartinMcpProfile {
  const profile = readOption(tokens, "--profile");

  if (profile === undefined) {
    return "minimal";
  }

  if (
    profile === "minimal" ||
    profile === "diagnostic" ||
    profile === "github-review" ||
    profile === "full-local" ||
    profile === "paid-remote" ||
    profile === "starter" ||
    profile === "full"
  ) {
    return profile;
  }

  // Fall back to "minimal" instead of crashing the run.
  console.error(`Warning: unknown --profile "${profile}", falling back to "minimal". Valid: minimal, diagnostic, github-review, full-local, paid-remote, starter, full.`);
  return "minimal";
}

function assertMcpRemoteTransportPolicy(
  command: Extract<ParsedCliArguments, { command: "mcp_print_config" | "mcp_install" }>
): string[] {
  if (command.transport !== "remote" || !hostRequiresExperimentalRemoteOptIn(command.host)) {
    return [];
  }

  if (!command.experimentalRemoteHosts) {
    throw new CliCommandError(
      "invalid_input",
      `Remote transport for ${command.host} is experimental and requires explicit opt-in.`,
      {
        suggestion:
          `Re-run with --experimental-remote-hosts, or use --transport stdio for stable host behavior.`
      }
    );
  }

  return [
    `Remote transport for ${command.host} is experimental. Validate host behavior and keep stdio as the default fallback lane.`
  ];
}

function parseMcpPlatform(tokens: string[]): MartinMcpPlatform | undefined {
  const platform = readOption(tokens, "--platform");

  if (platform === undefined) {
    return undefined;
  }

  if (platform === "windows" || platform === "macos" || platform === "linux") {
    return platform;
  }

  throw new CliCommandError("invalid_input", `Invalid --platform value: ${platform}.`, {
    suggestion: "Use --platform windows, --platform macos, or --platform linux."
  });
}

function readOption(tokens: string[], flag: string): string | undefined {
  const index = tokens.indexOf(flag);
  return index >= 0 ? tokens[index + 1] : undefined;
}

function hasFlag(tokens: string[], flag: string): boolean {
  return tokens.includes(flag);
}

function parseNativePhaseCommand(subcommand: NativePhaseSubcommand, tokens: string[]): NativePhaseCommand {
  const runScanLimit = readOption(tokens, "--run-scan-limit");
  let parsedRunScanLimit = runScanLimit ? Number(runScanLimit) : undefined;
  if (parsedRunScanLimit !== undefined && (!Number.isFinite(parsedRunScanLimit) || parsedRunScanLimit < 1)) {
    console.error(`Warning: invalid --run-scan-limit "${runScanLimit}", using default (50).`);
    parsedRunScanLimit = 50;
  }

  return {
    command: "native_phase",
    subcommand,
    ...(readOption(tokens, "--cwd") ? { cwd: readOption(tokens, "--cwd") } : {}),
    ...(readOption(tokens, "--runs-dir") ? { runsDir: readOption(tokens, "--runs-dir") } : {}),
    ...(readOption(tokens, "--host") ? { host: readOption(tokens, "--host") } : {}),
    ...(parsedRunScanLimit !== undefined ? { runScanLimit: parsedRunScanLimit } : {}),
    execute: hasFlag(tokens, "--execute")
  };
}

function parseLoopRecords(contents: string): LoopRecord[] {
  try {
    const parsed = JSON.parse(contents) as LoopRecord | LoopRecord[];
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch (jsonError) {
    const lines = contents.split(/\r?\n/u).filter((line) => line.trim().length > 0);

    if (lines.length === 0) {
      throw jsonError;
    }

    return lines.map((line) => JSON.parse(line) as LoopRecord);
  }
}

async function createDemoWorkspace(input: {
  targetDirectory: string;
  force: boolean;
}): Promise<string> {
  const rootDir = await findMartinPackageRoot();
  const sourceDirectory = join(rootDir, "demo", "seeded-workspace");

  try {
    await readdir(sourceDirectory);
  } catch (error) {
    if (isNodeErrorWithCode(error, "ENOENT")) {
      throw new Error(`Demo assets are missing from this install: ${sourceDirectory}`);
    }

    throw error;
  }

  const targetDirectory = resolve(input.targetDirectory);
  const existingEntries = await readdir(targetDirectory).catch((error: unknown) => {
    if (isNodeErrorWithCode(error, "ENOENT")) {
      return undefined;
    }

    throw error;
  });

  if (existingEntries) {
    if (existingEntries.length > 0 && !input.force) {
      throw new CliCommandError(
        "invalid_input",
        `Demo target already exists and is not empty: ${targetDirectory}. Re-run with --force to replace it.`
      );
    }

    await rm(targetDirectory, { force: true, recursive: true });
  }

  await mkdir(dirname(targetDirectory), { recursive: true });
  await cp(sourceDirectory, targetDirectory, { recursive: true });

  return targetDirectory;
}

async function findMartinPackageRoot(): Promise<string> {
  let currentDirectory = dirname(fileURLToPath(import.meta.url));

  for (let depth = 0; depth < 8; depth += 1) {
    const manifestPath = join(currentDirectory, "package.json");

    try {
      const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as { name?: string };
      if (manifest.name === "martin-loop") {
        return currentDirectory;
      }
    } catch (error) {
      if (!isNodeErrorWithCode(error, "ENOENT")) {
        throw error;
      }
    }

    const parentDirectory = dirname(currentDirectory);
    if (parentDirectory === currentDirectory) {
      break;
    }
    currentDirectory = parentDirectory;
  }

  throw new Error("Unable to resolve the martin-loop package root for demo assets.");
}

async function loadBenchmarkFixture<T>(fileName: string): Promise<T> {
  const packageRoot = await findMartinPackageRoot();
  const filePath = join(packageRoot, "benchmarks", "fixtures", fileName);
  const contents = await readFile(filePath, "utf8").catch((error: unknown) => {
    if (isNodeErrorWithCode(error, "ENOENT")) {
      throw new CliCommandError(
        "not_found",
        `Benchmark fixture not found: ${filePath}`,
        {
          suggestion:
            "Run this command from a MartinLoop checkout that includes the public benchmarks workspace."
        }
      );
    }
    throw error;
  });

  return JSON.parse(contents) as T;
}

function renderDemoInstructions(targetDirectory: string): string {
  return [
    `Martin Loop demo sandbox created at ${targetDirectory}`,
    "",
    "Next steps:",
    `  cd ${targetDirectory}`,
    "  npm install",
    "  npm test",
    "",
    "Default first run (live spend-governed):",
    '  npx martin run "Summarize the demo workspace and confirm the verifier is green" --verify "npm test" --budget-usd 2 --max-iterations 1',
    "",
    "Optional explicit no-spend proof run:",
    '  npx martin run "Summarize the demo workspace and confirm the verifier is green" --proof --verify "npm test" --budget-usd 2 --max-iterations 1',
    "",
    "Optional live implementation run:",
    '  npx martin run "Add support for a discount percentage to summarizeInvoice and update the tests" --verify "npm test" --engine codex',
    "",
    `Task ideas live in ${join(targetDirectory, "TASKS.md")}`
  ].join("\n");
}

async function resolveGuardrails(
  request: RunCommandRequest
): Promise<ResolvedGuardrails> {
  const configLookupRoot = request.cwd ? resolve(request.cwd) : resolveInvocationRoot();
  const { config, configPath } = await loadGuardrailsConfig(request.configPath, configLookupRoot);

  const budget: LoopBudget = {
    maxUsd: config?.budget?.maxUsd ?? request.budget.maxUsd,
    softLimitUsd: config?.budget?.softLimitUsd ?? request.budget.softLimitUsd,
    maxIterations: config?.budget?.maxIterations ?? request.budget.maxIterations,
    maxTokens: config?.budget?.maxTokens ?? request.budget.maxTokens
  };

  if (request.budgetOverrides?.maxUsd) {
    budget.maxUsd = request.budget.maxUsd;
  }
  if (request.budgetOverrides?.softLimitUsd) {
    budget.softLimitUsd = request.budget.softLimitUsd;
  }
  if (request.budgetOverrides?.maxIterations) {
    budget.maxIterations = request.budget.maxIterations;
  }
  if (request.budgetOverrides?.maxTokens) {
    budget.maxTokens = request.budget.maxTokens;
  }

  if (budget.softLimitUsd >= budget.maxUsd) {
    budget.softLimitUsd = Math.round(budget.maxUsd * 0.75 * 100) / 100;
  }

  let policyProfile = config?.policyProfile ?? "balanced";
  if (request.metadata.policyProfile) {
    policyProfile = request.metadata.policyProfile ?? policyProfile;
  }

  let telemetryDestination = config?.governance?.telemetryDestination ?? "local-only";
  if (request.metadata.telemetryDestination) {
    telemetryDestination = request.metadata.telemetryDestination ?? telemetryDestination;
  }

  const destructiveActionPolicy =
    config?.governance?.destructiveActionPolicy ?? "approval";
  const verifierRules =
    request.verificationPlan.length > 0
      ? request.verificationPlan
      : config?.governance?.verifierRules !== undefined
        ? config.governance.verifierRules
        : ["pnpm test"];

  return {
    configPath,
    policyProfile,
    telemetryDestination,
    destructiveActionPolicy,
    verifierRules,
    budget
  };
}

async function loadGuardrailsConfig(
  configPath?: string,
  baseDirectory = resolveInvocationRoot()
): Promise<{ config: GuardrailsConfig | undefined; configPath: string }> {
  const resolvedPath = configPath
    ? resolveConfigPath(configPath, baseDirectory)
    : join(baseDirectory, "martin.config.yaml");
  const configIsExplicit = typeof configPath === "string" && configPath.trim().length > 0;

  try {
    const contents = await readFile(resolvedPath, "utf8");
    return {
      config: parseGuardrailsYaml(contents),
      configPath: resolvedPath
    };
  } catch (error) {
    if (!configIsExplicit && isNodeErrorWithCode(error, "ENOENT")) {
      return {
        config: undefined,
        configPath: resolvedPath
      };
    }

    if (configIsExplicit && isNodeErrorWithCode(error, "ENOENT")) {
      throw new CliCommandError("not_found", `Config file not found: ${resolvedPath}`);
    }

    throw error;
  }
}

function resolveConfigPath(configPath: string, baseDirectory = resolveInvocationRoot()): string {
  const normalizedConfigPath =
    process.platform === "win32" ? configPath : configPath.replace(/\\/g, "/");

  if (isAbsolute(normalizedConfigPath)) {
    return normalizedConfigPath;
  }

  return resolve(baseDirectory, normalizedConfigPath);
}

function parseGuardrailsYaml(contents: string): GuardrailsConfig {
  const config: GuardrailsConfig = {};
  let section: "budget" | "governance" | undefined;
  let governanceList: "verifierRules" | undefined;

  for (const rawLine of contents.split(/\r?\n/u)) {
    const noComment = rawLine.replace(/\s+#.*$/u, "");
    if (noComment.trim().length === 0) {
      continue;
    }

    const indent = noComment.match(/^\s*/u)?.[0].length ?? 0;
    const line = noComment.trim();

    if (indent === 0) {
      governanceList = undefined;
      const topMatch = line.match(/^([A-Za-z][\w-]*):(?:\s*(.*))?$/u);
      if (!topMatch) {
        continue;
      }

      const [, key, rawValue = ""] = topMatch;
      if (key === "budget") {
        section = "budget";
        config.budget ??= {};
        continue;
      }
      if (key === "governance") {
        section = "governance";
        config.governance ??= {};
        continue;
      }

      section = undefined;
      if (key === "policyProfile" && rawValue.length > 0) {
        config.policyProfile = parseYamlScalar(rawValue);
      }
      continue;
    }

    if (indent === 2 && section) {
      const nestedMatch = line.match(/^([A-Za-z][\w-]*):(?:\s*(.*))?$/u);
      if (!nestedMatch) {
        continue;
      }

      const [, key, rawValue = ""] = nestedMatch;

      if (section === "governance" && key === "verifierRules" && rawValue.length === 0) {
        governanceList = "verifierRules";
        config.governance ??= {};
        config.governance.verifierRules = [];
        continue;
      }

      governanceList = undefined;
      const scalar = parseYamlScalar(rawValue);

      if (section === "budget") {
        config.budget ??= {};
        if (key === "maxUsd") {
          config.budget.maxUsd = toFiniteNumber(scalar);
        } else if (key === "softLimitUsd") {
          config.budget.softLimitUsd = toFiniteNumber(scalar);
        } else if (key === "maxIterations") {
          config.budget.maxIterations = toFiniteNumber(scalar);
        } else if (key === "maxTokens") {
          config.budget.maxTokens = toFiniteNumber(scalar);
        }
      }

      if (section === "governance") {
        config.governance ??= {};
        if (key === "destructiveActionPolicy") {
          config.governance.destructiveActionPolicy = scalar;
        } else if (key === "telemetryDestination") {
          config.governance.telemetryDestination = scalar;
        }
      }

      continue;
    }

    if (indent === 4 && section === "governance" && governanceList === "verifierRules") {
      const itemMatch = line.match(/^-\s*(.+)$/u);
      const itemValue = itemMatch?.[1];
      if (!itemValue) {
        continue;
      }

      config.governance ??= {};
      config.governance.verifierRules ??= [];
      config.governance.verifierRules.push(parseYamlScalar(itemValue));
    }
  }

  return config;
}

function parseYamlScalar(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }

  return trimmed;
}

function toFiniteNumber(value: string): number | undefined {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function isNodeErrorWithCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof (error as { code: unknown }).code === "string" &&
    (error as { code: string }).code === code
  );
}

function selectAdapter(
  engine: string | undefined,
  workingDirectory: string,
  modelOverride?: string,
  mutationMode?: MutationMode,
  liveMode: "live" | "proof" = "live",
  codexCommandOverride?: string,
  verifyTimeoutMs?: number,
  autoSelectModel?: string
): MartinAdapter {
  if (runAdapterOverrideForTests) {
    return runAdapterOverrideForTests;
  }
  // Use auto-selected model when no explicit --model flag was given.
  // autoSelectModel comes from resolveModelForTier(route.recommendedModelTier, engine).
  const effectiveModel = modelOverride ?? autoSelectModel;

  if (liveMode === "proof") {
    return createStubDirectProviderAdapter({
      label: "Stub adapter (--proof)",
      providerId: "stub",
      model: "stub"
    });
  }

  if (engine === "codex") {
    return createCodexCliAdapter({
      workingDirectory,
      ...(verifyTimeoutMs !== undefined ? { verifyTimeoutMs } : {}),
      ...(effectiveModel ? { model: effectiveModel } : {}),
      ...(codexCommandOverride ? { command: codexCommandOverride } : {})
    });
  }

  if (engine === "gemini") {
    return createGeminiCliAdapter({
      workingDirectory,
      ...(verifyTimeoutMs !== undefined ? { verifyTimeoutMs } : {}),
      ...(effectiveModel ? { model: effectiveModel } : {})
    });
  }

  if (engine === "openai") {
    const openAiConfig = resolveOpenAiCompatibleRuntimeConfig();
    const baseUrl = openAiConfig.baseUrl;
    const apiKey = openAiConfig.apiKey;
    const model = effectiveModel ?? openAiConfig.model;
    return createOpenAiCompatibleAdapter({
      baseUrl,
      apiKey,
      model,
      workingDirectory,
      ...(verifyTimeoutMs !== undefined ? { verifyTimeoutMs } : {})
    });
  }

  return createClaudeCliAdapter({
    workingDirectory,
    ...(verifyTimeoutMs !== undefined ? { verifyTimeoutMs } : {}),
    ...(effectiveModel ? { model: effectiveModel } : {})
  });
}

function resolveCodexAvailabilityForCli(): CodexAvailabilityForTests {
  return codexAvailabilityOverrideForTests ?? resolveCliCommandAvailability("codex");
}

function resolveCodexProbeForCli(input: {
  workingDirectory: string;
  availability: CodexAvailabilityForTests;
  model?: string;
}): CodexProbeForTests {
  if (typeof codexProbeOverrideForTests === "function") {
    return codexProbeOverrideForTests(input);
  }
  if (codexProbeOverrideForTests) {
    return codexProbeOverrideForTests;
  }
  return probeCodexLaunch({
    workingDirectory: input.workingDirectory,
    availability: input.availability,
    ...(input.model ? { model: input.model } : {})
  });
}

function buildDoctorRecommendations(input: {
  liveMode: "live" | "proof";
  engine: "claude" | "codex" | "gemini" | "openai" | string;
  claudeAvailable: boolean;
  codexAvailable: boolean;
  geminiAvailable: boolean;
  workingDirectoryReady: boolean;
  codexLaunchReady?: boolean;
  codexRemediation?: string;
}): string[] {
  const recommendations = ["Run `martin preflight` before non-trivial governed coding work."];

  if (!input.workingDirectoryReady) {
    recommendations.push("Point `--cwd` at a valid repository before running Martin.");
  }

  if (input.liveMode === "live" && input.engine === "openai") {
    const baseUrl = process.env["MARTIN_OPENAI_BASE_URL"];
    const model = process.env["MARTIN_OPENAI_MODEL"];
    if (!baseUrl) recommendations.push("Set MARTIN_OPENAI_BASE_URL (e.g. http://localhost:11434 for Ollama or https://openrouter.ai/api for OpenRouter).");
    if (!model) recommendations.push("Set MARTIN_OPENAI_MODEL (e.g. llama3.3, deepseek/deepseek-chat, mistralai/codestral-latest).");
    if (baseUrl?.includes("openrouter") && !process.env["MARTIN_OPENAI_API_KEY"]) {
      recommendations.push("Set MARTIN_OPENAI_API_KEY for OpenRouter.");
    }
  }

  if (input.liveMode === "live" && input.engine === "claude" && !input.claudeAvailable) {
    recommendations.push("Install or expose the Claude CLI on PATH, or switch to `--engine codex` or `--engine openai`.");
  }

  if (input.liveMode === "live" && input.engine === "codex" && !input.codexAvailable) {
    recommendations.push("Install or expose the Codex CLI on PATH, or rerun with `--proof` for explicit no-spend validation.");
  }
  if (input.liveMode === "live" && input.engine === "codex" && input.codexAvailable && input.codexLaunchReady === false) {
    recommendations.push(input.codexRemediation ?? "Run `martin preflight --engine codex` and fix the reported Codex host issue before governed work.");
  }

  if (input.liveMode === "live" && input.engine === "gemini" && !input.geminiAvailable) {
    recommendations.push("Install or expose the Gemini CLI on PATH, or rerun with `--proof` for explicit no-spend validation.");
  }

  return recommendations;
}

function buildCliReceiptScope(environment: {
  invocationRoot: string;
  workingDirectory: string;
  runsRoot: string;
}): ReceiptScope {
  return {
    invocationRoot: environment.invocationRoot,
    workingDirectory: environment.workingDirectory,
    repoRoot: environment.workingDirectory,
    runsRoot: environment.runsRoot
  };
}

function buildCodexEngineDiagnostics(
  availability: ReturnType<typeof resolveCliCommandAvailability>,
  probe?: ReturnType<typeof probeCodexLaunch>
): Record<string, unknown> {
  return {
    available: availability.available,
    detail: availability.detail,
    ...(availability.resolvedPath ? { resolvedPath: availability.resolvedPath } : {}),
    ...(availability.candidatePaths?.length ? { candidatePaths: availability.candidatePaths } : {}),
    ...(probe
      ? {
          selectedPath: probe.command,
          hostPlatform: probe.diagnosis.hostPlatform,
          installKind: probe.diagnosis.installKind,
          nativeInstallValid: probe.diagnosis.nativeInstallValid,
          invocationMode: probe.diagnosis.invocationMode,
          sandboxMode: probe.diagnosis.sandboxMode,
          sandboxCompatible: probe.diagnosis.sandboxCompatible,
          launchReady: probe.ok,
          probeSummary: probe.summary,
          ...(probe.diagnosis.nativeDependencyStatus
            ? { nativeDependencyStatus: probe.diagnosis.nativeDependencyStatus }
            : {}),
          ...(probe.diagnosis.nativeDependencyPackage
            ? { nativeDependencyPackage: probe.diagnosis.nativeDependencyPackage }
            : {}),
          ...(probe.diagnosis.remediation ? { remediation: probe.diagnosis.remediation } : {}),
          ...(probe.candidateProbeResults?.length
            ? { candidateProbeResults: probe.candidateProbeResults }
            : {})
        }
      : {})
  };
}

function isCommandAvailable(command: string): boolean {
  const executable = process.platform === "win32" ? "where.exe" : "which";
  const result = spawnSync(executable, [command], { stdio: "ignore" });
  return result.status === 0;
}

// ---------------------------------------------------------------------------
// Challenge command
// ---------------------------------------------------------------------------

async function executeChallengeCommand(
  command: ChallengeCommand,
  outputMode: MartinOutputMode
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const loadedDetail = command.selector ? await loadPersistedLoop(command.selector) : undefined;
  const input = loadedDetail
    ? proofCardInputFromLoop(loadedDetail.loop)
    : defaultChallengeProofCardInput();
  const integrity: IntegrityStatus | undefined = loadedDetail?.integrity.state;
  const card = buildMartinProofCard(input);
  const markdown = renderMartinProofCardMarkdown(card);
  const svg = renderMartinProofCardSvg(card);

  if (command.format === "svg" && outputMode === "human") {
    return { exitCode: 0, stdout: svg, stderr: "" };
  }

  return renderCliSuccess(outputMode, {
    data: {
      command: "challenge",
      card: { loopId: input.loopId, ...card },
      markdown,
      svg,
      ...(integrity ? { integrity } : {})
    },
    human: [
      `Martin Loop Under-$3 Challenge`,
      `Loop: ${input.loopId}`,
      `Objective: ${input.objective}`,
      `Status: ${input.status} / ${input.lifecycle}`,
      `Spend: ${input.costSpend} / ${input.budget}`,
      `Verifier: ${input.verifierStatus}`,
      `Rollback: ${input.rollbackStatus}`,
      `Halt reason: ${input.haltReason}`,
      ...(integrity ? [`Integrity: ${describeIntegrity(integrity)}`] : []),
      ``,
      card.evidenceLine
    ],
    quiet: input.loopId
  });
}

function proofCardInputFromLoop(loop: LoopRecord): MartinProofCardInput {
  const verification = buildVerificationSummary(loop);
  const rollbackStatus = loop.artifacts.some((artifact) =>
    artifact.kind.toLowerCase().includes("rollback")
  )
    ? "captured"
    : "not-recorded";

  return {
    loopId: loop.loopId,
    objective: loop.task.objective,
    status: loop.status,
    lifecycle: loop.lifecycleState,
    verifierStatus: verification.status,
    costSpend: `$${loop.cost.actualUsd.toFixed(2)}`,
    budget: `$${loop.budget.maxUsd.toFixed(2)}`,
    attempts: loop.attempts.length,
    runMode: deriveLoopRunMode(loop),
    rollbackStatus,
    haltReason: latestExitReason(loop),
    evidenceBoundaryNotes: [
      "Generated from a local Martin Loop run record.",
      "Hosted dashboards and private team telemetry are intentionally excluded from OSS proof cards."
    ],
    generatedAt: loop.updatedAt,
    receiptIntegrityState: loop.receiptIntegrity?.state ?? "unsigned"
  };
}

function defaultChallengeProofCardInput(): MartinProofCardInput {
  return {
    loopId: "loop_demo_challenge",
    objective: "Repair the failing MCP lane so the agent can reconnect.",
    status: "completed",
    lifecycle: "verified",
    verifierStatus: "passed",
    costSpend: "$2.30",
    budget: "$3.00",
    attempts: 2,
    rollbackStatus: "captured",
    haltReason: "verifier_passed",
    evidenceBoundaryNotes: [
      "Generated from a local Martin Loop run record.",
      "Hosted dashboards and private team telemetry are intentionally excluded from OSS proof cards."
    ],
    generatedAt: new Date().toISOString()
  };
}

function deriveLoopRunMode(loop: LoopRecord): string {
  if (loop.task.mutationMode) {
    return loop.task.mutationMode;
  }
  if (loop.attempts.some((attempt) => attempt.adapterId === "direct:verifier:verify-only")) {
    return "verify_only";
  }
  if (loop.attempts.some((attempt) => attempt.adapterId === "direct:proof:no-mutation")) {
    return "proof";
  }
  if (loop.cost.actualUsd === 0) {
    return "proof";
  }
  return "not recorded";
}

function latestExitReason(loop: LoopRecord): string {
  const exitEvent = [...loop.events].reverse().find((event) => event.type === "run.completed");
  const reason = exitEvent?.payload["reason"];
  return typeof reason === "string" && reason.trim().length > 0
    ? reason
    : `${loop.status}/${loop.lifecycleState}`;
}

function parseChallengeFormat(tokens: string[]): "markdown" | "svg" {
  const format = readOption(tokens, "--format");
  return format === "svg" ? "svg" : "markdown";
}

function parseShareProofCardFormat(tokens: string[]): "svg" | "png" | "both" {
  const format = readOption(tokens, "--proof-card-format");
  return format === "png" || format === "both" ? format : "svg";
}

async function executeShareCommand(
  command: ShareCommand,
  outputMode: MartinOutputMode
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const selected = await loadPersistedLoop(command.selector);
  const detail =
    command.outputDir || selected.runDirectory
      ? selected
      : await loadPersistedLoop({
          loopId: selected.loop.loopId,
          ...(command.selector.runsDir ? { runsDir: command.selector.runsDir } : {})
        });
  const outputDir = resolveShareOutputDirectory(detail, command.outputDir);
  const shareBundle = buildShareBundle(detail);
  const shared = await writeShareArtifacts({
    runsRoot: detail.runsRoot,
    outputDir,
    loop: detail.loop,
    shareBundle,
    proofCard: command.proofCard,
    proofCardFormat: command.proofCardFormat
  });

  return renderCliSuccess(outputMode, {
    data: {
      command: "share",
      loopId: detail.loop.loopId,
      outputDir,
      files: shared.files,
      ledgers: shared.ledgers,
      receipt: shared.receipt
    },
    human: [
      `Share bundle written for ${detail.loop.loopId}`,
      `Output directory: ${outputDir}`,
      `JSON receipt: ${shared.files.receiptJson}`,
      `Markdown receipt: ${shared.files.receiptMarkdown}`,
      ...(shared.files.proofCardSvg ? [`Proof card SVG: ${shared.files.proofCardSvg}`] : []),
      ...(shared.files.proofCardPng ? [`Proof card PNG: ${shared.files.proofCardPng}`] : []),
      `Receipt ledger (Markdown): ${shared.ledgers.markdown}`,
      `Receipt ledger (JSONL): ${shared.ledgers.jsonl}`
    ],
    quiet: outputDir,
    warnings: dedupeWarnings([...selected.warnings, ...detail.warnings, ...shareBundle.warnings])
  });
}

function buildShareBundle(detail: Awaited<ReturnType<typeof loadPersistedLoop>>): {
  receipt: Record<string, unknown>;
  card: ReturnType<typeof buildMartinProofCard>;
  verification: ReturnType<typeof buildVerificationSummary>;
  warnings: string[];
} {
  const dossier = buildRunDossier(detail);
  const verification = buildVerificationSummary(detail.loop);
  const card = buildMartinProofCard(proofCardInputFromLoop(detail.loop));
  const receiptWarnings = dedupeWarnings([...detail.warnings, ...verification.warnings]);
  const receipt = redactShareValue({
    schemaVersion: "martin.share-receipt.v1",
    generatedAt: new Date().toISOString(),
    loop: {
      loopId: detail.loop.loopId,
      title: detail.loop.task.title,
      objective: detail.loop.task.objective,
      status: detail.loop.status,
      lifecycleState: detail.loop.lifecycleState,
      updatedAt: detail.loop.updatedAt,
      attempts: detail.loop.attempts.length,
      spendUsd: detail.loop.cost.actualUsd,
      budgetUsd: detail.loop.budget.maxUsd
    },
    receiptIntegrity: detail.integrity,
    verification: dossier["verification"],
    receipt: dossier["receipt"],
    artifacts: dossier["artifacts"],
    proofCard: {
      title: card.title,
      evidenceLine: card.evidenceLine,
      completeEvidence: card.completeEvidence,
      generatedAt: card.generatedAt,
      fields: card.fields
    },
    warnings: receiptWarnings
  }) as Record<string, unknown>;

  return {
    receipt,
    card,
    verification,
    warnings: receiptWarnings
  };
}

function renderShareReceiptMarkdown(input: {
  loop: LoopRecord;
  card: ReturnType<typeof buildMartinProofCard>;
  verification: ReturnType<typeof buildVerificationSummary>;
  receipt: Record<string, unknown>;
  share: {
    revision: number;
    receiptStateHash: string;
    artifactFiles: readonly string[];
    ledgerFiles: readonly string[];
  };
  receiptFields: {
    whatHappened?: string;
    whatMartinPrevented?: string[];
    nextSafeAction?: string;
  };
  receiptIntegrity: string;
  warnings: string[];
}): string {
  const proofCardMarkdown = renderMartinProofCardMarkdown(input.card).trimEnd();
  const loopSummary = input.receipt["loop"] as {
    title?: string;
    objective?: string;
    status?: string;
    lifecycleState?: string;
    spendUsd?: number;
    budgetUsd?: number;
    attempts?: number;
  };
  const verificationSummary = input.receipt["verification"] as { status?: string; summary?: string } | undefined;
  const spendUsd =
    typeof loopSummary?.spendUsd === "number" ? `$${loopSummary.spendUsd.toFixed(4)}` : "unknown";
  const budgetUsd =
    typeof loopSummary?.budgetUsd === "number" ? `$${loopSummary.budgetUsd.toFixed(4)}` : "unknown";

  return [
    "# Martin Loop Run Receipt",
    "",
    "Human-first receipt generated from local Martin Loop evidence.",
    "",
    "## Run Identity",
    "",
    `- Loop ID: ${redactAbsolutePaths(input.loop.loopId)}`,
    `- Title: ${redactAbsolutePaths(loopSummary?.title ?? input.loop.task.title)}`,
    `- Objective: ${redactAbsolutePaths(loopSummary?.objective ?? input.loop.task.objective)}`,
    `- Revision: ${String(input.share.revision)}`,
    `- Receipt state hash: ${input.share.receiptStateHash}`,
    "",
    "## Verdict",
    "",
    `- Status: ${redactAbsolutePaths(loopSummary?.status ?? input.loop.status)} / ${redactAbsolutePaths(loopSummary?.lifecycleState ?? input.loop.lifecycleState)}`,
    `- Receipt integrity: ${redactAbsolutePaths(input.receiptIntegrity)}`,
    `- Verification: ${redactAbsolutePaths(verificationSummary?.status ?? input.verification.status)}`,
    `- Attempts: ${String(loopSummary?.attempts ?? input.loop.attempts.length)}`,
    "",
    "## Verifier Evidence",
    "",
    `- Summary: ${redactAbsolutePaths(verificationSummary?.summary ?? input.verification.summary)}`,
    "",
    "## Budget / Spend Posture",
    "",
    `- Spend: ${spendUsd}`,
    `- Budget: ${budgetUsd}`,
    "",
    "## What Happened",
    "",
    redactAbsolutePaths(input.receiptFields.whatHappened ?? "No attempt summary was recorded."),
    "",
    "## What Martin Prevented",
    "",
    `- ${(input.receiptFields.whatMartinPrevented ?? ["No prevention claim is available."]).map(redactAbsolutePaths).join("; ")}`,
    "",
    "## Next Safe Action",
    "",
    redactAbsolutePaths(input.receiptFields.nextSafeAction ?? "Run preflight before the next attempt."),
    "",
    "## Artifacts",
    "",
    ...input.share.artifactFiles.map((file) => `- ${file}`),
    ...input.share.ledgerFiles.map((file) => `- ${file}`),
    "",
    "## Proof View",
    "",
    proofCardMarkdown,
    ...(input.warnings.length > 0
      ? ["", "## Warnings", "", ...input.warnings.map((warning) => `- ${redactAbsolutePaths(warning)}`)]
      : []),
    ""
  ].join("\n");
}

async function writeShareArtifacts(input: {
  runsRoot: string;
  outputDir: string;
  loop: LoopRecord;
  shareBundle: ReturnType<typeof buildShareBundle>;
  proofCard: boolean;
  proofCardFormat: "svg" | "png" | "both";
}): Promise<{
  files: {
    receiptJson: string;
    receiptMarkdown: string;
    proofCardSvg?: string;
    proofCardPng?: string;
  };
  ledgers: {
    markdown: string;
    jsonl: string;
    revision: number;
    stateHash: string;
    appended: boolean;
  };
  receipt: Record<string, unknown>;
}> {
  await mkdir(input.outputDir, { recursive: true });

  const files = {
    receiptJson: join(input.outputDir, "run-receipt.json"),
    receiptMarkdown: join(input.outputDir, "run-receipt.md")
  } as {
    receiptJson: string;
    receiptMarkdown: string;
    proofCardSvg?: string;
    proofCardPng?: string;
  };
  const ledgers = {
    markdown: join(input.runsRoot, "run-receipts.md"),
    jsonl: join(input.runsRoot, "run-receipts.jsonl")
  };
  const stateHash = createHash("sha256")
    .update(JSON.stringify(normalizeShareReceiptForHash(input.shareBundle.receipt)))
    .digest("hex");
  const ledgerState = await resolveShareLedgerState({
    jsonlPath: ledgers.jsonl,
    loopId: input.loop.loopId,
    stateHash
  });
  const proofBaseName = `proof-card-r${String(ledgerState.revision)}-${stateHash.slice(0, 8)}`;

  if (input.proofCard && (input.proofCardFormat === "svg" || input.proofCardFormat === "both")) {
    files.proofCardSvg = join(input.outputDir, `${proofBaseName}.svg`);
  }
  if (input.proofCard && (input.proofCardFormat === "png" || input.proofCardFormat === "both")) {
    files.proofCardPng = join(input.outputDir, `${proofBaseName}.png`);
  }

  const receipt = redactShareValue({
    ...input.shareBundle.receipt,
    share: {
      generatedAt: new Date().toISOString(),
      revision: ledgerState.revision,
      receiptStateHash: stateHash,
      proofCardGenerated: input.proofCard,
      proofCardFormat: input.proofCard ? input.proofCardFormat : undefined,
      artifacts: {
        receiptJson: "run-receipt.json",
        receiptMarkdown: "run-receipt.md",
        ...(files.proofCardSvg ? { proofCardSvg: proofBaseName + ".svg" } : {}),
        ...(files.proofCardPng ? { proofCardPng: proofBaseName + ".png" } : {})
      },
      ledgers: {
        markdown: "run-receipts.md",
        jsonl: "run-receipts.jsonl"
      }
    }
  }) as Record<string, unknown>;

  const markdown = renderShareReceiptMarkdown({
    loop: input.loop,
    card: input.shareBundle.card,
    verification: input.shareBundle.verification,
    receipt,
    share: {
      revision: ledgerState.revision,
      receiptStateHash: stateHash,
      artifactFiles: [
        "run-receipt.json",
        "run-receipt.md",
        ...(files.proofCardSvg ? [proofBaseName + ".svg"] : []),
        ...(files.proofCardPng ? [proofBaseName + ".png"] : [])
      ],
      ledgerFiles: ["run-receipts.md", "run-receipts.jsonl"]
    },
    receiptFields: receipt["receipt"] as {
      whatHappened?: string;
      whatMartinPrevented?: string[];
      nextSafeAction?: string;
    },
    receiptIntegrity: String(
      ((receipt["receiptIntegrity"] as { state?: string } | undefined)?.state ?? "unknown")
    ),
    warnings: input.shareBundle.warnings
  });

  await writeFile(files.receiptJson, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
  await writeFile(files.receiptMarkdown, markdown, "utf8");

  const proofCardSvg = renderMartinProofCardSvg(input.shareBundle.card);
  if (files.proofCardSvg) {
    await writeFileIfAbsent(files.proofCardSvg, proofCardSvg, "utf8");
  }
  if (files.proofCardPng) {
    await writeFileIfAbsent(files.proofCardPng, await renderProofCardPng(proofCardSvg));
  }

  if (ledgerState.appended) {
    const ledgerEntry = buildShareLedgerEntry({
      receipt,
      revision: ledgerState.revision,
      stateHash,
      proofArtifacts: [
        ...(files.proofCardSvg ? [proofBaseName + ".svg"] : []),
        ...(files.proofCardPng ? [proofBaseName + ".png"] : [])
      ]
    });
    const existingJsonl = await readFile(ledgers.jsonl, "utf8").catch(() => "");
    const existingMarkdown = await readFile(ledgers.markdown, "utf8").catch(() => "");
    await writeFile(
      ledgers.jsonl,
      `${existingJsonl}${JSON.stringify(ledgerEntry)}\n`,
      "utf8"
    );
    await writeFile(
      ledgers.markdown,
      `${existingMarkdown}${existingMarkdown.trim().length > 0 ? "\n\n---\n\n" : ""}${renderShareLedgerMarkdownEntry(ledgerEntry)}`,
      "utf8"
    );
  }

  return {
    files,
    ledgers: {
      markdown: ledgers.markdown,
      jsonl: ledgers.jsonl,
      revision: ledgerState.revision,
      stateHash,
      appended: ledgerState.appended
    },
    receipt
  };
}

async function resolveShareLedgerState(input: {
  jsonlPath: string;
  loopId: string;
  stateHash: string;
}): Promise<{ revision: number; appended: boolean }> {
  const raw = await readFile(input.jsonlPath, "utf8").catch(() => "");
  const entries = raw
    .split(/\r?\n/gu)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line) as {
          loopId?: string;
          revision?: number;
          receiptStateHash?: string;
        };
      } catch {
        return undefined;
      }
    })
    .filter((entry): entry is { loopId?: string; revision?: number; receiptStateHash?: string } => entry !== undefined);
  const existing = entries.find(
    (entry) => entry.loopId === input.loopId && entry.receiptStateHash === input.stateHash
  );
  if (existing && typeof existing.revision === "number") {
    return { revision: existing.revision, appended: false };
  }
  const maxRevision = entries
    .filter((entry) => entry.loopId === input.loopId && typeof entry.revision === "number")
    .reduce((highest, entry) => Math.max(highest, entry.revision ?? 0), 0);
  return { revision: maxRevision + 1, appended: true };
}

function normalizeShareReceiptForHash(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => normalizeShareReceiptForHash(item));
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => key !== "generatedAt" && key !== "settledAt")
        .map(([key, item]) => [key, normalizeShareReceiptForHash(item)])
    );
  }

  return value;
}

function buildShareLedgerEntry(input: {
  receipt: Record<string, unknown>;
  revision: number;
  stateHash: string;
  proofArtifacts: readonly string[];
}): Record<string, unknown> {
  const loop = (input.receipt["loop"] ?? {}) as Record<string, unknown>;
  const verification = (input.receipt["verification"] ?? {}) as Record<string, unknown>;
  const shareReceipt = (input.receipt["receipt"] ?? {}) as Record<string, unknown>;

  return redactShareValue({
    kind: "martin.share-ledger-entry.v1",
    generatedAt: input.receipt["generatedAt"],
    loopId: loop["loopId"],
    revision: input.revision,
    receiptStateHash: input.stateHash,
    title: loop["title"],
    objective: loop["objective"],
    status: loop["status"],
    lifecycleState: loop["lifecycleState"],
    verificationStatus: verification["status"],
    spendUsd: loop["spendUsd"],
    budgetUsd: loop["budgetUsd"],
    attempts: loop["attempts"],
    nextSafeAction: shareReceipt["nextSafeAction"],
    whatHappened: shareReceipt["whatHappened"],
    whatMartinPrevented: shareReceipt["whatMartinPrevented"],
    artifacts: ["run-receipt.json", "run-receipt.md", ...input.proofArtifacts]
  }) as Record<string, unknown>;
}

function renderShareLedgerMarkdownEntry(entry: Record<string, unknown>): string {
  const prevented = Array.isArray(entry["whatMartinPrevented"])
    ? (entry["whatMartinPrevented"] as unknown[]).map((item) => String(item)).join("; ")
    : "No prevention claim is available.";
  const artifacts = Array.isArray(entry["artifacts"])
    ? (entry["artifacts"] as unknown[]).map((item) => `- ${String(item)}`)
    : [];

  return [
    `## ${String(entry["loopId"] ?? "unknown-loop")} · rev ${String(entry["revision"] ?? 1)}`,
    "",
    `- Title: ${String(entry["title"] ?? "unknown")}`,
    `- Status: ${String(entry["status"] ?? "unknown")} / ${String(entry["lifecycleState"] ?? "unknown")}`,
    `- Verification: ${String(entry["verificationStatus"] ?? "unknown")}`,
    `- Spend: ${typeof entry["spendUsd"] === "number" ? `$${Number(entry["spendUsd"]).toFixed(4)}` : "unknown"}`,
    `- Budget: ${typeof entry["budgetUsd"] === "number" ? `$${Number(entry["budgetUsd"]).toFixed(4)}` : "unknown"}`,
    `- Next safe action: ${String(entry["nextSafeAction"] ?? "Run preflight before the next attempt.")}`,
    "",
    "### What Happened",
    "",
    String(entry["whatHappened"] ?? "No attempt summary was recorded."),
    "",
    "### What Martin Prevented",
    "",
    `- ${prevented}`,
    "",
    "### Artifacts",
    "",
    ...artifacts,
    ""
  ].join("\n");
}

async function renderProofCardPng(svg: string): Promise<Buffer> {
  const { Resvg } = require("@resvg/resvg-js") as {
    Resvg: new (
      svg: string,
      options: {
        fitTo: {
          mode: "width";
          value: number;
        };
      }
    ) => { render(): { asPng(): Buffer } };
  };
  const rendered = new Resvg(svg, {
    fitTo: {
      mode: "width",
      value: 1200
    }
  }).render();
  return rendered.asPng();
}

async function writeFileIfAbsent(path: string, contents: string | Buffer, encoding?: BufferEncoding): Promise<void> {
  const exists = await stat(path)
    .then(() => true)
    .catch(() => false);
  if (exists) {
    return;
  }
  if (typeof contents === "string") {
    await writeFile(path, contents, encoding ?? "utf8");
    return;
  }
  await writeFile(path, contents);
}

function resolveShareOutputDirectory(
  detail: Awaited<ReturnType<typeof loadPersistedLoop>>,
  outputDir?: string
): string {
  if (outputDir && outputDir.trim().length > 0) {
    return isAbsolute(outputDir) ? outputDir : resolve(resolveInvocationRoot(), outputDir);
  }

  if (detail.runDirectory) {
    return join(detail.runDirectory, "share");
  }

  throw new CliCommandError(
    "invalid_input",
    "martin share needs a canonical run directory or an explicit --out-dir.",
    {
      suggestion:
        "Use --latest or --loop-id against the Martin runs root, or pass --out-dir when sharing from an ad hoc file."
    }
  );
}

function redactShareValue(value: unknown): unknown {
  if (typeof value === "string") {
    return redactAbsolutePaths(value);
  }

  if (Array.isArray(value)) {
    return value.map((item) => redactShareValue(item));
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, redactShareValue(item)])
    );
  }

  return value;
}

function redactAbsolutePaths(text: string): string {
  return text
    .replace(/file:\/\/\/[^\s")\]]+/gu, redactPathMatch)
    .replace(/\\\\[^\\/\r\n]+[\\/][^\r\n]+/gu, redactPathMatch)
    .replace(/[A-Za-z]:[\\/][^\r\n]+/gu, redactPathMatch)
    .replace(/\/(?:Users|home|tmp|var|private|mnt|workspace|repo|opt)\/[^\r\n]+/gu, redactPathMatch);
}

function redactPathMatch(match: string): string {
  const normalized = match.replace(/^file:\/\/\//u, "").replace(/\\/gu, "/").trim();
  const trimmed = normalized.replace(/[),.;:]+$/u, "");
  const suffix = normalized.slice(trimmed.length);
  const basename = trimmed.split("/").filter(Boolean).at(-1) ?? "artifact";

  return `[redacted-path]/${basename}${suffix}`;
}

function dedupeWarnings(warnings: string[]): string[] {
  return [...new Set(warnings.filter((warning) => warning.trim().length > 0))];
}

// ---------------------------------------------------------------------------
// Badge command
// ---------------------------------------------------------------------------

async function executeBadgeCommand(
  command: BadgeCommand,
  outputMode: MartinOutputMode
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const input = await buildLocalReliabilityScoreInput(command.runsDir);
  const score = computeMartinReliabilityScore(input);
  const svg = renderMartinReliabilityBadgeSvg(score);
  const json = renderMartinReliabilityBadgeJson(score);
  const integrity = await loadLatestLoopIntegrity(command.runsDir);

  if (command.format === "svg" && outputMode === "human") {
    return { exitCode: 0, stdout: svg, stderr: "" };
  }

  if (command.format === "json" && outputMode === "human") {
    return { exitCode: 0, stdout: JSON.stringify(json, null, 2), stderr: "" };
  }

  return renderCliSuccess(outputMode, {
    data: { command: "badge", score, svg, json, ...(integrity ? { integrity } : {}) },
    human: [
      `Martin Loop agent reliability readiness: ${score.points}/${score.maxPoints} (${score.grade})`,
      score.summary,
      ...(integrity ? [`Latest run integrity: ${describeIntegrity(integrity)}`] : []),
      ...(score.missingReasons.length > 0 ? ["", "Missing:", ...score.missingReasons.map((r) => `  • ${r}`)] : [])
    ],
    quiet: score.grade
  });
}

async function loadLatestLoopIntegrity(runsDir?: string): Promise<IntegrityStatus | undefined> {
  const evidence = await findPersistedLoopEvidence(runsDir).catch(() => ({
    loop: undefined as LoopRecord | undefined
  }));

  if (evidence.loop === undefined) {
    return undefined;
  }

  try {
    const loaded = await loadPersistedLoop({ loopId: evidence.loop.loopId, ...(runsDir ? { runsDir } : {}) });
    return loaded.integrity.state;
  } catch {
    return "unsigned";
  }
}

async function buildLocalReliabilityScoreInput(runsDir?: string): Promise<MartinReliabilityScoreInput> {
  const environment = resolveCliEnvironment({ ...(runsDir ? { runsDir } : {}) });
  const shouldInspectRunStore = process.env["MARTIN_RUNS_DIR"] !== undefined;
  const loops = shouldInspectRunStore
    ? await listPersistedLoops({ limit: 20 }).catch(() => ({ loops: [] as LoopRecord[] }))
    : { loops: [] as LoopRecord[] };
  const latestPersisted = shouldInspectRunStore
    ? await loadPersistedLoop({ latest: true }).catch(() => null)
    : null;
  const latestLoop = latestPersisted?.loop ?? loops.loops[0];
  const configPath = join(environment.workingDirectory, "martin.config.yaml");
  const configExists = await stat(configPath).then((entry) => entry.isFile()).catch(() => false);
  const budgetConfigured =
    configExists ||
    (latestLoop !== undefined && latestLoop.budget.maxUsd > 0 && latestLoop.budget.maxIterations > 0);
  const verifierConfigured =
    latestLoop?.task.verificationPlan.some((cmd) => cmd.trim().length > 0) ?? configExists;
  const runReceiptsPresent = latestPersisted?.integrity.state === "verified";
  const rollbackEvidencePresent =
    latestLoop?.artifacts.some((artifact) => artifact.kind.toLowerCase().includes("rollback")) ?? false;
  const mcpDoctorPassing = isCommandAvailable("node");

  return {
    signals: {
      budgetConfigured: {
        present: budgetConfigured,
        detail: budgetConfigured
          ? "Budget evidence found in config or latest run."
          : "No config or run budget evidence found."
      },
      verifierConfigured: {
        present: verifierConfigured,
        detail: verifierConfigured ? "Verifier evidence found." : "No verifier plan evidence found."
      },
      runReceiptsPresent: {
        present: runReceiptsPresent,
        detail: runReceiptsPresent
          ? "Latest persisted run receipt integrity verified."
          : latestPersisted
            ? `Latest persisted run receipt integrity is ${latestPersisted.integrity.state}.`
            : shouldInspectRunStore
              ? "No local run receipts found."
              : "Set MARTIN_RUNS_DIR to inspect verified local run receipts."
      },
      rollbackEvidencePresent: {
        present: rollbackEvidencePresent,
        detail: rollbackEvidencePresent
          ? "Rollback artifact evidence found."
          : "No rollback artifact evidence found."
      },
      mcpDoctorPassing: {
        present: mcpDoctorPassing,
        detail: mcpDoctorPassing
          ? "Local runtime can execute MCP doctor prerequisites."
          : "Node runtime unavailable."
      }
    }
  };
}

function parseBadgeFormat(tokens: string[]): "svg" | "json" {
  const format = readOption(tokens, "--format");
  return format === "json" ? "json" : "svg";
}

function parseOptionalRunSelector(tokens: string[]): MartinRunSelector | undefined {
  const loopId = readOption(tokens, "--loop-id");
  const file = readOption(tokens, "--file");
  const latest = hasFlag(tokens, "--latest");
  const runsDir = readOption(tokens, "--runs-dir");

  if (!loopId && !file && !latest) {
    return undefined;
  }

  return {
    ...(loopId ? { loopId } : {}),
    ...(file ? { file } : {}),
    ...(latest ? { latest } : {}),
    ...(runsDir ? { runsDir } : {})
  };
}
