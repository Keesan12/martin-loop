import { appendFile, mkdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

import { createClaudeCliAdapter, createCodexCliAdapter, createStubDirectProviderAdapter } from "@martin/adapters";
import { runMartin, type MartinAdapter } from "@martin/core";
import { buildPortfolioSnapshot, type LoopBudget } from "@martin/contracts";

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
      command: "inspect";
      file: string;
    }
  | {
      command: "resume";
      loopId: string;
    };

export async function executeCli(args: string[]): Promise<{
  exitCode: number;
  stdout: string;
  stderr: string;
}> {
  const parsed = parseCliArguments(args);

  switch (parsed.command) {
    case "help": {
      return {
        exitCode: 0,
        stdout: renderCliHelp(),
        stderr: ""
      };
    }
    case "run": {
      const resolvedGuardrails = await resolveGuardrails(parsed.request, args);
      const verificationPlan =
        parsed.request.verificationPlan.length > 0
          ? parsed.request.verificationPlan
          : resolvedGuardrails.verifierRules;
      const resolvedRequest: RunCommandRequest = {
        ...parsed.request,
        budget: resolvedGuardrails.budget,
        verificationPlan,
        metadata: {
          ...parsed.request.metadata,
          policyProfile: resolvedGuardrails.policyProfile,
          telemetryDestination: resolvedGuardrails.telemetryDestination
        }
      };

      const workingDirectory = parsed.request.cwd ?? readOption(args, "--cwd") ?? process.cwd();
      const adapter = selectAdapter(args, workingDirectory, parsed.request.model, parsed.request.engine);

      const result = await runMartin({
        workspaceId: resolvedRequest.workspaceId,
        projectId: resolvedRequest.projectId,
        task: {
          title: resolvedRequest.title,
          objective: resolvedRequest.objective,
          verificationPlan: resolvedRequest.verificationPlan,
          repoRoot: workingDirectory,
          ...(resolvedRequest.allowedPaths?.length ? { allowedPaths: resolvedRequest.allowedPaths } : {}),
          ...(resolvedRequest.deniedPaths?.length ? { deniedPaths: resolvedRequest.deniedPaths } : {}),
          ...(resolvedRequest.acceptanceCriteria?.length ? { acceptanceCriteria: resolvedRequest.acceptanceCriteria } : {})
        },
        budget: resolvedRequest.budget,
        metadata: resolvedRequest.metadata,
        adapter
      });

      // Persist loop record to ~/.martin/runs/<workspaceId>.jsonl
      // Dashboard and inspect commands read from this file.
      try {
        const runsDir = join(homedir(), ".martin", "runs");
        await mkdir(runsDir, { recursive: true });
        const outFile = join(runsDir, `${resolvedRequest.workspaceId}.jsonl`);
        await appendFile(outFile, JSON.stringify(result.loop) + "\n", "utf8");
      } catch {
        // Non-fatal — persistence failure should not crash the run output
      }

      return {
        exitCode: 0,
        stdout: JSON.stringify(
          {
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
            }
          },
          null,
          2
        ),
        stderr: ""
      };
    }
    case "bench": {
      return {
        exitCode: 1,
        stdout: "",
        stderr:
          "The benchmark harness remains a workspace-only RC surface and is not part of the publishable @martin/cli boundary yet. Use pnpm --filter @martin/benchmarks test or pnpm --filter @martin/benchmarks eval:phase12 from the repo root instead."
      };
    }
    case "inspect": {
      try {
        const contents = await readFile(parsed.file, "utf8");
        const parsedContents = JSON.parse(contents) as unknown;
        const loops = Array.isArray(parsedContents) ? parsedContents : [parsedContents];

        return {
          exitCode: 0,
          stdout: JSON.stringify(
            {
              command: "inspect",
              source: parsed.file,
              summary: buildPortfolioSnapshot(loops as Parameters<typeof buildPortfolioSnapshot>[0])
            },
            null,
            2
          ),
          stderr: ""
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);

        return {
          exitCode: 1,
          stdout: "",
          stderr: `Error: ${message}`
        };
      }
    }
    case "resume": {
      if (!parsed.loopId) {
        return {
          exitCode: 1,
          stdout: "",
          stderr: "Error: resume requires a loop ID. Usage: martin resume <loopId>"
        };
      }

      try {
        const runsDir = join(homedir(), ".martin", "runs");
        // Search all JSONL files for the matching loopId
        const { readdir } = await import("node:fs/promises");
        const files = await readdir(runsDir).catch(() => [] as string[]);
        let found: unknown = null;

        for (const file of files.filter((f) => f.endsWith(".jsonl"))) {
          const contents = await readFile(join(runsDir, file), "utf8");
          for (const line of contents.split("\n").filter(Boolean)) {
            try {
              const record = JSON.parse(line) as { loopId?: string };
              if (record.loopId === parsed.loopId) {
                found = record;
              }
            } catch { /* skip malformed */ }
          }
        }

        if (!found) {
          return {
            exitCode: 1,
            stdout: "",
            stderr: `Error: loop ${parsed.loopId} not found in ~/.martin/runs/`
          };
        }

        return {
          exitCode: 0,
          stdout: JSON.stringify({ command: "resume", loop: found }, null, 2),
          stderr: ""
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { exitCode: 1, stdout: "", stderr: `Error: ${message}` };
      }
    }
  }
}

