import { cp, mkdir, readFile, readdir, rm, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  createClaudeCliAdapter,
  createCodexCliAdapter,
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
  buildArtifactSummary,
  buildRunDossier,
  buildVerificationSummary,
  listPersistedLoops,
  loadPersistedAttempt,
  loadPersistedLoop,
  resolveCliEnvironment,
  resolveInvocationRoot,
  triagePersistedLoops
} from "./run-store.js";
import { CliCommandError, renderCliError, renderCliSuccess } from "./ux.js";

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
  engine?: "claude" | "codex";
  configPath?: string;
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
  | NativePhaseCommand
  | PreflightCommand
  | TriageCommand
  | DossierCommand
  | RunsCommand
  | McpCommand;

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
      case "bench":
        return {
          exitCode: 1,
          stdout: "",
          stderr:
            "The benchmark harness remains a workspace-only RC surface and is not part of the publishable @martin/cli boundary yet. Use pnpm --filter @martin/benchmarks test or pnpm --filter @martin/benchmarks eval:phase12 from the repo root instead."
        };
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
    }
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
      ...(readOption(rest, "--engine") === "claude" ? { engine: "claude" as const } : {})
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
    "",
    "Operator commands:",
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
    "  --engine <name>          Adapter to use: claude (default) or codex.",
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
      }
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
    recommendations: buildDoctorRecommendations({
      liveMode: environment.liveMode,
      engine: environment.engine,
      claudeAvailable,
      codexAvailable,
      workingDirectoryReady
    })
  };

  return renderCliSuccess(outputMode, {
    data,
    human: [
      `Martin CLI doctor (${packageJson.version})`,
      `Working directory: ${environment.workingDirectory} (${workingDirectoryReady ? "ready" : "missing"})`,
      `Runs root: ${environment.runsRoot} (${runsRootReady ? "ready" : "not created yet"})`,
      `Live mode: ${environment.liveMode}`,
      `Claude CLI: ${claudeAvailable ? "available" : "missing"}`,
      `Codex CLI: ${codexAvailable ? "available" : "missing"}`,
      `Config: ${configExists ? configPath : `not found at ${configPath}`}`
    ],
    quiet: environment.runsRoot,
    warnings
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

  const ready = blockingIssues.length === 0;
  const data = {
    command: "preflight",
    ready,
    blockingIssues,
    warnings,
    environment,
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

  return renderCliSuccess(outputMode, {
    data,
    human: [
      `Preflight ${ready ? "passed" : "blocked"} for ${request.title}`,
      `Working directory: ${environment.workingDirectory}`,
      `Engine: ${environment.engine} (${environment.liveMode})`,
      `Verification plan: ${verificationPlan.join(", ") || "none"}`,
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

  if (host === "codex" || host === "claude" || host === "gemini" || host === "generic") {
    return host;
  }

  if (host === undefined) {
    throw new CliCommandError("invalid_input", "mcp commands require --host <codex|claude|gemini|generic>.", {
      suggestion: "Pass --host codex, --host claude, --host gemini, or --host generic."
    });
  }

  throw new CliCommandError("invalid_input", `Invalid --host value: ${host}.`, {
    suggestion: "Use --host codex, --host claude, --host gemini, or --host generic."
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

  return createClaudeCliAdapter({ workingDirectory, ...(modelOverride ? { model: modelOverride } : {}) });
}

function buildDoctorRecommendations(input: {
  liveMode: "live" | "stub";
  engine: "claude" | "codex";
  claudeAvailable: boolean;
  codexAvailable: boolean;
  workingDirectoryReady: boolean;
}): string[] {
  const recommendations = ["Run `martin preflight` before non-trivial governed coding work."];

  if (!input.workingDirectoryReady) {
    recommendations.push("Point `--cwd` at a valid repository before running Martin.");
  }

  if (input.liveMode === "live" && input.engine === "claude" && !input.claudeAvailable) {
    recommendations.push("Install or expose the Claude CLI on PATH, or switch to `--engine codex`.");
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
