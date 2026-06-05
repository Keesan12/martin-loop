import { readFile, readdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";

import { resolveRunsRoot } from "@martin/core";

const DEFAULT_BLOCKED_PATHS = [
  ".env",
  ".env.*",
  "infra/**",
  "supabase/migrations/**",
  "package-lock.json",
  "pnpm-lock.yaml"
];

const DEFAULT_COMMANDS = [
  "martin-loop doctor",
  'martin-loop preflight "<objective>"',
  'martin-loop run "<objective>" --verify "<command>" --budget-usd 3',
  "martin-loop dossier --latest",
  "martin-loop runs list",
  "martin-loop runs get --loop-id <id>",
  "martin-loop runs verify --latest",
  "martin-loop demo"
];

const DEFAULT_BUDGET = {
  maxUsd: 8,
  maxIterations: 3,
  maxCommands: 20
};

const DEFAULT_RUN_SCAN_LIMIT = 40;

export type NativePhaseSubcommand = "status" | "contract" | "session-start" | "preflight" | "run";

export type NativePhaseCommandOptions = {
  rootDir?: string;
  runsDir?: string;
  host?: string;
  runScanLimit?: number;
};

export type NativePhaseContract = {
  objective: string;
  phase: string;
  allowedPaths: string[];
  blockedPaths: string[];
  budget: {
    maxUsd: number;
    maxIterations: number;
    maxCommands: number;
  };
  verifiers: string[];
  riskLevel: "medium" | "high";
  requiresApproval: boolean;
  missingSafeguards: string[];
  source: string;
};

export type NativePhaseSnapshot = {
  ok: true;
  schemaVersion: "martin.phase-command-center.v1";
  generatedAt: string;
  root: {
    hasPhaseWorkspace: boolean;
    hasSessionHook: boolean;
  };
  phaseWorkspace: {
    available: boolean;
    activePhase: string | null;
    state: string;
    planTitle: string | null;
    sources: {
      plan: string | null;
      state: string | null;
      contract: string | null;
    };
    missingSafeguards: string[];
  };
  runStore: {
    available: boolean;
    inspectedRuns: number;
    scanLimit: number;
    scanLimited: boolean;
    totalRuns: number;
    latestRun: NativePhaseRunSummary | null;
    runsNeedingTriage: NativePhaseRunSummary[];
    warnings: string[];
  };
  contract: NativePhaseContract;
  sessionStart: {
    host: string;
    recommendedNextAction: string;
    commands: string[];
  };
};

type NativePhaseRunSummary = {
  loopId: string;
  status: string;
  lifecycleState: string;
  title: string;
  verifier?: "passed" | "failed" | "unavailable";
  budgetUsedUsd?: number | null;
  updatedAt: string | null;
};

type LocalLoopRecord = {
  loopId?: string;
  status?: string;
  lifecycleState?: string;
  task?: {
    title?: string;
    objective?: string;
  };
  cost?: {
    actualUsd?: number;
  };
  events?: Array<{
    type?: string;
    payload?: Record<string, unknown>;
  }>;
  createdAt?: string;
  updatedAt?: string;
};

type PhaseWorkspaceState = {
  available: boolean;
  sessionHookAvailable: boolean;
  planPath: string | null;
  statePath: string | null;
  contractPath: string | null;
  activePhase: string | null;
  state: string;
  planTitle: string | null;
  contractOverride: Record<string, unknown> | null;
  missingSafeguards: string[];
};

export async function createNativePhaseCommandCenterSnapshot(
  options: NativePhaseCommandOptions = {}
): Promise<NativePhaseSnapshot> {
  const rootDir = resolve(options.rootDir ?? process.cwd());
  const runsRoot = resolveRunsRoot({ MARTIN_RUNS_DIR: options.runsDir ?? process.env.MARTIN_RUNS_DIR });
  const [phaseWorkspace, runStore] = await Promise.all([
    collectPhaseWorkspaceState(rootDir),
    collectRunStore(runsRoot, { scanLimit: options.runScanLimit ?? DEFAULT_RUN_SCAN_LIMIT })
  ]);
  const contract = await buildPhaseContract(rootDir, phaseWorkspace);

  return {
    ok: true,
    schemaVersion: "martin.phase-command-center.v1",
    generatedAt: new Date().toISOString(),
    root: {
      hasPhaseWorkspace: phaseWorkspace.available,
      hasSessionHook: phaseWorkspace.sessionHookAvailable
    },
    phaseWorkspace: {
      available: phaseWorkspace.available,
      activePhase: phaseWorkspace.activePhase,
      state: phaseWorkspace.state,
      planTitle: phaseWorkspace.planTitle,
      sources: {
        plan: phaseWorkspace.planPath,
        state: phaseWorkspace.statePath,
        contract: phaseWorkspace.contractPath
      },
      missingSafeguards: phaseWorkspace.missingSafeguards
    },
    runStore,
    contract,
    sessionStart: {
      host: options.host ?? "claude",
      recommendedNextAction: recommendedNextAction(phaseWorkspace, runStore, contract),
      commands: DEFAULT_COMMANDS
    }
  };
}

export function buildNativePhaseRunRequest(contract: NativePhaseContract, cwd?: string) {
  return {
    workspaceId: "ws_default",
    projectId: "proj_default",
    title: contract.objective,
    objective: contract.objective,
    verificationPlan: contract.verifiers,
    metadata: {
      source: "native-phase-contract",
      phase: contract.phase,
      riskLevel: contract.riskLevel
    },
    budget: {
      maxUsd: contract.budget.maxUsd,
      softLimitUsd: Math.max(0, Math.round(contract.budget.maxUsd * 0.75 * 100) / 100),
      maxIterations: contract.budget.maxIterations,
      maxTokens: 20_000
    },
    ...(cwd ? { cwd } : {}),
    ...(contract.allowedPaths.length > 0 ? { allowedPaths: contract.allowedPaths } : {}),
    deniedPaths: contract.blockedPaths
  };
}

export function buildNativePhaseInvocation(command: "preflight" | "run", contract: NativePhaseContract): string[] {
  const args = ["martin-loop", command, contract.objective];

  for (const verifier of contract.verifiers) {
    args.push("--verify", verifier);
  }
  args.push("--budget-usd", String(contract.budget.maxUsd));
  args.push("--max-iterations", String(contract.budget.maxIterations));

  for (const allowedPath of contract.allowedPaths) {
    args.push("--allow-path", allowedPath);
  }
  for (const blockedPath of contract.blockedPaths) {
    args.push("--deny-path", blockedPath);
  }

  return args;
}

export function selectNativePhasePayload(
  snapshot: NativePhaseSnapshot,
  subcommand: NativePhaseSubcommand
): Record<string, unknown> {
  if (subcommand === "status") {
    return {
      command: "phase_status",
      ok: snapshot.ok,
      schemaVersion: snapshot.schemaVersion,
      phaseWorkspace: snapshot.phaseWorkspace,
      runStore: snapshot.runStore,
      recommendedNextAction: snapshot.sessionStart.recommendedNextAction
    };
  }

  if (subcommand === "contract") {
    return {
      command: "phase_contract",
      ok: snapshot.ok,
      schemaVersion: snapshot.schemaVersion,
      contract: snapshot.contract
    };
  }

  if (subcommand === "session-start") {
    return {
      command: "session_start",
      ...snapshot
    };
  }

  const martinCommand = subcommand === "run" ? "run" : "preflight";
  const invocation = buildNativePhaseInvocation(martinCommand, snapshot.contract);

  if (snapshot.contract.requiresApproval) {
    return {
      command: `phase_${subcommand}`,
      ok: false,
      blocked: true,
      reason: "contract_requires_approval",
      missingSafeguards: snapshot.contract.missingSafeguards,
      contract: snapshot.contract,
      invocation: {
        executed: false,
        dryRun: true,
        command: invocation
      }
    };
  }

  return {
    command: `phase_${subcommand}`,
    ok: true,
    blocked: false,
    contract: snapshot.contract,
    invocation: {
      executed: false,
      dryRun: true,
      command: invocation
    }
  };
}

export function renderNativePhaseHuman(snapshot: NativePhaseSnapshot): string[] {
  return [
    "MartinLoop phase command-center session start",
    `Phase workspace: ${snapshot.phaseWorkspace.available ? "detected" : "missing"}`,
    `Active phase: ${snapshot.phaseWorkspace.activePhase ?? "unavailable"}`,
    `Latest run: ${snapshot.runStore.latestRun?.loopId ?? "unavailable"}`,
    `Recommended next action: ${snapshot.sessionStart.recommendedNextAction}`,
    "Commands:",
    ...snapshot.sessionStart.commands.map((command) => `- ${command}`)
  ];
}

async function collectPhaseWorkspaceState(rootDir: string): Promise<PhaseWorkspaceState> {
  const compatibilityWorkspaceDir = join(rootDir, ".gsd");
  const sessionHookPath = join(compatibilityWorkspaceDir, "session-start.json");
  const planPath = join(compatibilityWorkspaceDir, "PLAN.md");
  const statePath = join(compatibilityWorkspaceDir, "state.json");
  const contractPath = join(compatibilityWorkspaceDir, "martin-contract.json");

  const [phaseWorkspaceAvailable, sessionHookAvailable, planText, stateJson, contractJson] = await Promise.all([
    pathExists(compatibilityWorkspaceDir),
    pathExists(sessionHookPath),
    readTextIfExists(planPath),
    readJsonFile(statePath).catch(() => null),
    readJsonFile(contractPath).catch(() => null)
  ]);

  const activePhase =
    typeof stateJson?.activePhase === "string"
      ? stateJson.activePhase
      : typeof stateJson?.phase === "string"
        ? stateJson.phase
        : null;

  return {
    available: phaseWorkspaceAvailable,
    sessionHookAvailable,
    planPath: planText ? ".gsd/PLAN.md" : null,
    statePath: stateJson ? ".gsd/state.json" : null,
    contractPath: contractJson ? ".gsd/martin-contract.json" : null,
    activePhase,
    state: typeof stateJson?.state === "string" ? stateJson.state : phaseWorkspaceAvailable ? "detected" : "missing",
    planTitle: extractPlanTitle(planText),
    contractOverride: isObject(contractJson) ? contractJson : null,
    missingSafeguards: [
      !phaseWorkspaceAvailable ? "missing_phase_workspace" : null,
      !planText ? "missing_phase_plan" : null,
      !contractJson ? "missing_martin_contract" : null
    ].filter((value): value is string => value !== null)
  };
}

async function collectRunStore(
  runsRoot: string,
  options: { scanLimit: number }
): Promise<NativePhaseSnapshot["runStore"]> {
  const entries = await readdir(runsRoot, { withFileTypes: true }).catch(() => null);
  if (!entries) {
    return {
      available: false,
      inspectedRuns: 0,
      scanLimit: options.scanLimit,
      scanLimited: false,
      totalRuns: 0,
      latestRun: null,
      runsNeedingTriage: [],
      warnings: ["run_store_missing"]
    };
  }

  const loopEntries = entries.filter((entry) => entry.isDirectory() && entry.name.startsWith("loop_"));
  const loopDirs = (
    await Promise.all(
      loopEntries.map(async (entry) => {
        const directoryPath = join(runsRoot, entry.name);
        const stats = await stat(directoryPath).catch(() => null);
        return {
          name: entry.name,
          mtimeMs: stats?.mtimeMs ?? 0
        };
      })
    )
  )
    .sort((left, right) => right.mtimeMs - left.mtimeMs)
    .slice(0, options.scanLimit);
  const loops: LocalLoopRecord[] = [];
  const warnings: string[] = [];

  for (const entry of loopDirs) {
    const recordPath = join(runsRoot, entry.name, "loop-record.json");
    try {
      loops.push(await readJsonFile(recordPath));
    } catch {
      warnings.push(`unreadable_run:${entry.name}`);
    }
  }

  loops.sort((left, right) => loopTimestamp(right) - loopTimestamp(left));

  return {
    available: true,
    inspectedRuns: loopDirs.length,
    scanLimit: options.scanLimit,
    scanLimited: loopEntries.length > loopDirs.length,
    totalRuns: loopEntries.length,
    latestRun: summarizeLoop(loops[0]),
    runsNeedingTriage: loops
      .filter((loop) => loop.status !== "completed" || loop.lifecycleState !== "completed")
      .slice(0, 5)
      .map((loop) => summarizeLoop(loop))
      .filter((loop): loop is NativePhaseRunSummary => loop !== null),
    warnings
  };
}

function loopTimestamp(loop: LocalLoopRecord): number {
  const candidate = loop.updatedAt ?? loop.createdAt;
  if (!candidate) {
    return 0;
  }
  const parsed = Date.parse(candidate);
  return Number.isNaN(parsed) ? 0 : parsed;
}

async function buildPhaseContract(rootDir: string, phaseWorkspace: PhaseWorkspaceState): Promise<NativePhaseContract> {
  const verifiers = normalizeArray(phaseWorkspace.contractOverride?.verifiers);
  const detectedVerifiers = await detectPackageVerifiers(rootDir);
  const finalVerifiers = verifiers.length > 0 ? verifiers : detectedVerifiers;
  const allowedPaths = normalizeArray(phaseWorkspace.contractOverride?.allowedPaths);
  const blockedPaths = [...new Set([...DEFAULT_BLOCKED_PATHS, ...normalizeArray(phaseWorkspace.contractOverride?.blockedPaths)])];
  const objective =
    typeof phaseWorkspace.contractOverride?.objective === "string" && phaseWorkspace.contractOverride.objective.trim()
      ? phaseWorkspace.contractOverride.objective.trim()
      : phaseWorkspace.planTitle
        ? `Execute MartinLoop phase: ${phaseWorkspace.planTitle}`
        : "Execute the current MartinLoop phase";
  const budget = {
    ...DEFAULT_BUDGET,
    ...(isObject(phaseWorkspace.contractOverride?.budget) ? phaseWorkspace.contractOverride.budget : {})
  };
  const missingSafeguards = [
    ...phaseWorkspace.missingSafeguards,
    allowedPaths.length === 0 ? "missing_allowed_paths" : null,
    finalVerifiers.length === 0 ? "missing_verifiers" : null
  ].filter((value): value is string => value !== null);

  return {
    objective,
    phase: phaseWorkspace.activePhase ?? "current",
    allowedPaths,
    blockedPaths,
    budget: {
      maxUsd: numberOrDefault(budget.maxUsd, DEFAULT_BUDGET.maxUsd),
      maxIterations: numberOrDefault(budget.maxIterations, DEFAULT_BUDGET.maxIterations),
      maxCommands: numberOrDefault(budget.maxCommands, DEFAULT_BUDGET.maxCommands)
    },
    verifiers: finalVerifiers,
    riskLevel: missingSafeguards.length > 0 ? "high" : "medium",
    requiresApproval: missingSafeguards.length > 0,
    missingSafeguards,
    source: phaseWorkspace.contractPath ?? phaseWorkspace.planPath ?? "generated_safe_default"
  };
}

async function detectPackageVerifiers(rootDir: string): Promise<string[]> {
  const packageJson = await readJsonFile(join(rootDir, "package.json")).catch(() => null);
  const scripts = isObject(packageJson?.scripts) ? packageJson.scripts : {};
  const packageManager = await detectPackageManager(rootDir);
  const verifiers: string[] = [];

  for (const scriptName of ["test", "lint", "build"]) {
    if (typeof scripts[scriptName] === "string") {
      verifiers.push(packageManager === "npm" ? `npm run ${scriptName}` : `${packageManager} ${scriptName}`);
    }
  }

  return verifiers;
}

async function detectPackageManager(rootDir: string): Promise<"pnpm" | "npm" | "yarn" | "bun"> {
  if (await pathExists(join(rootDir, "pnpm-lock.yaml"))) {
    return "pnpm";
  }
  if (await pathExists(join(rootDir, "yarn.lock"))) {
    return "yarn";
  }
  if ((await pathExists(join(rootDir, "bun.lockb"))) || (await pathExists(join(rootDir, "bun.lock")))) {
    return "bun";
  }
  return "npm";
}

function recommendedNextAction(
  phaseWorkspace: PhaseWorkspaceState,
  runStore: NativePhaseSnapshot["runStore"],
  contract: NativePhaseContract
): string {
  if (contract.requiresApproval) {
    return "Review the generated phase contract, add allowed paths/verifiers, then run martin-loop phase preflight.";
  }

  if (runStore.runsNeedingTriage.length > 0) {
    return "Triage the latest incomplete MartinLoop runs before starting another phase.";
  }

  if (!phaseWorkspace.available) {
    return "Run martin-loop doctor, then initialize or select a MartinLoop phase before starting a governed run.";
  }

  return "Run martin-loop phase preflight before spending work.";
}

function summarizeLoop(loop: LocalLoopRecord | undefined): NativePhaseRunSummary | null {
  if (!loop?.loopId) {
    return null;
  }

  const verificationEvents = Array.isArray(loop.events)
    ? loop.events.filter((event) => event.type === "verification.completed")
    : [];
  const latestVerification = verificationEvents.at(-1);

  return {
    loopId: loop.loopId,
    status: loop.status ?? "unknown",
    lifecycleState: loop.lifecycleState ?? "unknown",
    title: loop.task?.title ?? loop.task?.objective ?? "Untitled run",
    verifier:
      latestVerification?.payload?.passed === true
        ? "passed"
        : latestVerification?.payload?.passed === false
          ? "failed"
          : "unavailable",
    budgetUsedUsd: loop.cost?.actualUsd ?? null,
    updatedAt: loop.updatedAt ?? loop.createdAt ?? null
  };
}

async function pathExists(targetPath: string): Promise<boolean> {
  return stat(targetPath).then(() => true, () => false);
}

async function readJsonFile(targetPath: string): Promise<Record<string, unknown>> {
  const raw = await readFile(targetPath, "utf8");
  return JSON.parse(raw) as Record<string, unknown>;
}

async function readTextIfExists(targetPath: string): Promise<string | null> {
  return readFile(targetPath, "utf8").catch(() => null);
}

function extractPlanTitle(planText: string | null): string | null {
  if (!planText) {
    return null;
  }

  const heading = planText
    .split(/\r?\n/g)
    .map((line) => line.trim())
    .find((line) => line.startsWith("# "));

  return heading ? heading.replace(/^#\s+/u, "").trim() : null;
}

function normalizeArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function numberOrDefault(value: unknown, defaultValue: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : defaultValue;
}