export function parseCliArguments(args: string[]): ParsedCliArguments {
  const [command, ...rest] = args;

  if (!command || command === "help" || command === "--help" || command === "-h") {
    return {
      command: "help"
    };
  }

  if (command === "run") {
    const verificationPlan: string[] = [];
    const metadata: Record<string, string> = {};
    const request: Partial<RunCommandRequest> = {
      verificationPlan,
      metadata,
      budget: {
        maxUsd: 10,
        softLimitUsd: 7,
        maxIterations: 3,
        maxTokens: 20_000
      }
    };

    // First positional arg (not a flag) is treated as the objective
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
      command: "run",
      request: {
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
        ...(request.allowedPaths?.length ? { allowedPaths: request.allowedPaths } : {}),
        ...(request.deniedPaths?.length ? { deniedPaths: request.deniedPaths } : {}),
        ...(request.acceptanceCriteria?.length ? { acceptanceCriteria: request.acceptanceCriteria } : {})
      }
    };
  }

  if (command === "bench") {
    return {
      command: "bench",
      suiteId: readOption(rest, "--suite") ?? "ralphy-smoke"
    };
  }

  if (command === "inspect") {
    return {
      command: "inspect",
      file: readOption(rest, "--file") ?? ""
    };
  }

  if (command === "resume") {
    const loopId = rest[0] ?? readOption(rest, "--loop-id") ?? "";
    return { command: "resume", loopId };
  }

  return {
    command: "help"
  };
}

export function renderCliHelp(): string {
  return [
    "Martin Loop CLI",
    "",
    "Usage:",
    "  martin run <objective> [options]",
    "  martin run --objective <text> [options]",
    "  martin inspect --file <path>",
    "  martin resume <loopId>",
    "  martin bench --suite <suiteId>",
    "",
    "Commands:",
    "  run      Execute a bounded Martin loop against the current repository.",
    "  inspect  Read a persisted loop record and summarize its portfolio metrics.",
    "  resume   Load a persisted loop record by loop ID from ~/.martin/runs/.",
    "  bench    Redirect to the workspace-only RC benchmark harness.",
    "",
    "Common options:",
    "  --help                Show this message.",
    "  --engine <name>       Select the adapter route (claude or codex).",
    "  --model <name>        Override the adapter model when supported.",
    "  --cwd <path>          Set the repo root used for repo-backed runs.",
    "  --budget <n>          Set the hard cost cap in USD for the run.",
    "  --budget-usd <n>      Alias for --budget.",
    "  --verify <cmd>        Shell command to use as the verifier.",
    "  --max-iterations <n>  Set the maximum attempt budget for the run."
  ].join("\n");
}

