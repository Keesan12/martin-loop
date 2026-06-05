import { cp, mkdir, readFile, readdir, rm, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  createClaudeCliAdapter,
  createCodexCliAdapter,
  createOpenAiCompatibleAdapter,
  createStubDirectProviderAdapter,
  createVerifierOnlyAdapter
} from "@martin/adapters";
import { runMartin, type MartinAdapter } from "@martin/core";
import {
  buildPortfolioSnapshot,
  createLoopRecord,
  type LoopBudget,
  type LoopRecord,
  type MartinOutputMode,
  type MartinRunListFilters,
  type MartinRunSelector,
  type MutationMode
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
  triagePersistedLoops
} from "./run-store.js";
import { CliCommandError, renderCliError, renderCliSuccess } from "./ux.js";
import {
  consumeFirstRunBanner,
  evaluateCliRunGate,
  recordCliWorkflowStep
} from "./workflow-state.js";

const require = createRequire(import.meta.url);
const packageJson = require("../package.json") as { version: string };

export type RunCommandRequest = {
  workspaceId: string;
  projectId: string;
  title: string;
  objective: string;
  verificationPlan: string[];
  metadata: Record<string, string>;
  budget: LoopBudget;
  configPath?: string;
  cwd?: string;
  model?: string;
  engine?: string;
  mutationMode?: MutationMode;
  allowedPaths?: string[];
  deniedPaths?: string[];
  acceptanceCriteria?: string[];
  allowUngovernedRun?: boolean;
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
  engine?: "claude" | "codex" | "openai";
  configPath?: string;
};

type StartCommand = {
  command: "start";
  cwd?: string;
  runsDir?: string;
  host?: MartinMcpHost;
};

type GuideTopic =
  | "start"
  | "tour"
  | "doctor"
  | "demo"
  | "session-start"
  | "plan"
  | "preflight"
  | "run"
  | "dossier"
  | "mcp";

type GuideCommand = {
  command: "guide";
  topic?: GuideTopic;
  host?: MartinMcpHost;
};

type TourCommand = {
  command: "tour";
  host?: MartinMcpHost;
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

type BadgeCommand = {
  command: "badge";
  format: "svg" | "json";
};

export type ParsedCliArguments =
  | {
      command: "help";
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
  | GuideCommand
  | TourCommand
  | NativePhaseCommand
  | PreflightCommand
  | TriageCommand
  | DossierCommand
  | RunsCommand
  | McpCommand
  | ChallengeCommand
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
    const firstRunBanner =
      outputMode === "human"
        ? await resolveFirstRunBanner(parsed, global.commandArgs)
        : undefined;

    let result:
      | {
          exitCode: number;
          stdout: string;
          stderr: string;
        }
      | undefined;

    switch (parsed.command) {
      case "help":
        result = {
          exitCode: 0,
          stdout: renderCliHelp(),
          stderr: ""
        };
        break;
      case "bench":
        result = {
          exitCode: 1,
          stdout: "",
          stderr:
            "The benchmark harness remains a workspace-only RC surface and is not part of the publishable @martin/cli boundary yet. Use pnpm --filter @martin/benchmarks test or pnpm --filter @martin/benchmarks eval:phase12 from the repo root instead."
        };
        break;
      case "demo": {
        const targetDirectory = await createDemoWorkspace({
          targetDirectory: parsed.directory,
          force: parsed.force
        });

        result = renderCliSuccess(outputMode, {
          data: {
            command: "demo",
            targetDirectory
          },
          human: renderDemoInstructions(targetDirectory),
          quiet: targetDirectory
        });
        break;
      }
      case "run":
        result = await executeRunCommand(parsed.request, outputMode);
        break;
      case "inspect":
        result = await executeInspectCommand(parsed, outputMode);
        break;
      case "resume":
        result = await executeResumeCommand(parsed, outputMode);
        break;
      case "doctor":
        result = await executeDoctorCommand(parsed, outputMode);
        break;
      case "start":
        result = await executeStartCommand(parsed, outputMode);
        break;
      case "guide":
        result = await executeGuideCommand(parsed, outputMode);
        break;
      case "tour":
        result = await executeTourCommand(parsed, outputMode);
        break;
      case "native_phase":
        result = await executeNativePhaseCommand(parsed, outputMode);
        break;
      case "preflight":
        result = await executePreflightCommand(parsed.request, outputMode);
        break;
      case "triage":
        result = await executeTriageCommand(parsed.filters, outputMode);
        break;
      case "dossier":
        result = await executeDossierCommand(parsed.selector, outputMode);
        break;
      case "runs_list":
        result = await executeRunsListCommand(parsed.filters, outputMode);
        break;
      case "runs_get":
        result = await executeRunsGetCommand(parsed.selector, outputMode);
        break;
      case "runs_attempt":
        result = await executeRunsAttemptCommand(parsed.selector, outputMode);
        break;
      case "runs_verify":
        result = await executeRunsVerifyCommand(parsed.selector, outputMode);
        break;
      case "mcp_print_config":
        result = await executeMcpPrintConfigCommand(parsed, outputMode);
        break;
      case "mcp_install":
        result = await executeMcpInstallCommand(parsed, outputMode);
        break;
      case "challenge":
        result = await executeChallengeCommand(parsed, outputMode);
        break;
      case "badge":
        result = await executeBadgeCommand(parsed, outputMode);
        break;
    }

    if (!result) {
      throw new CliCommandError("invalid_input", "Martin did not resolve a command result.");
    }

    return prependFirstRunBanner(result, firstRunBanner, outputMode);
  } catch (error) {
    return renderCliError(outputMode, error);
  }
}

