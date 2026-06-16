import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
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
  createVerifierOnlyAdapter
} from "@martin/adapters";
import { compileExecutionPolicy, runMartin, type MartinAdapter } from "@martin/core";
import {
  buildPortfolioSnapshot,
  createLoopRecord,
  type ExecutionPolicy,
  type ExecutionPolicyConfigInput,
  type LoopBudget,
  type LoopRecord,
  type MartinOutputMode,
  type MartinRunListFilters,
  type MartinRunSelector,
  type MutationMode,
  type ReceiptIntegritySummary,
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
  listPersistedLoops,
  loadPersistedAttempt,
  loadPersistedLoop,
  readLocalCorpusRisk,
  resolveCliEnvironment,
  resolveInvocationRoot,
  resolveReceiptScope,
  triagePersistedLoops
} from "./run-store.js";
import { CliCommandError, renderCliError, renderCliSuccess } from "./ux.js";
import { evaluateCliRunGate, recordCliWorkflowStep } from "./workflow-state.js";

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

const rootPackageVersion = resolveRootPackageVersion();
let runAdapterOverrideForTests: MartinAdapter | undefined;

const DEFAULT_RUN_TIMEOUT_MS = 30 * 60 * 1000;

class RunTimeoutError extends Error {
  readonly timeoutMs: number;

  constructor(timeoutMs: number) {
    super(`Martin run timed out after ${timeoutMs}ms`);
    this.timeoutMs = timeoutMs;
    this.name = "RunTimeoutError";
  }
}

export function setRunAdapterOverrideForTests(adapter: MartinAdapter | undefined): void {
  runAdapterOverrideForTests = adapter;
}

export type RunCommandRequest = {
  workspaceId: string;
  projectId: string;
  title: string;
  objective: string;
  verificationPlan: string[];
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
  allowedPaths?: string[];
  deniedPaths?: string[];
  acceptanceCriteria?: string[];
};

type GuardrailsConfig = ExecutionPolicyConfigInput;
type ResolvedGuardrails = ExecutionPolicy;

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
      platform?: MartinMcpPlatform;
      dryRun: boolean;
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
};

