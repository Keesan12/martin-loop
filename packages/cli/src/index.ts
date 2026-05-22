import { cp, mkdir, readFile, readdir, rm, stat, unlink, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
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
  type MutationMode
} from "@martin/contracts";
import { persistLoopArtifacts, resolveRunsRoot } from "./persistence.js";

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
  | {
      command: "inspect";
      file: string;
    }
  | {
      command: "doctor";
    }
  | {
      command: "dossier";
      latest: boolean;
      loopId?: string;
      file?: string;
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
      const adapter = selectAdapter(
        args,
        workingDirectory,
        parsed.request.model,
        parsed.request.engine,
        parsed.request.mutationMode
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
            repoRoot: workingDirectory,
            ...(resolvedRequest.allowedPaths?.length ? { allowedPaths: resolvedRequest.allowedPaths } : {}),
            ...(resolvedRequest.deniedPaths?.length ? { deniedPaths: resolvedRequest.deniedPaths } : {}),
            ...(resolvedRequest.acceptanceCriteria?.length ? { acceptanceCriteria: resolvedRequest.acceptanceCriteria } : {})
          },
          budget: resolvedRequest.budget,
          metadata: resolvedRequest.metadata,
          adapter
        });
      } catch {
        const fallbackLoop = createLoopRecord({
          workspaceId: resolvedRequest.workspaceId,
          projectId: resolvedRequest.projectId,
          task: {
            title: resolvedRequest.title,
            objective: resolvedRequest.objective,
            verificationPlan: resolvedRequest.verificationPlan,
            ...(resolvedRequest.mutationMode ? { mutationMode: resolvedRequest.mutationMode } : {}),
            repoRoot: workingDirectory
          },
          budget: resolvedRequest.budget,
          metadata: resolvedRequest.metadata,
          status: "exited",
          lifecycleState: "human_escalation"
        });
        result = {
          loop: fallbackLoop,
          decision: {
            shouldExit: true,
            status: "exited",
            lifecycleState: "human_escalation",
            reason: "adapter-unavailable"
          }
        };
      }

      try {
        await persistLoopArtifacts(result.loop);
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
    case "demo": {
      try {
        const targetDirectory = await createDemoWorkspace({
          targetDirectory: parsed.directory,
          force: parsed.force
        });

        return {
          exitCode: 0,
          stdout: renderDemoInstructions(targetDirectory),
          stderr: ""
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          exitCode: 1,
          stdout: "",
          stderr: `Error: ${message}`
        };
      }
    }
    case "inspect": {
      try {
        const contents = await readFile(parsed.file, "utf8");
        const loops = parseLoopRecords(contents);

        return {
          exitCode: 0,
          stdout: JSON.stringify(
            {
              command: "inspect",
              source: parsed.file,
              summary: buildPortfolioSnapshot(loops)
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
    case "doctor": {
      return await executeDoctorCommand();
    }
    case "dossier": {
      return await executeDossierCommand(parsed);
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
        ...(request.mutationMode ? { mutationMode: request.mutationMode } : {}),
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
      file: readOption(rest, "--file") ?? ""
    };
  }

  if (command === "doctor") {
    return {
      command: "doctor"
    };
  }

  if (command === "dossier") {
    return {
      command: "dossier",
      latest: hasFlag(rest, "--latest"),
      ...(readOption(rest, "--loop-id") ? { loopId: readOption(rest, "--loop-id") } : {}),
      ...(readOption(rest, "--file") ? { file: readOption(rest, "--file") } : {})
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
    "  martin-loop run <objective> [options]",
    "  martin run <objective> [options]       (alias)",
    "  martin-loop run --objective <text> [options]",
    "  martin-loop doctor",
    "  martin-loop demo [--dir <path>] [--force]",
    "  martin-loop dossier (--latest | --loop-id <id> | --file <path>)",
    "  martin-loop inspect --file <path>",
    "  martin-loop resume <loopId>",
    "  martin-loop bench --suite <suiteId>",
    "",
    "Commands:",
    "  run      Execute a bounded Martin loop against the current repository.",
    "  doctor   Check local readiness, engine availability, and run-store access.",
    "  demo     Copy a safe local sandbox so you can try MartinLoop outside your own repo.",
    "  dossier  Read the latest or selected persisted run with receipt-style evidence.",
    "  inspect  Read a persisted loop record and summarize its portfolio metrics.",
    "  resume   Load a persisted loop record by loop ID from ~/.martin/runs/.",
    "  bench    Redirect to the workspace-only RC benchmark harness.",
    "",
    "Common options:",
    "  --help                  Show this message.",
    "  --engine <name>         Adapter to use: claude (default) or codex.",
    "  --model <name>          Override the model (e.g. claude-sonnet-4-6).",
    "  --cwd <path>            Set the repo root used for repo-backed runs.",
    "  --budget <n>            Set the hard cost cap in USD (subprocess killed at limit).",
    "  --budget-usd <n>        Alias for --budget.",
    "  --soft-limit-usd <n>    Soft budget warning threshold in USD.",
    "  --max-iterations <n>    Set the maximum number of attempts.",
    "  --max-tokens <n>        Set the maximum total token budget.",
    "  --verify <cmd>          Shell command to run as the verifier after each attempt.",
    "  --verify-only           Skip the coding adapter and run the verifier only.",
    "  --allow-path <glob>     Restrict agent writes to this path pattern (repeatable).",
    "  --deny-path <glob>      Block agent from this path pattern (repeatable).",
    "  --accept <criterion>    Add an acceptance criterion to the prompt (repeatable).",
    "  --config <path>         Path to martin.config.yaml.",
    "",
    "Demo options:",
    "  --dir <path>            Target directory for the copied demo sandbox.",
    "  --force                 Replace an existing non-empty demo target.",
    "",
    "Dossier options:",
    "  --latest                Load the newest persisted run.",
    "  --loop-id <id>          Load a persisted run by loop ID.",
    "  --file <path>           Load a persisted run from a loop.json or .jsonl file."
  ].join("\n");
}

function readOption(tokens: string[], flag: string): string | undefined {
  const index = tokens.indexOf(flag);
  return index >= 0 ? tokens[index + 1] : undefined;
}

function hasFlag(tokens: string[], flag: string): boolean {
  return tokens.includes(flag);
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
      throw new Error(
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
    `MartinLoop demo sandbox created at ${targetDirectory}`,
    "",
    "Next steps:",
    `  cd ${targetDirectory}`,
    "  npm install",
    "  npm test",
    "",
    "Safe first run (no provider spend):",
    '  MARTIN_LIVE=false npx martin-loop run "Summarize the demo workspace and confirm the verifier is green" --verify "npm test"',
    "",
    "Optional live run:",
    '  npx martin-loop run "Add support for a discount percentage to summarizeInvoice and update the tests" --verify "npm test" --engine codex'
  ].join("\n");
}

async function executeDoctorCommand(): Promise<{
  exitCode: number;
  stdout: string;
  stderr: string;
}> {
  const runsRoot = resolveRunsRoot();
  const tempProbe = join(runsRoot, `.doctor-check-${Date.now()}.tmp`);
  let runsWritable = false;

  try {
    await mkdir(runsRoot, { recursive: true });
    await writeFile(tempProbe, "ok\n", "utf8");
    await unlink(tempProbe);
    runsWritable = true;
  } catch {
    runsWritable = false;
  }

  const claudeAvailable = isCommandAvailable("claude");
  const codexAvailable = isCommandAvailable("codex");
  const liveMode = process.env.MARTIN_LIVE === "false" ? "stub" : "live";
  const defaultEngine = codexAvailable ? "codex" : "claude";
  const ready = runsWritable && (liveMode === "stub" || claudeAvailable || codexAvailable);

  const payload = {
    command: "doctor",
    ready,
    liveMode,
    defaultEngine,
    engines: {
      claudeAvailable,
      codexAvailable
    },
    runsRoot,
    checks: {
      runsWritable,
      demoWorkspaceAvailable: true
    },
    nextSteps: [
      "npx martin-loop demo",
      "cd martin-loop-demo",
      "npm install",
      'MARTIN_LIVE=false npx martin-loop run "Summarize the demo workspace and confirm the verifier is green" --verify "npm test"',
      "npx martin-loop dossier --latest"
    ],
    note:
      liveMode === "stub"
        ? "Stub mode is active. You can prove the flow locally without provider spend."
        : claudeAvailable || codexAvailable
          ? "At least one live engine is available."
          : "No live engine was found on PATH. Set MARTIN_LIVE=false for the no-spend proof path."
  };

  return {
    exitCode: ready ? 0 : 1,
    stdout: JSON.stringify(payload, null, 2),
    stderr: ""
  };
}

async function executeDossierCommand(parsed: Extract<ParsedCliArguments, { command: "dossier" }>): Promise<{
  exitCode: number;
  stdout: string;
  stderr: string;
}> {
  try {
    const loop = await resolveLoopForDossier(parsed);
    const payload = buildRunDossierPayload(loop);

    return {
      exitCode: 0,
      stdout: JSON.stringify(payload, null, 2),
      stderr: ""
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      exitCode: 1,
      stdout: "",
      stderr: `Error: ${message}`
    };
  }
}

async function resolveLoopForDossier(
  parsed: Extract<ParsedCliArguments, { command: "dossier" }>
): Promise<LoopRecord> {
  if (parsed.file) {
    return await loadLoopFromPath(parsed.file);
  }

  const runsRoot = resolveRunsRoot();

  if (parsed.loopId) {
    const loopPath = join(runsRoot, parsed.loopId, "loop.json");
    try {
      return await loadLoopFromPath(loopPath);
    } catch {
      const loop = await findLoopInWorkspaceIndexes(runsRoot, parsed.loopId);
      if (loop) return loop;
      throw new Error(`loop ${parsed.loopId} not found in ${runsRoot}`);
    }
  }

  if (!parsed.latest) {
    throw new Error("dossier requires --latest, --loop-id <id>, or --file <path>");
  }

  const latestLoop = await findLatestPersistedLoop(runsRoot);
  if (!latestLoop) {
    throw new Error(`no persisted runs found in ${runsRoot}`);
  }

  return latestLoop;
}

async function loadLoopFromPath(targetPath: string): Promise<LoopRecord> {
  const entry = await stat(targetPath);
  if (entry.isDirectory()) {
    return loadLoopFromPath(join(targetPath, "loop.json"));
  }

  const contents = await readFile(targetPath, "utf8");
  const loops = parseLoopRecords(contents);
  const latest = loops.sort(compareLoopsByUpdatedAt).at(-1);
  if (!latest) {
    throw new Error(`no loop records found in ${targetPath}`);
  }
  return latest;
}

async function findLatestPersistedLoop(runsRoot: string): Promise<LoopRecord | null> {
  await mkdir(runsRoot, { recursive: true });
  const entries = await readdir(runsRoot, { withFileTypes: true });
  const loops: LoopRecord[] = [];

  for (const entry of entries) {
    if (entry.isDirectory()) {
      const loopPath = join(runsRoot, entry.name, "loop.json");
      try {
        loops.push(await loadLoopFromPath(loopPath));
      } catch {
        // Ignore non-loop directories.
      }
    }
  }

  if (loops.length > 0) {
    return loops.sort(compareLoopsByUpdatedAt).at(-1) ?? null;
  }

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
    const contents = await readFile(join(runsRoot, entry.name), "utf8");
    loops.push(...parseLoopRecords(contents));
  }

  return loops.length > 0 ? loops.sort(compareLoopsByUpdatedAt).at(-1) ?? null : null;
}

async function findLoopInWorkspaceIndexes(runsRoot: string, loopId: string): Promise<LoopRecord | null> {
  const entries = await readdir(runsRoot, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
    const contents = await readFile(join(runsRoot, entry.name), "utf8");
    const match = parseLoopRecords(contents).find((loop) => loop.loopId === loopId);
    if (match) return match;
  }

  return null;
}

function compareLoopsByUpdatedAt(left: LoopRecord, right: LoopRecord): number {
  return Date.parse(left.updatedAt) - Date.parse(right.updatedAt);
}

function buildRunDossierPayload(loop: LoopRecord) {
  const verificationEvent = [...loop.events]
    .reverse()
    .find((event) => event.type === "verification.completed");
  const verificationPassed =
    verificationEvent?.payload["passed"] === true || loop.lifecycleState === "completed";
  const verificationStatus = verificationPassed
    ? "passed"
    : verificationEvent
      ? "failed"
      : "unknown";

  const preventionNotes = new Set<string>();
  if (verificationStatus === "failed") {
    preventionNotes.add("false success claims after a failed verifier");
  }
  if (loop.cost.avoidedUsd > 0) {
    preventionNotes.add("avoidable spend beyond the governed budget envelope");
  }
  if (loop.lifecycleState === "human_escalation") {
    preventionNotes.add("unsafe continuation without a human decision");
  }
  if (preventionNotes.size === 0) {
    preventionNotes.add("unbounded retry loops without an inspectable receipt");
  }

  return {
    command: "dossier",
    loop,
    summary: {
      status: loop.status,
      lifecycleState: loop.lifecycleState,
      attempts: loop.attempts.length,
      actualUsd: loop.cost.actualUsd,
      avoidedUsd: loop.cost.avoidedUsd,
      updatedAt: loop.updatedAt
    },
    verification: {
      status: verificationStatus,
      summary:
        typeof verificationEvent?.payload["summary"] === "string"
          ? verificationEvent.payload["summary"]
          : verificationPassed
            ? "Verifier passed."
            : "No verifier summary was persisted."
    },
    receipt: {
      whatMartinPrevented: [...preventionNotes],
      tokenWasteReceipt: {
        estimateLabel: "directional local estimates",
        actualUsd: loop.cost.actualUsd,
        avoidedUsd: loop.cost.avoidedUsd,
        tokensIn: loop.cost.tokensIn,
        tokensOut: loop.cost.tokensOut
      },
      rollbackEvidence: {
        artifactCount: loop.artifacts.length,
        available: loop.artifacts.length > 0
      },
      nextSafeAction:
        loop.status === "completed"
          ? "Review the persisted artifacts, then ship or archive the run."
          : "Inspect the verifier evidence, then re-run with a tighter objective or fix the blocking failure."
    }
  };
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

function isCommandAvailable(command: string): boolean {
  const executable = process.platform === "win32" ? "where.exe" : "which";
  const result = spawnSync(executable, [command], { stdio: "ignore" });
  return result.status === 0;
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
  engineOverride?: string,
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

  const engine = engineOverride ?? readOption(rawArgs, "--engine") ?? "claude";

  if (engine === "codex") {
    const model = modelOverride ?? readOption(rawArgs, "--model");
    return createCodexCliAdapter({ workingDirectory, ...(model ? { model } : {}) });
  }

  const model = modelOverride ?? readOption(rawArgs, "--model");
  return createClaudeCliAdapter({ workingDirectory, ...(model ? { model } : {}) });
}