export function parseCliArguments(args: string[]): ParsedCliArguments {
  const [command, ...rest] = args;

  if (!command || command === "help" || command === "--help" || command === "-h") {
    return { command: "help" };
  }

  if (command === "run" || command === "preflight") {
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
      ...(readOption(rest, "--engine") === "openai" ? { engine: "openai" as const } : {})
    };
  }

  if (command === "start") {
    const host = parseOptionalMcpHost(rest);
    return {
      command: "start",
      ...(readOption(rest, "--cwd") ? { cwd: readOption(rest, "--cwd") } : {}),
      ...(readOption(rest, "--runs-dir") ? { runsDir: readOption(rest, "--runs-dir") } : {}),
      ...(host ? { host } : {})
    };
  }

  if (command === "guide") {
    const host = parseOptionalMcpHost(rest);
    const topic = parseGuideTopic(rest);
    return {
      command: "guide",
      ...(host ? { host } : {}),
      ...(topic ? { topic } : {})
    };
  }

  if (command === "tour") {
    const host = parseOptionalMcpHost(rest);
    return {
      command: "tour",
      ...(host ? { host } : {})
    };
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
        selector: parseRunSelector(subcommandArgs, { allowLatest: false })
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

  if (command === "badge") {
    return {
      command: "badge",
      format: parseBadgeFormat(rest)
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
    "  martin start [--host <codex|claude|gemini|generic>] [options]",
    "  martin tour [--host <codex|claude|gemini|generic>]",
    "  martin guide [start|tour|doctor|demo|session-start|plan|preflight|run|dossier|mcp] [--host <codex|claude|gemini|generic>]",
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
    "  martin badge [--format svg|json]",
    "",
    "Operator commands:",
    "  start        Guided onboarding for humans and MCP hosts; picks the safest next command.",
    "  tour         Interactive product tour with commands, expected output, and a safe demo path.",
    "  guide        Explain what each Martin command does and which one to use next.",
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
    "",
    "Phase command-center options:",
    "  --cwd <path>             Repo root containing phase state; imports .gsd state when present.",
    "  --runs-dir <path>        Override the Martin runs root.",
    "  --host <name>            Host name for session-start guidance.",
    "  --run-scan-limit <n>     Max recent run directories to inspect (default: 40).",
    "  --execute                Execute generated preflight/run command after contract validation.",
    "",
    "MCP config options:",
    "  --host <name>            codex, claude, gemini, or generic.",
    "  --scope <name>           user or project for all hosts; Claude also supports local.",
    "  --transport <name>       stdio (default).",
    "  --profile <name>         minimal (default), diagnostic, github-review, full-local, starter, or full.",
    "  --platform <name>        windows, macos, or linux recipe shaping.",
    "",
    "Run options:",
    "  --engine <name>          Adapter: claude (default), codex, or openai.",
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
    "  --unsafe-allow-unguarded-run  Override the local governance gate for this one run.",
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
    engine: resolvedRequest.engine
  });
  const allowUngovernedRun =
    resolvedRequest.allowUngovernedRun === true ||
    process.env["MARTIN_ALLOW_UNGUARDED_RUN"] === "true";
  if (!allowUngovernedRun) {
    const gate = await evaluateCliRunGate({
      runsRoot: cliEnvironment.runsRoot,
      workingDirectory: cliEnvironment.workingDirectory,
      objective: resolvedRequest.objective,
      engine: resolvedRequest.engine,
      verificationPlan: resolvedRequest.verificationPlan,
      mutationMode: resolvedRequest.mutationMode
    });

    if (!gate.allowed) {
      throw new CliCommandError("policy_blocked", gate.message, {
        suggestion: `${gate.nextCommand}${outputMode === "human" ? "\nNeed the guided walkthrough? Run `martin tour`." : ""}`,
        details: {
          missingSteps: gate.missingSteps,
          nextCommand: gate.nextCommand
        }
      });
    }
  }

  const adapter = selectAdapter(
    resolvedRequest.engine,
    cliEnvironment.workingDirectory,
    resolvedRequest.model,
    resolvedRequest.mutationMode
  );

  let result: Awaited<ReturnType<typeof runMartin>>;
  try {
    result = await runMartin({
      workspaceId: resolvedRequest.workspaceId,
      projectId: resolvedRequest.projectId,
      task: {
        title: resolvedRequest.title,
        objective: resolvedRequest.objective,
        verificationPlan: resolvedRequest.verificationPlan,
        ...(resolvedRequest.mutationMode ? { mutationMode: resolvedRequest.mutationMode } : {}),
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
        ...(resolvedRequest.mutationMode ? { mutationMode: resolvedRequest.mutationMode } : {}),
        repoRoot: cliEnvironment.workingDirectory
      },
      budget: resolvedRequest.budget,
      metadata: resolvedRequest.metadata,
      status: "exited",
      lifecycleState: "human_escalation"
    });

    await persistLoopArtifacts(fallbackLoop, { runsRoot: cliEnvironment.runsRoot }).catch(() => {});

    throw new CliCommandError("environment", "Martin could not start the requested execution adapter.", {
      suggestion:
        "Run `martin doctor` to verify engine availability, or set MARTIN_LIVE=false to use the stub adapter locally.",
      details: {
        loopId: fallbackLoop.loopId,
        reason: error instanceof Error ? error.message : String(error)
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
      governance: {
        hardGate: true,
        allowUngovernedRun
      }
    },
    human: [
      `Started Martin Loop run ${result.loop.loopId}`,
      `Status: ${result.loop.status} / ${result.loop.lifecycleState}`,
      `Working directory: ${cliEnvironment.workingDirectory}`,
      `Runs root: ${cliEnvironment.runsRoot}`,
      `Verification plan: ${resolvedRequest.verificationPlan.join(", ") || "none"}`,
      `Governance gate: ${allowUngovernedRun ? "unsafe override used" : "receipts verified"}`,
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
    : join(environment.invocationRoot, "martin.config.yaml");
  const configExists = await stat(configPath).then(() => true).catch(() => false);
  const workingDirectoryReady = await stat(environment.workingDirectory).then(() => true).catch(() => false);
  const runsRootReady = await stat(environment.runsRoot).then(() => true).catch(() => false);
  const claudeAvailable = isCommandAvailable("claude");
  const codexAvailable = isCommandAvailable("codex");
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

  const data = {
    command: "doctor",
    cliVersion: packageJson.version,
    environment,
    config: {
      path: configPath,
      exists: configExists
    },
    engines: {
      claude: { available: claudeAvailable },
      codex: { available: codexAvailable }
    },
    starterTools: [...MARTIN_STARTER_TOOLS],
    profiles: {
      minimal: [...MARTIN_MINIMAL_TOOLS],
      diagnostic: [...MARTIN_DIAGNOSTIC_TOOLS],
      "full-local": [...MARTIN_FULL_TOOLS],
      starter: [...MARTIN_STARTER_TOOLS],
      full: [...MARTIN_FULL_TOOLS]
    },
    bestNextCommand: selectBestNextCommand({
      workingDirectoryReady,
      hasCodex: codexAvailable,
      hasClaude: claudeAvailable
    }),
    recommendations: buildDoctorRecommendations({
      liveMode: environment.liveMode,
      engine: environment.engine,
      claudeAvailable,
      codexAvailable,
      workingDirectoryReady
    })
  };
  await recordCliWorkflowStep({
    runsRoot: environment.runsRoot,
    step: "doctor",
    workingDirectory: environment.workingDirectory,
    engine: environment.engine
  }).catch(() => {});

  return renderCliSuccess(outputMode, {
    data,
    human: renderDoctorHuman({
      environment,
      workingDirectoryReady,
      runsRootReady,
      claudeAvailable,
      codexAvailable,
      configExists,
      configPath
    }),
    quiet: environment.runsRoot,
    warnings
  });
}

async function executeStartCommand(
  command: StartCommand,
  outputMode: MartinOutputMode
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const environment = resolveCliEnvironment({ cwd: command.cwd });
  const codexAvailable = isCommandAvailable("codex");
  const claudeAvailable = isCommandAvailable("claude");
  const geminiAvailable = isCommandAvailable("gemini");
  const workingDirectoryReady = await stat(environment.workingDirectory).then(() => true).catch(() => false);
  const snapshot = await createNativePhaseCommandCenterSnapshot({
    rootDir: command.cwd,
    runsDir: command.runsDir,
    host: command.host ?? "codex"
  }).catch(() => null);
  const bestNextCommand =
    snapshot?.sessionStart.recommendedNextAction ??
    selectBestNextCommand({
      workingDirectoryReady,
      hasCodex: codexAvailable,
      hasClaude: claudeAvailable
    });

  const availableHosts = [
    codexAvailable ? "codex" : null,
    claudeAvailable ? "claude" : null,
    geminiAvailable ? "gemini" : null,
    "generic"
  ].filter((host): host is string => host !== null);
  await recordCliWorkflowStep({
    runsRoot: environment.runsRoot,
    step: "start",
    workingDirectory: environment.workingDirectory
  }).catch(() => {});

  return renderCliSuccess(outputMode, {
    data: {
      command: "start",
      cliVersion: packageJson.version,
      workingDirectory: environment.workingDirectory,
      runsRoot: environment.runsRoot,
      liveMode: environment.liveMode,
      availableHosts,
      bestNextCommand,
      tourCommand: "martin tour",
      recommendedFlow: [
        "martin tour",
        "martin doctor",
        "martin session-start",
        'martin phase contract --json',
        'martin phase preflight',
        'martin dossier --latest'
      ],
      hostBootstrap: buildHostBootstrapPlan({
        preferredHost: command.host,
        codexAvailable,
        claudeAvailable,
        geminiAvailable
      })
    },
    human: buildStartHuman({
      bestNextCommand,
      workingDirectoryReady,
      preferredHost: command.host,
      codexAvailable,
      claudeAvailable,
      geminiAvailable,
      sessionHint: snapshot?.sessionStart.recommendedNextAction
    }),
    quiet: bestNextCommand
  });
}

async function executeGuideCommand(
  command: GuideCommand,
  outputMode: MartinOutputMode
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const environment = resolveCliEnvironment({});
  const commandMap = buildGuideCommandMap(command.host);
  const selected = command.topic
    ? commandMap.find((entry) => entry.topic === command.topic)
    : undefined;
  await recordCliWorkflowStep({
    runsRoot: environment.runsRoot,
    step: "guide",
    workingDirectory: environment.workingDirectory
  }).catch(() => {});

  return renderCliSuccess(outputMode, {
    data: {
      command: "guide",
      topic: command.topic ?? "overview",
      host: command.host ?? "codex",
      recommendedSequence: [
        "martin start",
        "martin tour",
        "martin doctor",
        "martin session-start",
        "martin phase contract --json",
        "martin phase preflight",
        "martin run <objective> --verify <command>",
        "martin dossier --latest"
      ],
      commandMap
    },
    human: selected ? renderGuideTopic(selected) : renderGuideOverview(commandMap, command.host),
    quiet: selected?.command ?? "martin start"
  });
}

async function executeTourCommand(
  command: TourCommand,
  outputMode: MartinOutputMode
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const environment = resolveCliEnvironment({});
  const hostBootstrap = buildHostBootstrapPlan({
    preferredHost: command.host,
    codexAvailable: true,
    claudeAvailable: true,
    geminiAvailable: true
  });
  const steps = buildTourSteps(command.host);

  await recordCliWorkflowStep({
    runsRoot: environment.runsRoot,
    step: "tour",
    workingDirectory: environment.workingDirectory
  }).catch(() => {});

  return renderCliSuccess(outputMode, {
    data: {
      command: "tour",
      host: hostBootstrap.host,
      steps,
      demoCommand: "martin demo",
      hostBootstrap
    },
    human: renderTourHuman(steps, hostBootstrap),
    quiet: "martin doctor"
  });
}

async function executeNativePhaseCommand(
  command: NativePhaseCommand,
  outputMode: MartinOutputMode
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const snapshot = await createNativePhaseCommandCenterSnapshot({
    rootDir: command.cwd,
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

    const request = buildNativePhaseRunRequest(snapshot.contract, command.cwd);
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
      workingDirectory: environment.workingDirectory
    }).catch(() => {});
  }
  if (command.subcommand === "preflight" && !snapshot.contract.requiresApproval) {
    const environment = resolveCliEnvironment({
      cwd: command.cwd,
      runsDir: command.runsDir
    });
    const request = buildNativePhaseRunRequest(snapshot.contract, command.cwd);
    await recordCliWorkflowStep({
      runsRoot: environment.runsRoot,
      step: "preflight",
      workingDirectory: environment.workingDirectory,
      objective: request.objective,
      engine: "claude",
      verificationPlan: request.verificationPlan
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
    engine: request.engine
  });
  const warnings: string[] = [];
  const blockingIssues: string[] = [];
  const verificationPlan =
    request.verificationPlan.length > 0
      ? request.verificationPlan
      : resolvedGuardrails.verifierRules;

  const workingDirectoryExists = await stat(environment.workingDirectory).then(() => true).catch(() => false);
  if (!workingDirectoryExists) {
    blockingIssues.push("Working directory does not exist.");
  }

  const engineRequired = request.mutationMode !== "verify_only" && environment.liveMode === "live";
  if (engineRequired && environment.engine === "claude" && !isCommandAvailable("claude")) {
    blockingIssues.push("Claude CLI is not available on PATH.");
  }
  if (engineRequired && environment.engine === "codex" && !isCommandAvailable("codex")) {
    blockingIssues.push("Codex CLI is not available on PATH.");
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
  const corpusRisk = await readLocalCorpusRisk().catch(() => ({ hotspots: [], corpusRecords: 0, corpusPath: "" }));
  const scopeHotspots = corpusRisk.hotspots.filter(
    (hotspot) => hotspot.scopeFingerprint === scopeFingerprint
  ).slice(0, 3);

  for (const hotspot of scopeHotspots) {
    const pct = Math.round(hotspot.failureRate * 100);
    const classes = hotspot.commonFailureClasses.length > 0
      ? ` (${hotspot.commonFailureClasses.join(", ")})`
      : "";
    warnings.push(
      `Corpus risk: this scope has a ${pct}% failure rate across ${hotspot.sampleSize} recorded runs${classes}. Risk score: ${hotspot.riskScore}.`
    );
  }

  const ready = blockingIssues.length === 0;
  if (ready) {
    await recordCliWorkflowStep({
      runsRoot: environment.runsRoot,
      step: "preflight",
      workingDirectory: environment.workingDirectory,
      objective: request.objective,
      engine: environment.engine,
      verificationPlan
    }).catch(() => {});
  }
  const data = {
    command: "preflight",
    ready,
    blockingIssues,
    warnings,
    environment,
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

  const corpusLine = corpusRisk.corpusRecords > 0
    ? `Corpus: ${corpusRisk.corpusRecords} records${scopeHotspots.length > 0 ? `, ${scopeHotspots.length} scope hotspot(s)` : ", no scope hotspots"}`
    : `Corpus: no data yet — run Martin to start building prediction intelligence`;

  return renderCliSuccess(outputMode, {
    data,
    human: [
      `Preflight ${ready ? "passed" : "blocked"} for ${request.title}`,
      `Working directory: ${environment.workingDirectory}`,
      `Engine: ${environment.engine} (${environment.liveMode})`,
      `Verification plan: ${verificationPlan.join(", ") || "none"}`,
      corpusLine,
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
    warnings: detail.warnings
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

  return renderCliSuccess(outputMode, {
    data: {
      command: "runs_get",
      source: detail.source,
      loop: detail.loop,
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
    warnings: detail.warnings
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

  return renderCliSuccess(outputMode, {
    data: {
      command: "runs_verify",
      loopId: detail.loop.loopId,
      source: detail.source,
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
  const request: Partial<RunCommandRequest> = {
    verificationPlan,
    metadata,
    budget: { ...DEFAULT_BUDGET }
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
        index += 1;
        break;
      case "--soft-limit-usd":
        request.budget = {
          ...request.budget,
          softLimitUsd: Number(next)
        } as LoopBudget;
        index += 1;
        break;
      case "--max-iterations":
        request.budget = {
          ...request.budget,
          maxIterations: Number(next)
        } as LoopBudget;
        index += 1;
        break;
      case "--max-tokens":
        request.budget = {
          ...request.budget,
          maxTokens: Number(next)
        } as LoopBudget;
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
      case "--verify-only":
        request.mutationMode = "verify_only";
        break;
      case "--unsafe-allow-unguarded-run":
        request.allowUngovernedRun = true;
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
    ...(request.configPath ? { configPath: request.configPath } : {}),
    ...(request.cwd ? { cwd: request.cwd } : {}),
    ...(request.model ? { model: request.model } : {}),
    ...(request.engine ? { engine: request.engine } : {}),
    ...(request.mutationMode ? { mutationMode: request.mutationMode } : {}),
    ...(request.allowedPaths?.length ? { allowedPaths: request.allowedPaths } : {}),
    ...(request.deniedPaths?.length ? { deniedPaths: request.deniedPaths } : {}),
    ...(request.acceptanceCriteria?.length ? { acceptanceCriteria: request.acceptanceCriteria } : {}),
    ...(request.allowUngovernedRun ? { allowUngovernedRun: true } : {})
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

function parseOptionalMcpHost(tokens: string[]): MartinMcpHost | undefined {
  const host = readOption(tokens, "--host");
  if (host === undefined) {
    return undefined;
  }

  if (
    host === "codex" || host === "claude" || host === "gemini" || host === "generic" ||
    host === "cursor" || host === "copilot" || host === "continue"
  ) {
    return host;
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

function renderDoctorHuman(input: {
  environment: ReturnType<typeof resolveCliEnvironment>;
  workingDirectoryReady: boolean;
  runsRootReady: boolean;
  claudeAvailable: boolean;
  codexAvailable: boolean;
  configExists: boolean;
  configPath: string;
}): string[] {
  const bestNextCommand = selectBestNextCommand({
    workingDirectoryReady: input.workingDirectoryReady,
    hasCodex: input.codexAvailable,
    hasClaude: input.claudeAvailable
  });

  return [
    `Martin CLI doctor (${packageJson.version})`,
    `Working directory: ${input.environment.workingDirectory} (${input.workingDirectoryReady ? "ready" : "missing"})`,
    `Runs root: ${input.environment.runsRoot} (${input.runsRootReady ? "ready" : "not created yet"})`,
    `Live mode: ${input.environment.liveMode}`,
    `Claude CLI: ${input.claudeAvailable ? "available" : "missing"}`,
    `Codex CLI: ${input.codexAvailable ? "available" : "missing"}`,
    `Config: ${input.configExists ? input.configPath : `not found at ${input.configPath}`}`,
    "",
    `Best next command: ${bestNextCommand}`,
    "Agent-native path:",
    "  martin session-start",
    "  martin phase contract --json",
    "  martin phase preflight",
    "",
    "Human-first proof path:",
    "  martin demo",
    "  martin dossier --latest"
  ];
}

function buildStartHuman(input: {
  bestNextCommand: string;
  workingDirectoryReady: boolean;
  preferredHost?: MartinMcpHost;
  codexAvailable: boolean;
  claudeAvailable: boolean;
  geminiAvailable: boolean;
  sessionHint?: string;
}): string[] {
  const hostPlan = buildHostBootstrapPlan({
    preferredHost: input.preferredHost,
    codexAvailable: input.codexAvailable,
    claudeAvailable: input.claudeAvailable,
    geminiAvailable: input.geminiAvailable
  });

  return [
    `Martin Loop start (${packageJson.version})`,
    input.workingDirectoryReady
      ? "Current working directory looks ready for local MartinLoop commands."
      : "No ready working directory detected yet. Use the demo path first or point Martin at a repo with --cwd.",
    `Best next command: ${input.bestNextCommand}`,
    ...(input.sessionHint && input.sessionHint !== input.bestNextCommand
      ? [`Session hint: ${input.sessionHint}`]
      : []),
    "",
    "Need the interactive product tour?",
    "  martin tour",
    "Need the static command map?",
    "  martin guide",
    "",
    "Safe local flow:",
    "  martin doctor",
    "  martin session-start",
    "  martin phase contract --json",
    "  martin phase preflight",
    "  martin dossier --latest",
    "",
    "No-spend proof path:",
    "  martin demo",
    '  MARTIN_LIVE=false martin run "Summarize the demo workspace and confirm the verifier is green" --verify "npm test"',
    "",
    `Recommended MCP bootstrap: ${hostPlan.installCommand}`,
    `Preview config: ${hostPlan.printConfigCommand}`
  ];
}

function buildTourSteps(host?: MartinMcpHost): Array<{
  step: number;
  command: string;
  why: string;
  expected: string;
}> {
  const bootstrap = buildHostBootstrapPlan({
    preferredHost: host,
    codexAvailable: true,
    claudeAvailable: true,
    geminiAvailable: true
  });

  return [
    {
      step: 1,
      command: "martin start",
      why: "See the safest next command for this repo and your preferred host.",
      expected: "You get the recommended flow plus one MCP bootstrap path."
    },
    {
      step: 2,
      command: "martin doctor",
      why: "Confirm the working directory, runs root, engine availability, and local policy posture.",
      expected: "Doctor prints readiness plus the best next command."
    },
    {
      step: 3,
      command: "martin demo",
      why: "Create a disposable workspace so you can learn the flow without risking a real repo.",
      expected: "A local martin-loop-demo directory is created with safe task ideas."
    },
    {
      step: 4,
      command: "martin session-start",
      why: "Get the current local run state and the next governed action before doing real work.",
      expected: "Session-start prints the recommended next action and phase hints."
    },
    {
      step: 5,
      command: "martin phase contract --json",
      why: "Turn the local plan into an explicit governed contract.",
      expected: "You see objective, verifiers, allowed paths, and risk posture in one payload."
    },
    {
      step: 6,
      command: 'martin preflight "Summarize the demo workspace and confirm tests still pass" --verify "npm test"',
      why: "Create the receipt MartinLoop requires before a governed run is allowed.",
      expected: "Preflight returns ready=true when the task is safe to run."
    },
    {
      step: 7,
      command: 'MARTIN_LIVE=false martin run "Summarize the demo workspace and confirm tests still pass" --verify "npm test"',
      why: "Practice the full workflow with no model spend and the governance gate still active.",
      expected: "Martin writes a run receipt and keeps the verifier honest."
    },
    {
      step: 8,
      command: "martin dossier --latest",
      why: "Review what happened, what Martin prevented, and the next safe move.",
      expected: "You get the richest single-run summary and proof surface."
    },
    {
      step: 9,
      command: bootstrap.installCommand,
      why: "Make MartinLoop part of the default agent workflow in your IDE host.",
      expected: "Your host can call Martin resources, prompts, and tools before real coding work."
    }
  ];
}

function renderTourHuman(
  steps: Array<{ step: number; command: string; why: string; expected: string }>,
  bootstrap: ReturnType<typeof buildHostBootstrapPlan>
): string[] {
  return [
    "Martin Loop interactive tour",
    "",
    "This is the shortest path from install to a governed run. MartinLoop will hard-block real runs until doctor, session, and preflight receipts exist.",
    "",
    ...steps.flatMap((step) => [
      `${step.step}. ${step.command}`,
      `   Why: ${step.why}`,
      `   Expect: ${step.expected}`
    ]),
    "",
    `IDE bootstrap host: ${bootstrap.host}`,
    `Preview config anytime with: ${bootstrap.printConfigCommand}`
  ];
}

function parseGuideTopic(tokens: string[]): GuideTopic | undefined {
  const candidate = (tokens[0] ?? readOption(tokens, "--topic") ?? "").trim();
  switch (candidate) {
    case "start":
    case "tour":
    case "doctor":
    case "demo":
    case "session-start":
    case "plan":
    case "preflight":
    case "run":
    case "dossier":
    case "mcp":
      return candidate;
    default:
      return undefined;
  }
}

function buildGuideCommandMap(host?: MartinMcpHost): Array<{
  topic: GuideTopic;
  command: string;
  purpose: string;
  when: string;
  example: string;
}> {
  const bootstrap = buildHostBootstrapPlan({
    preferredHost: host,
    codexAvailable: true,
    claudeAvailable: true,
    geminiAvailable: true
  });

  return [
    {
      topic: "start",
      command: "martin start",
      purpose: "Show the safest next MartinLoop command and the recommended host bootstrap path.",
      when: "First install or first run in a new repo.",
      example: "martin start"
    },
    {
      topic: "tour",
      command: "martin tour",
      purpose: "Walk through the full MartinLoop flow with exact commands, expected output, and a safe demo path.",
      when: "Right after install or when onboarding a human or agent host.",
      example: "martin tour --host codex"
    },
    {
      topic: "doctor",
      command: "martin doctor",
      purpose: "Check runtime readiness, engine availability, runs root, and starter MCP profile guidance.",
      when: "Before the first governed run or when setup looks wrong.",
      example: "martin doctor --engine codex"
    },
    {
      topic: "demo",
      command: "martin demo",
      purpose: "Create a disposable local sandbox so a user or agent can learn MartinLoop without touching a real repo.",
      when: "When you want a safe demo or proof path.",
      example: "martin demo --dir ./martin-loop-demo"
    },
    {
      topic: "session-start",
      command: "martin session-start",
      purpose: "Summarize local phase state, latest run evidence, and the recommended next action.",
      when: "At the start of a real coding session.",
      example: "martin session-start --host codex"
    },
    {
      topic: "plan",
      command: "martin phase contract --json",
      purpose: "Compile the local phase state into an explicit governed contract before spend.",
      when: "Before preflight when MartinLoop should turn the plan into a real contract.",
      example: "martin phase contract --json"
    },
    {
      topic: "preflight",
      command: "martin phase preflight",
      purpose: "Preview the governed run shape and block bad verifier, scope, or budget decisions before execution.",
      when: "Before any non-trivial run.",
      example: "martin preflight \"Fix auth regression\" --verify \"pnpm test\""
    },
    {
      topic: "run",
      command: "martin run",
      purpose: "Execute the governed task after the safety envelope is explicit.",
      when: "Only after doctor and preflight are sane.",
      example: "martin run \"Fix auth regression\" --verify \"pnpm test\" --budget-usd 3"
    },
    {
      topic: "dossier",
      command: "martin dossier --latest",
      purpose: "Show what happened, what Martin prevented, and what the next safe action is.",
      when: "Immediately after a run or before sharing results.",
      example: "martin dossier --latest"
    },
    {
      topic: "mcp",
      command: bootstrap.printConfigCommand,
      purpose: "Generate the IDE/agent MCP bootstrap so MartinLoop becomes part of the agent workflow instead of a manual extra step.",
      when: "When setting up Codex, Claude Code, Gemini, or a generic MCP host.",
      example: bootstrap.installCommand
    }
  ];
}

function renderGuideOverview(
  commandMap: Array<{ topic: GuideTopic; command: string; purpose: string; when: string; example: string }>,
  host?: MartinMcpHost
): string[] {
  return [
    "Martin Loop guide",
    "",
    "Use this as the built-in tour after install. MartinLoop's default operating sequence is:",
    "  1. martin start",
    "  2. martin tour",
    "  3. martin doctor",
    "  4. martin session-start",
    "  5. martin phase contract --json",
    "  6. martin phase preflight",
    "  7. martin run <objective> --verify <command>",
    "  8. martin dossier --latest",
    "",
    "Command map:",
    ...commandMap.map((entry) => `  ${entry.command} — ${entry.purpose}`),
    "",
    `IDE bootstrap (${host ?? "codex"}):`,
    `  ${commandMap.find((entry) => entry.topic === "mcp")?.example}`,
    "",
    "For a focused explanation, run:",
    "  martin tour",
    "  martin guide start",
    "  martin guide mcp"
  ];
}

function renderGuideTopic(entry: {
  topic: GuideTopic;
  command: string;
  purpose: string;
  when: string;
  example: string;
}): string[] {
  return [
    `Martin guide: ${entry.topic}`,
    `Command: ${entry.command}`,
    `What it does: ${entry.purpose}`,
    `When to use it: ${entry.when}`,
    `Example: ${entry.example}`
  ];
}

function selectBestNextCommand(input: {
  workingDirectoryReady: boolean;
  hasCodex: boolean;
  hasClaude: boolean;
}): string {
  if (!input.workingDirectoryReady) {
    return "martin demo";
  }

  if (input.hasCodex || input.hasClaude) {
    return "martin session-start";
  }

  return "martin doctor";
}

async function resolveFirstRunBanner(
  parsed: ParsedCliArguments,
  commandArgs: string[]
): Promise<string | undefined> {
  if (
    parsed.command === "tour" ||
    parsed.command === "mcp_print_config" ||
    parsed.command === "mcp_install"
  ) {
    return undefined;
  }

  const runsDir = readOption(commandArgs, "--runs-dir");
  const environment = resolveCliEnvironment({ ...(runsDir ? { runsDir } : {}) });
  return consumeFirstRunBanner(environment.runsRoot).catch(() => undefined);
}

function prependFirstRunBanner(
  result: { exitCode: number; stdout: string; stderr: string },
  banner: string | undefined,
  outputMode: MartinOutputMode
): { exitCode: number; stdout: string; stderr: string } {
  if (!banner || outputMode !== "human") {
    return result;
  }

  return {
    ...result,
    stdout: result.stdout ? `${banner}\n\n${result.stdout}` : banner
  };
}

function buildHostBootstrapPlan(input: {
  preferredHost?: MartinMcpHost;
  codexAvailable: boolean;
  claudeAvailable: boolean;
  geminiAvailable: boolean;
}): {
  host: MartinMcpHost;
  installCommand: string;
  printConfigCommand: string;
} {
  const host =
    input.preferredHost ??
    (input.codexAvailable ? "codex" : input.claudeAvailable ? "claude" : input.geminiAvailable ? "gemini" : "generic");

  if (host === "claude") {
    return {
      host,
      installCommand:
        process.platform === "win32"
          ? "claude mcp add --transport stdio --scope user martin-loop -- cmd /c npx -y @martinloop/mcp"
          : "claude mcp add --transport stdio --scope user martin-loop -- npx -y @martinloop/mcp",
      printConfigCommand: "martin mcp print-config --host claude --profile minimal"
    };
  }

  if (host === "gemini") {
    return {
      host,
      installCommand: "martin mcp install --host gemini --scope user --dry-run",
      printConfigCommand: "martin mcp print-config --host gemini --profile minimal"
    };
  }

  if (host === "generic") {
    return {
      host,
      installCommand: "martin mcp install --host generic --scope project --dry-run",
      printConfigCommand: "martin mcp print-config --host generic --profile minimal"
    };
  }

  return {
    host: "codex",
    installCommand: "codex mcp add martin-loop -- npx -y @martinloop/mcp",
    printConfigCommand: "martin mcp print-config --host codex --profile minimal"
  };
}

async function resolveGuardrails(
  request: RunCommandRequest
): Promise<ResolvedGuardrails> {
  const { config, configPath } = await loadGuardrailsConfig(request.configPath);

  const budget: LoopBudget = {
    maxUsd: config?.budget?.maxUsd ?? request.budget.maxUsd,
    softLimitUsd: config?.budget?.softLimitUsd ?? request.budget.softLimitUsd,
    maxIterations: config?.budget?.maxIterations ?? request.budget.maxIterations,
    maxTokens: config?.budget?.maxTokens ?? request.budget.maxTokens
  };

  if (request.budget.maxUsd !== DEFAULT_BUDGET.maxUsd) {
    budget.maxUsd = request.budget.maxUsd;
  }
  if (request.budget.softLimitUsd !== DEFAULT_BUDGET.softLimitUsd) {
    budget.softLimitUsd = request.budget.softLimitUsd;
  }
  if (request.budget.maxIterations !== DEFAULT_BUDGET.maxIterations) {
    budget.maxIterations = request.budget.maxIterations;
  }
  if (request.budget.maxTokens !== DEFAULT_BUDGET.maxTokens) {
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
  configPath?: string
): Promise<{ config: GuardrailsConfig | undefined; configPath: string }> {
  const resolvedPath = configPath
    ? resolveConfigPath(configPath)
    : join(resolveInvocationRoot(), "martin.config.yaml");
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

function resolveConfigPath(configPath: string): string {
  const normalizedConfigPath =
    process.platform === "win32" ? configPath : configPath.replace(/\\/g, "/");

  if (isAbsolute(normalizedConfigPath)) {
    return normalizedConfigPath;
  }

  return resolve(resolveInvocationRoot(), normalizedConfigPath);
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
  mutationMode?: MutationMode
): MartinAdapter {
  if (mutationMode === "verify_only") {
    return createVerifierOnlyAdapter({ workingDirectory });
  }

  if (process.env.MARTIN_LIVE === "false") {
    return createStubDirectProviderAdapter({
      label: "Stub adapter (MARTIN_LIVE=false)",
      providerId: "stub",
      model: "stub"
    });
  }

  if (engine === "codex") {
    return createCodexCliAdapter({ workingDirectory, ...(modelOverride ? { model: modelOverride } : {}) });
  }

  if (engine === "openai") {
    const baseUrl = process.env["MARTIN_OPENAI_BASE_URL"] ?? "http://localhost:11434";
    const apiKey = process.env["MARTIN_OPENAI_API_KEY"] ?? "";
    const model = modelOverride ?? process.env["MARTIN_OPENAI_MODEL"] ?? "llama3.3";
    return createOpenAiCompatibleAdapter({ baseUrl, apiKey, model, workingDirectory });
  }

  return createClaudeCliAdapter({ workingDirectory, ...(modelOverride ? { model: modelOverride } : {}) });
}

function buildDoctorRecommendations(input: {
  liveMode: "live" | "stub";
  engine: "claude" | "codex" | "openai" | string;
  claudeAvailable: boolean;
  codexAvailable: boolean;
  workingDirectoryReady: boolean;
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
    recommendations.push("Install or expose the Codex CLI on PATH, or set MARTIN_LIVE=false while iterating locally.");
  }

  return recommendations;
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
    rollbackStatus,
    haltReason: latestExitReason(loop),
    evidenceBoundaryNotes: [
      "Generated from a local Martin Loop run record.",
      "Hosted dashboards and private team telemetry are intentionally excluded from OSS proof cards."
    ],
    generatedAt: loop.updatedAt
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
  const latestLoop = loops.loops[0];
  const configPath = join(environment.invocationRoot, "martin.config.yaml");
  const configExists = await stat(configPath).then((entry) => entry.isFile()).catch(() => false);
  const budgetConfigured =
    configExists ||
    (latestLoop !== undefined && latestLoop.budget.maxUsd > 0 && latestLoop.budget.maxIterations > 0);
  const verifierConfigured =
    latestLoop?.task.verificationPlan.some((cmd) => cmd.trim().length > 0) ?? configExists;
  const runReceiptsPresent = loops.loops.length > 0;
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
        detail: runReceiptsPresent ? "Local run receipts found." : "No local run receipts found."
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