type BadgeCommand = {
  command: "badge";
  format: "svg" | "json";
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

type IntegrityStatus = ReceiptIntegritySummary["state"];

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
  | ChallengeCommand
  | ShareCommand
  | BadgeCommand;

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
    }
  } catch (error) {
    return renderCliError(outputMode, error);
  }
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

  if (command === "start") {
    return {
      command: "start",
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
    return {
      command: "share",
      selector: parseRunSelector(rest, { allowLatest: true }),
      ...(readOption(rest, "--out-dir") ? { outputDir: readOption(rest, "--out-dir") } : {})
    };
  }

  if (command === "badge") {
    return {
      command: "badge",
      format: parseBadgeFormat(rest)
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
    "  martin runs verify (--loop-id <id> | --file <path>) [options]",
    "  martin mcp print-config --host <codex|claude|gemini|generic> [--scope <user|project|local>] [options]",
    "  martin mcp install --host <codex|claude|gemini|generic> [--scope <user|project|local>] [--dry-run] [options]",
    "  martin demo [--dir <path>] [--force]",
    "  martin-loop demo [--dir <path>] [--force] (published alias)",
    "  martin inspect --file <path>",
    "  martin-loop inspect --file <path>        (published alias)",
    "  martin resume <loopId>",
    "  martin-loop resume <loopId>              (published alias)",
    "  martin bench --suite <suiteId>",
    "  martin challenge [--loop-id <id> | --file <path> | --latest] [--format markdown|svg]",
    "  martin share (--loop-id <id> | --file <path> | --latest) [--out-dir <path>]",
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
    "  mcp print-config  Print a known-good MCP config snippet for Codex, Claude, Gemini, or generic hosts.",
    "  mcp install       Write a starter MCP config, or call Claude Code directly for local scope.",
    "  challenge    Print a shareable local proof card for the Under-$3 challenge.",
    "  share        Write a local share bundle with a redacted receipt JSON, proof Markdown, and proof SVG.",
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
    "  --host <name>            codex, claude, gemini, or generic.",
    "  --scope <name>           user or project for all hosts; Claude also supports local.",
    "  --transport <name>       stdio (default).",
    "  --profile <name>         minimal (default), diagnostic, github-review, full-local, starter, or full.",
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
    "  --verify-only            Skip the coding adapter and run the verifier only.",
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
  const cliEnvironment = resolveCliEnvironment({
    cwd: request.cwd,
    runsDir: request.runsDir,
    engine: request.engine,
    liveMode: request.liveMode
  });
  const resolvedGuardrails = await resolveGuardrails(request, cliEnvironment.workingDirectory);
  const resolvedRequest = applyExecutionPolicyToRequest(request, resolvedGuardrails);
  const receiptScope = buildCliReceiptScope(cliEnvironment);
  let result: Awaited<ReturnType<typeof runMartin>>;
  const engineRequired =
    resolvedRequest.mutationMode !== "verify_only" && cliEnvironment.liveMode === "live";
  let codexCommandOverride: string | undefined;

  if (engineRequired) {
    const gate = await evaluateCliRunGate({
      runsRoot: cliEnvironment.runsRoot,
      workingDirectory: cliEnvironment.workingDirectory,
      objective: resolvedRequest.objective,
      engine: cliEnvironment.engine,
      verificationPlan: resolvedRequest.verificationPlan,
      mutationMode: resolvedRequest.mutationMode,
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
  }

  if (engineRequired && cliEnvironment.engine === "codex") {
    const codexAvailability = resolveCliCommandAvailability("codex");
    const codexProbe = probeCodexLaunch({
      workingDirectory: cliEnvironment.workingDirectory,
      availability: codexAvailability
    });
    if (!codexProbe.ok) {
      throw new CliCommandError("environment", codexProbe.summary, {
        suggestion: "Run `martin doctor --engine codex` or `martin preflight --engine codex` before retrying this governed run.",
        details: {
          command: codexProbe.command,
          args: codexProbe.args,
          resolvedPath: codexProbe.availability.resolvedPath,
          hostPlatform: codexProbe.diagnosis.hostPlatform
        }
      });
    }
    codexCommandOverride = codexProbe.command;
  }
  const runtimeAdapter = selectAdapter(
    resolvedRequest.engine,
    cliEnvironment.workingDirectory,
    cliEnvironment.liveMode,
    resolvedRequest.model,
    resolvedRequest.mutationMode,
    codexCommandOverride
  );
  try {
    const runTimeoutMs = resolveRunTimeoutMs(process.env.MARTIN_RUN_TIMEOUT_MS);
    result = await runWithTimeout(
      runMartin({
        workspaceId: resolvedRequest.workspaceId,
        projectId: resolvedRequest.projectId,
        receiptScope: {
          ...receiptScope
        },
        task: {
          title: resolvedRequest.title,
          objective: resolvedRequest.objective,
          ...resolvedGuardrails.task
        },
        budget: resolvedRequest.budget,
        metadata: resolvedRequest.metadata,
        adapter: runtimeAdapter,
        executionPolicy: resolvedGuardrails
      }),
      runTimeoutMs
    );
  } catch (error) {
    const fallbackLoop = createLoopRecord({
      workspaceId: resolvedRequest.workspaceId,
      projectId: resolvedRequest.projectId,
      task: {
        title: resolvedRequest.title,
        objective: resolvedRequest.objective,
        ...resolvedGuardrails.task
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
        "Run `martin doctor` to verify engine availability, or set MARTIN_LIVE=false to use the stub adapter locally.",
      details: {
        loopId: fallbackLoop.loopId,
        reason:
          error instanceof RunTimeoutError
            ? `Timed out after ${error.timeoutMs}ms before adapter completion.`
            : error instanceof Error
              ? error.message
              : String(error)
      }
    });
  }

  const warnings: string[] = [];
  await persistLoopArtifacts(result.loop, { runsRoot: cliEnvironment.runsRoot }).catch((error: unknown) => {
    warnings.push(
      `Persisted run artifacts could not be written: ${error instanceof Error ? error.message : String(error)}`
    );
  });

  return renderCliSuccess(outputMode, {
    data: {
      command: "run",
      decision: result.decision,
      loop: result.loop,
      effectivePolicy: resolvedGuardrails,
      environment: {
        workingDirectory: cliEnvironment.workingDirectory,
        runsRoot: cliEnvironment.runsRoot,
        engine: cliEnvironment.engine,
        liveMode: cliEnvironment.liveMode
      },
      receiptScope
    },
    human: [
      `Started Martin Loop run ${result.loop.loopId}`,
      `Status: ${result.loop.status} / ${result.loop.lifecycleState}`,
      `Working directory: ${cliEnvironment.workingDirectory}`,
      `Runs root: ${cliEnvironment.runsRoot}`,
      `Verification plan: ${resolvedRequest.verificationPlan.join(", ") || "none"}`,
      `Attempts: ${result.loop.attempts.length}`,
      `Actual cost (USD): ${result.loop.cost.actualUsd.toFixed(2)}`
    ],
    quiet: result.loop.loopId,
    warnings
  });
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
  const sourceStat = await stat(sourcePath).catch((error: unknown) => {
    if (isNodeErrorWithCode(error, "ENOENT")) {
      throw new CliCommandError("not_found", `Persisted loop file not found: ${sourcePath}`);
    }
    throw error;
  });
  const loopRecordPath = sourceStat.isDirectory()
    ? join(sourcePath, "loop-record.json")
    : sourcePath;
  const contents = await readFile(loopRecordPath, "utf8").catch((error: unknown) => {
    if (isNodeErrorWithCode(error, "ENOENT") && sourceStat.isDirectory()) {
      throw new CliCommandError(
        "not_found",
        `Persisted run directory is missing loop-record.json: ${sourcePath}`
      );
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
    ? resolveConfigPath(command.configPath)
    : join(environment.workingDirectory, "martin.config.yaml");
  const configExists = await stat(configPath).then(() => true).catch(() => false);
  const workingDirectoryReady = await stat(environment.workingDirectory).then(() => true).catch(() => false);
  const runsRootReady = await stat(environment.runsRoot).then(() => true).catch(() => false);
  const claudeAvailable = isCommandAvailable("claude");
  const codexAvailability = resolveCliCommandAvailability("codex");
  const codexAvailable = codexAvailability.available;
  const geminiAvailability = resolveCliCommandAvailability("gemini");
  const geminiAvailable = geminiAvailability.available;
  const openAiRuntimeConfig = resolveOpenAiCompatibleRuntimeConfig();
  const codexProbe =
    environment.liveMode === "live" && environment.engine === "codex" && workingDirectoryReady
      ? probeCodexLaunch({
          workingDirectory: environment.workingDirectory,
          availability: codexAvailability
        })
      : undefined;
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
  if (environment.liveMode === "live" && environment.engine === "openai" && !openAiRuntimeConfig.authReady) {
    warnings.push(
      openAiRuntimeConfig.endpointKind === "hosted_openai"
        ? "OpenAI-compatible live execution requires MARTIN_OPENAI_API_KEY for https://api.openai.com."
        : "The configured remote OpenAI-compatible endpoint requires MARTIN_OPENAI_API_KEY for live execution."
    );
  }
  if (environment.liveMode === "live" && environment.engine === "codex" && codexProbe && !codexProbe.ok) {
    warnings.push(codexProbe.summary);
  }

  const data = {
    command: "doctor",
    cliVersion: rootPackageVersion,
    environment,
    scope: {
      invocationRoot: environment.invocationRoot,
      workingDirectory: environment.workingDirectory,
      repoRoot: environment.workingDirectory,
      runsRoot: environment.runsRoot
    },
    config: {
      path: configPath,
      exists: configExists
    },
    engines: {
      claude: { available: claudeAvailable },
      codex: {
        available: codexAvailable,
        ...(codexAvailability.resolvedPath ? { resolvedPath: codexAvailability.resolvedPath } : {}),
        ...(codexProbe
          ? {
              hostPlatform: codexProbe.diagnosis.hostPlatform,
              nativeInstallValid: codexProbe.diagnosis.nativeInstallValid,
              launchReady: codexProbe.ok,
              probeSummary: codexProbe.summary
            }
          : {})
      },
      openai: {
        available: true,
        ...openAiRuntimeConfig
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
      openAiRuntimeConfig
    })
  };

  await recordCliWorkflowStep({
    runsRoot: environment.runsRoot,
    step: "doctor",
    workingDirectory: environment.workingDirectory,
    engine: environment.engine,
    receiptScope: buildCliReceiptScope(environment)
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
      `OpenAI-compatible: ${openAiRuntimeConfig.baseUrl} (${openAiRuntimeConfig.model}) [${openAiRuntimeConfig.authPosture}]`,
      ...(codexProbe ? [`Codex launch probe: ${codexProbe.ok ? "ready" : codexProbe.summary}`] : []),
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
  const objective = "Summarize this repository and confirm the verifier is green.";
  const preflightCommand = `martin preflight "${objective}" --verify "${snapshot.verifier.command}"`;
  const proofCommand = `martin run "${objective}" --proof --verify "${snapshot.verifier.command}"`;

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
      repo: {
        path: environment.workingDirectory,
        gitDetected: snapshot.git.detected,
        workingTree: snapshot.git.clean === undefined ? "unknown" : snapshot.git.clean ? "clean" : "dirty"
      },
      verifier: snapshot.verifier,
      recommended: {
        engine: snapshot.recommendedEngine,
        verifier: snapshot.verifier.command,
        budgetUsd: 2,
        maxIterations: 1
      },
      next: {
        doctor: "martin doctor",
        sessionStart: "martin session-start",
        preflight: preflightCommand,
        proofRun: proofCommand,
        enable: `martin enable --engine ${snapshot.recommendedEngine} --verify "${snapshot.verifier.command}" --budget-usd 2 --max-iterations 1`,
        review: "martin review",
        share: "martin share --latest"
      }
    },
    human: [
      "MartinLoop is ready to set up governed runs in this repo.",
      "",
      "Environment",
      `- Verifier: ${snapshot.verifier.command}${snapshot.verifier.detected ? "" : " (default)"}`,
      `- Codex: ${snapshot.codexAvailability.available ? "ready" : "blocked"}`,
      `- Claude: ${snapshot.claudeAvailable ? "ready" : "blocked"}`,
      `- Gemini: ${snapshot.geminiAvailability.available ? "ready" : "blocked"}`,
      `- Recommended engine: ${snapshot.recommendedEngine}`,
      "",
      "Next steps",
      `1. martin doctor`,
      `2. martin session-start`,
      `3. ${preflightCommand}`,
      `4. ${proofCommand}`,
      `5. martin share --latest`,
      "",
      "Optional repo defaults",
      `- martin enable --engine ${snapshot.recommendedEngine} --verify "${snapshot.verifier.command}" --budget-usd 2 --max-iterations 1`
    ],
    quiet: "martin start"
  });
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
    ? resolveConfigPath(command.configPath)
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
          "- martin run \"Summarize this repository and confirm the verifier is green.\" --proof --verify \"npm test\""
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
  const codexAvailability = resolveCliCommandAvailability("codex");
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
    default:
      return {
        meaning: `Unknown integrity state '${String(state)}'.`,
        shareSafe: false,
        nextAction: "Run martin receipts explain --latest after rebuilding the run receipt."
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
    const environment = resolveCliEnvironment({
      cwd: command.cwd,
      runsDir: command.runsDir
    });
    await recordCliWorkflowStep({
      runsRoot: environment.runsRoot,
      step: "session-start",
      workingDirectory: environment.workingDirectory,
      ...(snapshot.sessionStart.host === "codex" ? { engine: "codex" as const } : {}),
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
  const environment = resolveCliEnvironment({
    cwd: request.cwd,
    runsDir: request.runsDir,
    engine: request.engine,
    liveMode: request.liveMode
  });
  const resolvedGuardrails = await resolveGuardrails(request, environment.workingDirectory);
  const resolvedRequest = applyExecutionPolicyToRequest(request, resolvedGuardrails);
  const warnings: string[] = [];
  const blockingIssues: string[] = [];
  const verificationPlan = resolvedRequest.verificationPlan;
  const engineRequired = resolvedGuardrails.task.mutationMode !== "verify_only" && environment.liveMode === "live";
  const receiptScope = buildCliReceiptScope(environment);

  const workingDirectoryExists = await stat(environment.workingDirectory).then(() => true).catch(() => false);
  const codexAvailability = resolveCliCommandAvailability("codex");
  const geminiAvailability = resolveCliCommandAvailability("gemini");
  const codexProbe =
    engineRequired && environment.engine === "codex" && workingDirectoryExists
      ? probeCodexLaunch({
          workingDirectory: environment.workingDirectory,
          availability: codexAvailability
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

  // Run-history intelligence: surface failure hotspots for this working directory.
  // Degrades gracefully when the local run store is empty or not yet populated.
  const scopeFingerprint = computeScopeFingerprint(environment.workingDirectory);
  const runHistoryRisk = workingDirectoryExists
    ? await readLocalCorpusRisk({
        runsDir: environment.runsRoot,
        invocationRoot: environment.invocationRoot,
        maxEntries: 100
      }).catch(() => ({ hotspots: [], corpusRecords: 0, corpusPath: environment.runsRoot }))
    : { hotspots: [], corpusRecords: 0, corpusPath: environment.runsRoot };
  const scopeHotspots = runHistoryRisk.hotspots
    .filter((hotspot) => hotspot.scopeFingerprint === scopeFingerprint)
    .slice(0, 3);

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
    scope: {
      invocationRoot: environment.invocationRoot,
      workingDirectory: environment.workingDirectory,
      repoRoot: environment.workingDirectory,
      runsRoot: environment.runsRoot
    },
    engineProbe:
      environment.engine === "codex"
        ? {
            available: codexAvailability.available,
            ...(codexAvailability.resolvedPath ? { resolvedPath: codexAvailability.resolvedPath } : {}),
            ...(codexProbe
              ? {
                  hostPlatform: codexProbe.diagnosis.hostPlatform,
                  nativeInstallValid: codexProbe.diagnosis.nativeInstallValid,
                  launchReady: codexProbe.ok,
                  summary: codexProbe.summary
                }
              : {})
          }
        : environment.engine === "gemini"
          ? {
              available: geminiAvailability.available,
              ...(geminiAvailability.resolvedPath ? { resolvedPath: geminiAvailability.resolvedPath } : {})
            }
        : undefined,
    runHistory: {
      records: runHistoryRisk.corpusRecords,
      scopeHotspots
    },
    request: {
      ...resolvedRequest
    },
    effectivePolicy: resolvedGuardrails
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

  const runHistoryLine = runHistoryRisk.corpusRecords > 0
    ? `Run history: ${runHistoryRisk.corpusRecords} records${scopeHotspots.length > 0 ? `, ${scopeHotspots.length} scope hotspot(s)` : ", no scope hotspots"}`
    : `Run history: no data yet — run Martin to start building prediction intelligence`;

  return renderCliSuccess(outputMode, {
    data,
    human: [
      `Preflight ${ready ? "passed" : "blocked"} for ${request.title}`,
      `Working directory: ${environment.workingDirectory}`,
      `Engine: ${environment.engine} (${environment.liveMode})`,
      `Verification plan: ${verificationPlan.join(", ") || "none"}`,
      runHistoryLine,
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
  const receipt = dossier["receipt"] as {
    whatHappened?: string;
    whatMartinPrevented?: string[];
    nextSafeAction?: string;
  };

  return renderCliSuccess(outputMode, {
    data: {
      command: "dossier",
      ...dossier
    },
    human: [
      `Run dossier for ${detail.loop.loopId}`,
      `Status: ${detail.loop.status} / ${detail.loop.lifecycleState}`,
      `Verification: ${verification.status}`,
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

  return renderCliSuccess(outputMode, {
    data: {
      command: "runs_get",
      source: detail.source,
      loop: detail.loop,
      receiptIntegrity: detail.integrity,
      ...(receiptScope ? { receiptScope } : {}),
      verification,
      artifacts
    },
    human: [
      `Loaded persisted loop ${detail.loop.loopId}`,
      `Status: ${detail.loop.status} / ${detail.loop.lifecycleState}`,
      `Verification: ${verification.status}`,
      `Artifacts: ${artifacts.totalCount}`,
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
      verification: loaded.verification
    },
    human: [
      `Attempt ${loaded.attempt.index} for ${loaded.detail.loop.loopId}`,
      `Adapter: ${loaded.attempt.adapterId}`,
      `Model: ${loaded.attempt.model}`,
      `Verification: ${loaded.verification.status}`,
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
      verification
    },
    human: [
      `Verification for ${detail.loop.loopId}`,
      `Status: ${verification.status}`,
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
    default:
      return `unknown integrity state: ${String(integrity)}`;
  }
}

function readCostProvenance(loop: LoopRecord): "actual" | "estimated" | "unavailable" {
  const provenance = (loop.cost as { provenance?: unknown }).provenance;
  return provenance === "actual" || provenance === "estimated" || provenance === "unavailable"
    ? provenance
    : "unavailable";
}

function describeCostProvenance(provenance: "actual" | "estimated" | "unavailable"): string {
  switch (provenance) {
    case "actual":
      return "actual provider settlement";
    case "estimated":
      return "estimated usage";
    case "unavailable":
      return "unavailable";
    default:
      return "unavailable";
  }
}
async function executeMcpPrintConfigCommand(
  command: Extract<ParsedCliArguments, { command: "mcp_print_config" }>,
  outputMode: MartinOutputMode
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
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
      targetPath: plan.targetPath,
      content: plan.content,
      serverId: plan.serverId,
      enabledTools: plan.enabledTools,
      installMethod: plan.installMethod,
      profiles: {
        minimal: [...MARTIN_MINIMAL_TOOLS],
        diagnostic: [...MARTIN_DIAGNOSTIC_TOOLS],
        "github-review": [...MARTIN_GITHUB_REVIEW_TOOLS],
        "full-local": [...MARTIN_FULL_TOOLS],
        starter: [...MARTIN_STARTER_TOOLS],
        full: [...MARTIN_FULL_TOOLS]
      },
      starterTools: [...MARTIN_STARTER_TOOLS],
      fullTools: [...MARTIN_FULL_TOOLS]
    },
    human: plan.content,
    quiet: plan.targetPath
  });
}

async function executeMcpInstallCommand(
  command: Extract<ParsedCliArguments, { command: "mcp_install" }>,
  outputMode: MartinOutputMode
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
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
      installMethod: plan.installMethod
    },
    human: [
      `${command.dryRun ? "Dry-run" : "Installed"} Martin Loop MCP config for ${command.host}`,
      `Target: ${plan.targetPath}`,
      "",
      plan.content
    ],
    quiet: plan.targetPath
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
      case "--verify-only":
        request.mutationMode = "verify_only";
        break;
      case "--proof":
        request.liveMode = "proof";
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
    suggestion: "Use --transport stdio."
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
    profile === "starter" ||
    profile === "full"
  ) {
    return profile;
  }

  throw new CliCommandError("invalid_input", `Invalid --profile value: ${profile}.`, {
    suggestion: "Use --profile minimal, diagnostic, github-review, full-local, starter, or full."
  });
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
  const parsedRunScanLimit = runScanLimit ? Number(runScanLimit) : undefined;
  if (parsedRunScanLimit !== undefined && (!Number.isFinite(parsedRunScanLimit) || parsedRunScanLimit < 1)) {
    throw new CliCommandError("invalid_input", "--run-scan-limit must be a positive number.");
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
    "Safe first run (no provider spend):",
    '  MARTIN_LIVE=false npx martin run "Summarize the demo workspace and confirm the verifier is green" --verify "npm test"',
    "",
    "Optional live run:",
    '  npx martin run "Add support for a discount percentage to summarizeInvoice and update the tests" --verify "npm test" --engine codex',
    "",
    `Task ideas live in ${join(targetDirectory, "TASKS.md")}`
  ].join("\n");
}

async function resolveGuardrails(
  request: RunCommandRequest,
  repoRoot: string
): Promise<ResolvedGuardrails> {
  const normalizedScope = normalizePathPolicyScope({
    repoRoot,
    allowedPaths: request.allowedPaths,
    deniedPaths: request.deniedPaths
  });
  const { config, configPath } = await loadGuardrailsConfig(request.configPath, {
    repoRoot
  });
  return compileExecutionPolicy({
    configPath,
    defaults: {
      budget: DEFAULT_BUDGET,
      policyProfile: "balanced",
      telemetryDestination: "local-only",
      destructiveActionPolicy: "approval",
      verifierRules: ["pnpm test"]
    },
    config,
    request: {
      budget: request.budget,
      budgetOverrides: request.budgetOverrides,
      policyProfile: request.metadata.policyProfile,
      telemetryDestination: request.metadata.telemetryDestination,
      verificationPlan: request.verificationPlan,
      mutationMode: request.mutationMode,
      repoRoot,
      allowedPaths: normalizedScope.allowedPaths,
      deniedPaths: normalizedScope.deniedPaths,
      acceptanceCriteria: request.acceptanceCriteria
    }
  });
}

function applyExecutionPolicyToRequest(
  request: RunCommandRequest,
  policy: ExecutionPolicy
): RunCommandRequest {
  return {
    ...request,
    budget: {
      ...policy.budget
    },
    verificationPlan: [...policy.task.verificationPlan],
    ...(policy.task.mutationMode ? { mutationMode: policy.task.mutationMode } : {}),
    ...(policy.task.allowedPaths ? { allowedPaths: [...policy.task.allowedPaths] } : {}),
    ...(policy.task.deniedPaths ? { deniedPaths: [...policy.task.deniedPaths] } : {}),
    ...(policy.task.acceptanceCriteria
      ? { acceptanceCriteria: [...policy.task.acceptanceCriteria] }
      : {}),
    metadata: {
      ...request.metadata,
      policyProfile: policy.governance.policyProfile,
      telemetryDestination: policy.governance.telemetryDestination
    }
  };
}

async function loadGuardrailsConfig(
  configPath: string | undefined,
  options: {
    repoRoot: string;
    invocationRoot?: string;
  }
): Promise<{ config: GuardrailsConfig | undefined; configPath: string }> {
  const resolvedPath = configPath
    ? resolveConfigPath(configPath, options.invocationRoot ?? resolveInvocationRoot())
    : join(options.repoRoot, "martin.config.yaml");
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

function resolveConfigPath(configPath: string, baseDir = resolveInvocationRoot()): string {
  const normalizedConfigPath =
    process.platform === "win32" ? configPath : configPath.replace(/\\/g, "/");

  if (isAbsolute(normalizedConfigPath)) {
    return normalizedConfigPath;
  }

  return resolve(baseDir, normalizedConfigPath);
}

function normalizePathPolicyScope(input: {
  repoRoot: string;
  allowedPaths?: string[];
  deniedPaths?: string[];
}): { allowedPaths?: string[]; deniedPaths?: string[] } {
  return {
    ...(input.allowedPaths ? { allowedPaths: normalizePathPolicyList(input.allowedPaths, "allow-path", input.repoRoot) } : {}),
    ...(input.deniedPaths ? { deniedPaths: normalizePathPolicyList(input.deniedPaths, "deny-path", input.repoRoot) } : {})
  };
}

function normalizePathPolicyList(
  values: string[],
  flagName: "allow-path" | "deny-path",
  repoRoot: string
): string[] {
  return values.map((value) => normalizePathPolicyValue(value, flagName, repoRoot));
}

function normalizePathPolicyValue(
  value: string,
  flagName: "allow-path" | "deny-path",
  repoRoot: string
): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new CliCommandError("invalid_input", `--${flagName} cannot be empty.`, {
      suggestion: `Provide a repo-relative glob for --${flagName}.`
    });
  }

  const normalizedSlashes = trimmed.replace(/\\/g, "/");
  if (isPathTraversalPattern(normalizedSlashes, repoRoot)) {
    throw new CliCommandError("invalid_input", `--${flagName} cannot escape the repository root: ${value}`, {
      suggestion: `Use repo-relative paths only (for example src/** or docs/**).`
    });
  }

  return trimmed;
}

function isPathTraversalPattern(pattern: string, repoRoot: string): boolean {
  if (isAbsolute(pattern)) {
    return true;
  }

  const segments = pattern
    .replace(/\\/g, "/")
    .split("/")
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);
  if (segments.some((segment) => segment === "..")) {
    return true;
  }

  const normalizedRoot = resolve(repoRoot);
  const resolvedPattern = resolve(normalizedRoot, pattern);
  const relativeToRoot = relative(normalizedRoot, resolvedPattern);
  return relativeToRoot === ".." || relativeToRoot.startsWith(`..${sep}`) || isAbsolute(relativeToRoot);
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
  liveMode: "live" | "proof",
  modelOverride?: string,
  mutationMode?: MutationMode,
  codexCommandOverride?: string
): MartinAdapter {
  if (runAdapterOverrideForTests) {
    return runAdapterOverrideForTests;
  }

  if (mutationMode === "verify_only") {
    return createVerifierOnlyAdapter({ workingDirectory });
  }

  if (liveMode === "proof") {
    return createStubDirectProviderAdapter({
      label: "Stub adapter (proof mode)",
      providerId: "stub",
      model: "stub"
    });
  }

  if (process.env.MARTIN_LIVE === "false") {
    return createStubDirectProviderAdapter({
      label: "Stub adapter (MARTIN_LIVE=false)",
      providerId: "stub",
      model: "stub"
    });
  }

  if (engine === "codex") {
    return createCodexCliAdapter({
      workingDirectory,
      ...(modelOverride ? { model: modelOverride } : {}),
      ...(codexCommandOverride ? { command: codexCommandOverride } : {})
    });
  }

  if (engine === "gemini") {
    return createGeminiCliAdapter({ workingDirectory, ...(modelOverride ? { model: modelOverride } : {}) });
  }

  if (engine === "openai") {
    const openAiConfig = resolveOpenAiCompatibleRuntimeConfig();
    const baseUrl = openAiConfig.baseUrl;
    const apiKey = openAiConfig.apiKey;
    const model = modelOverride ?? openAiConfig.model;
    return createOpenAiCompatibleAdapter({ baseUrl, apiKey, model, workingDirectory });
  }

  return createClaudeCliAdapter({ workingDirectory, ...(modelOverride ? { model: modelOverride } : {}) });
}

function resolveRunTimeoutMs(raw: string | undefined): number {
  if (!raw) {
    return DEFAULT_RUN_TIMEOUT_MS;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_RUN_TIMEOUT_MS;
  }
  return parsed;
}

async function runWithTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timeoutHandle: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timeoutHandle = setTimeout(() => reject(new RunTimeoutError(timeoutMs)), timeoutMs);
      })
    ]);
  } finally {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
  }
}

function buildDoctorRecommendations(input: {
  liveMode: "live" | "proof";
  engine: "claude" | "codex" | "gemini" | "openai" | string;
  claudeAvailable: boolean;
  codexAvailable: boolean;
  geminiAvailable: boolean;
  workingDirectoryReady: boolean;
  openAiRuntimeConfig?: ReturnType<typeof resolveOpenAiCompatibleRuntimeConfig>;
}): string[] {
  const recommendations = ["Run `martin preflight` before non-trivial governed coding work."];

  if (!input.workingDirectoryReady) {
    recommendations.push("Point `--cwd` at a valid repository before running Martin.");
  }

  if (input.liveMode === "live" && input.engine === "openai") {
    const openAiRuntimeConfig = input.openAiRuntimeConfig ?? resolveOpenAiCompatibleRuntimeConfig();
    if (!process.env["MARTIN_OPENAI_MODEL"] && openAiRuntimeConfig.endpointKind !== "hosted_openai") {
      recommendations.push("Set MARTIN_OPENAI_MODEL for the selected OpenAI-compatible endpoint.");
    }
    if (!openAiRuntimeConfig.authReady) {
      recommendations.push(
        openAiRuntimeConfig.endpointKind === "hosted_openai"
          ? "Set MARTIN_OPENAI_API_KEY for OpenAI's hosted endpoint."
          : "Set MARTIN_OPENAI_API_KEY for the configured remote OpenAI-compatible endpoint."
      );
    }
  }

  if (input.liveMode === "live" && input.engine === "claude" && !input.claudeAvailable) {
    recommendations.push("Install or expose the Claude CLI on PATH, or switch to `--engine codex` or `--engine openai`.");
  }

  if (input.liveMode === "live" && input.engine === "codex" && !input.codexAvailable) {
    recommendations.push("Install or expose the Codex CLI on PATH, or set MARTIN_LIVE=false while iterating locally.");
  }

  if (input.liveMode === "live" && input.engine === "gemini" && !input.geminiAvailable) {
    recommendations.push("Install or expose the Gemini CLI on PATH, or set MARTIN_LIVE=false while iterating locally.");
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
  const input = command.selector
    ? proofCardInputFromLoop((await loadPersistedLoop(command.selector)).loop)
    : defaultChallengeProofCardInput();
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
      svg
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
      ``,
      card.evidenceLine
    ],
    quiet: input.loopId
  });
}

function proofCardInputFromLoop(
  loop: LoopRecord,
  options: { trustworthy?: boolean; integrityState?: string } = {}
): MartinProofCardInput {
  const verification = buildVerificationSummary(loop);
  const rollbackStatus = loop.artifacts.some((artifact) =>
    artifact.kind.toLowerCase().includes("rollback")
  )
    ? "captured"
    : "not-recorded";
  const trustworthy = options.trustworthy ?? true;
  const untrustedLabel = options.integrityState
    ? `untrusted (${options.integrityState})`
    : "untrusted";
  const remainingBudget = Math.max(0, loop.budget.maxUsd - loop.cost.actualUsd);
  const overspendRatio =
    loop.budget.maxUsd > 0 ? `${(loop.cost.actualUsd / loop.budget.maxUsd).toFixed(2)}x` : "unknown";
  const verificationStepCount = loop.events.filter((event) => event.type === "verification.completed").length;
  const latestAttempt = loop.attempts.at(-1);
  const runtime = latestAttempt
    ? `${latestAttempt.adapterId} / ${latestAttempt.model}`
    : loop.events
        .map((event) => event.payload)
        .find((payload) => typeof payload["adapterId"] === "string" || typeof payload["model"] === "string");
  const runtimeLabel =
    typeof runtime === "string"
      ? runtime
      : runtime
        ? `${String(runtime["adapterId"] ?? "unknown")} / ${String(runtime["model"] ?? "unknown")}`
        : "not recorded";

  return {
    loopId: loop.loopId,
    objective: loop.task.objective,
    status: trustworthy ? loop.status : untrustedLabel,
    lifecycle: trustworthy ? loop.lifecycleState : untrustedLabel,
    verifierStatus: trustworthy ? verification.status : "untrusted",
    costSpend: trustworthy ? `$${loop.cost.actualUsd.toFixed(2)}` : "untrusted",
    budget: trustworthy ? `$${loop.budget.maxUsd.toFixed(2)}` : "untrusted",
    remainingBudget: trustworthy ? `$${remainingBudget.toFixed(2)}` : "untrusted",
    overspendRatio: trustworthy ? overspendRatio : "untrusted",
    attempts: loop.attempts.length,
    rollbackStatus,
    verificationStepCount: trustworthy ? verificationStepCount : "untrusted",
    runMode: trustworthy ? loop.task.mutationMode ?? "not recorded" : "untrusted",
    runtime: trustworthy ? runtimeLabel : "untrusted",
    timelineEvents: trustworthy ? loop.events.map((event) => event.type) : ["run.started", "run.completed"],
    haltReason: trustworthy ? latestExitReason(loop) : "untrusted",
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
    remainingBudget: "$0.70",
    overspendRatio: "0.77x",
    attempts: 2,
    rollbackStatus: "captured",
    verificationStepCount: 1,
    runMode: "mutating",
    runtime: "demo / local-fixture",
    timelineEvents: ["run.started", "attempt.started", "verification.completed", "budget.updated", "run.completed"],
    haltReason: "verifier_passed",
    evidenceBoundaryNotes: [
      "Generated from a local Martin Loop run record.",
      "Hosted dashboards and private team telemetry are intentionally excluded from OSS proof cards."
    ],
    generatedAt: new Date().toISOString()
  };
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

  await mkdir(outputDir, { recursive: true });

  const files = {
    receiptJson: join(outputDir, "run-receipt.json"),
    receiptMarkdown: join(outputDir, "run-receipt.md"),
    proofCardSvg: join(outputDir, "proof-card.svg")
  };

  await writeFile(files.receiptJson, `${JSON.stringify(shareBundle.receipt, null, 2)}\n`, "utf8");
  await writeFile(files.receiptMarkdown, shareBundle.markdown, "utf8");
  await writeFile(files.proofCardSvg, shareBundle.svg, "utf8");

  return renderCliSuccess(outputMode, {
    data: {
      command: "share",
      loopId: detail.loop.loopId,
      outputDir,
      files,
      receipt: shareBundle.receipt
    },
    human: [
      `Share bundle written for ${detail.loop.loopId}`,
      `Output directory: ${outputDir}`,
      `JSON receipt: ${files.receiptJson}`,
      `Markdown receipt: ${files.receiptMarkdown}`,
      `Proof card SVG: ${files.proofCardSvg}`
    ],
    quiet: outputDir,
    warnings: dedupeWarnings([...selected.warnings, ...detail.warnings, ...shareBundle.warnings])
  });
}

function buildShareBundle(detail: Awaited<ReturnType<typeof loadPersistedLoop>>): {
  receipt: Record<string, unknown>;
  markdown: string;
  svg: string;
  warnings: string[];
} {
  const dossier = buildRunDossier(detail);
  const verification = buildVerificationSummary(detail.loop);
  const trustworthy = detail.integrity.state === "verified";
  const card = buildMartinProofCard(
    proofCardInputFromLoop(detail.loop, {
      trustworthy,
      integrityState: detail.integrity.state
    })
  );
  const receiptWarnings = dedupeWarnings([...detail.warnings, ...verification.warnings]);
  const receiptLoop = trustworthy
    ? {
        loopId: detail.loop.loopId,
        title: detail.loop.task.title,
        objective: detail.loop.task.objective,
        status: detail.loop.status,
        lifecycleState: detail.loop.lifecycleState,
        updatedAt: detail.loop.updatedAt,
        attempts: detail.loop.attempts.length,
        spendUsd: detail.loop.cost.actualUsd,
        budgetUsd: detail.loop.budget.maxUsd
      }
    : {
        loopId: detail.loop.loopId,
        title: detail.loop.task.title,
        objective: detail.loop.task.objective,
        status: "untrusted",
        lifecycleState: "untrusted",
        updatedAt: detail.loop.updatedAt,
        attempts: detail.loop.attempts.length,
        spendUsd: null,
        budgetUsd: null,
        trustNotice: `Sensitive fields are suppressed because receipt integrity is ${detail.integrity.state}.`
      };
  const shareReceipt = trustworthy
    ? dossier["receipt"]
    : {
        trustworthy: false,
        receiptIntegrity: detail.integrity,
        nextSafeAction: `Verify canonical receipt integrity for loop ${detail.loop.loopId} before sharing proof or cost claims.`,
        notice: `Receipt details are redacted because integrity is ${detail.integrity.state}.`
      };
  const shareVerification = trustworthy
    ? dossier["verification"]
    : {
        status: "untrusted",
        summary: `Verification details are untrusted because receipt integrity is ${detail.integrity.state}.`,
        warnings: receiptWarnings
      };
  const receipt = redactShareValue({
    schemaVersion: "martin.share-receipt.v1",
    generatedAt: new Date().toISOString(),
    loop: receiptLoop,
    receiptIntegrity: detail.integrity,
    verification: shareVerification,
    receipt: shareReceipt,
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
    markdown: renderShareReceiptMarkdown({
      loop: detail.loop,
      card,
      verification,
      receipt: receipt["receipt"] as {
        nextSafeAction?: string;
      },
      receiptIntegrity: detail.integrity.state,
      warnings: receiptWarnings
    }),
    svg: renderMartinProofCardSvg(card),
    warnings: receiptWarnings
  };
}

function renderShareReceiptMarkdown(input: {
  loop: LoopRecord;
  card: ReturnType<typeof buildMartinProofCard>;
  verification: ReturnType<typeof buildVerificationSummary>;
  receipt: {
    nextSafeAction?: string;
  };
  receiptIntegrity: string;
  warnings: string[];
}): string {
  const proofCardMarkdown = renderMartinProofCardMarkdown(input.card).trimEnd();
  return [
    "# Martin Loop Share Receipt",
    "",
    `Generated from local Martin Loop evidence for loop ${redactAbsolutePaths(input.loop.loopId)}.`,
    "",
    `- Status: ${redactAbsolutePaths(input.loop.status)} / ${redactAbsolutePaths(input.loop.lifecycleState)}`,
    `- Receipt integrity: ${redactAbsolutePaths(input.receiptIntegrity)}`,
    `- Verification: ${redactAbsolutePaths(input.verification.status)}`,
    `- Attempts: ${String(input.loop.attempts.length)}`,
    `- Next safe action: ${redactAbsolutePaths(input.receipt.nextSafeAction ?? "Run preflight before the next attempt.")}`,
    "",
    "## Proof Card",
    "",
    proofCardMarkdown,
    ...(input.warnings.length > 0
      ? ["", "## Warnings", "", ...input.warnings.map((warning) => `- ${redactAbsolutePaths(warning)}`)]
      : []),
    "",
    "## Notes",
    "",
    "- This bundle is generated from local Martin Loop run evidence.",
    "- Absolute machine paths are redacted so the receipt can be shared without leaking workstation details.",
    ""
  ].join("\n");
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
  const input = await buildLocalReliabilityScoreInput();
  const score = computeMartinReliabilityScore(input);
  const svg = renderMartinReliabilityBadgeSvg(score);
  const json = renderMartinReliabilityBadgeJson(score);

  if (command.format === "svg" && outputMode === "human") {
    return { exitCode: 0, stdout: svg, stderr: "" };
  }

  if (command.format === "json" && outputMode === "human") {
    return { exitCode: 0, stdout: JSON.stringify(json, null, 2), stderr: "" };
  }

  return renderCliSuccess(outputMode, {
    data: { command: "badge", score, svg, json },
    human: [
      `Martin Loop agent reliability readiness: ${score.points}/${score.maxPoints} (${score.grade})`,
      score.summary,
      ...(score.missingReasons.length > 0 ? ["", "Missing:", ...score.missingReasons.map((r) => `  • ${r}`)] : [])
    ],
    quiet: score.grade
  });
}

async function buildLocalReliabilityScoreInput(): Promise<MartinReliabilityScoreInput> {
  const environment = resolveCliEnvironment();
  const shouldInspectRunStore = process.env["MARTIN_RUNS_DIR"] !== undefined;
  const loops = shouldInspectRunStore
    ? await listPersistedLoops({ limit: 20 }).catch(() => ({ loops: [] as LoopRecord[] }))
    : { loops: [] as LoopRecord[] };
  const latestPersisted = shouldInspectRunStore
    ? await loadPersistedLoop({ latest: true }).catch(() => null)
    : null;
  const latestLoop = latestPersisted?.loop ?? loops.loops[0];
  const configPath = join(environment.invocationRoot, "martin.config.yaml");
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