function readOption(tokens: string[], flag: string): string | undefined {
  const index = tokens.indexOf(flag);
  return index >= 0 ? tokens[index + 1] : undefined;
}

function hasFlag(tokens: string[], flag: string): boolean {
  return tokens.includes(flag);
}

async function resolveGuardrails(
  request: RunCommandRequest,
  rawArgs: string[]
): Promise<ResolvedGuardrails> {
  const tokens = rawArgs.slice(1);
  const { config, configPath } = await loadGuardrailsConfig(request.configPath);

  const budget: LoopBudget = {
    maxUsd: config?.budget?.maxUsd ?? request.budget.maxUsd,
    softLimitUsd: config?.budget?.softLimitUsd ?? request.budget.softLimitUsd,
    maxIterations: config?.budget?.maxIterations ?? request.budget.maxIterations,
    maxTokens: config?.budget?.maxTokens ?? request.budget.maxTokens
  };

  if (hasFlag(tokens, "--budget-usd")) {
    budget.maxUsd = request.budget.maxUsd;
  }
  if (hasFlag(tokens, "--soft-limit-usd")) {
    budget.softLimitUsd = request.budget.softLimitUsd;
  }
  if (hasFlag(tokens, "--max-iterations")) {
    budget.maxIterations = request.budget.maxIterations;
  }
  if (hasFlag(tokens, "--max-tokens")) {
    budget.maxTokens = request.budget.maxTokens;
  }

  // Ensure softLimitUsd never exceeds maxUsd (CLI default issue when --budget-usd < 5)
  if (budget.softLimitUsd >= budget.maxUsd) {
    budget.softLimitUsd = Math.round(budget.maxUsd * 0.75 * 100) / 100;
  }

  let policyProfile = config?.policyProfile ?? "balanced";
  if (hasFlag(tokens, "--policy")) {
    policyProfile = request.metadata.policyProfile ?? policyProfile;
  }

  let telemetryDestination = config?.governance?.telemetryDestination ?? "local-only";
  if (hasFlag(tokens, "--telemetry")) {
    telemetryDestination = request.metadata.telemetryDestination ?? telemetryDestination;
  }

  const destructiveActionPolicy =
    config?.governance?.destructiveActionPolicy ?? "approval";
  const verifierRules = request.verificationPlan.length > 0
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
    : join(getInvocationRoot(), "martin.config.yaml");
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
      throw new Error(`Config file not found: ${resolvedPath}`);
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

  return resolve(getInvocationRoot(), normalizedConfigPath);
}

function getInvocationRoot(): string {
  const initCwd = process.env.INIT_CWD;
  return typeof initCwd === "string" && initCwd.trim().length > 0 ? initCwd : process.cwd();
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

/**
 * Selects the adapter based on CLI flags and environment variables.
 *
 * --engine claude  (default) — real Claude CLI subprocess
 * --engine codex             — real Codex CLI subprocess
 * MARTIN_LIVE=false          — stub adapter (for tests / dry-runs)
 */
function selectAdapter(
  rawArgs: string[],
  workingDirectory: string,
  modelOverride?: string,
  engineOverride?: string
): MartinAdapter {
  if (process.env.MARTIN_LIVE === "false") {
    return createStubDirectProviderAdapter({
      label: "Stub adapter (MARTIN_LIVE=false)",
      providerId: "stub",
      model: "stub"
    });
  }

  const engine = engineOverride ?? readOption(rawArgs, "--engine") ?? "claude";

  if (engine === "codex") {
    const model = modelOverride ?? readOption(rawArgs, "--model");
    return createCodexCliAdapter({ workingDirectory, ...(model ? { model } : {}) });
  }

  const model = modelOverride ?? readOption(rawArgs, "--model");
  return createClaudeCliAdapter({ workingDirectory, ...(model ? { model } : {}) });
}
