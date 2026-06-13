import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import type { LoopBudget, MutationMode, ReceiptScope } from "@martin/contracts";

const WORKFLOW_STATE_DIRECTORY = "_martin";
const WORKFLOW_STATE_FILENAME = "workflow-state.json";
const DOCTOR_TTL_MS = 24 * 60 * 60 * 1000;
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;
const PREFLIGHT_TTL_MS = 6 * 60 * 60 * 1000;

type CliWorkflowStepName =
  | "start"
  | "tour"
  | "guide"
  | "doctor"
  | "session-start"
  | "preflight";

interface CliWorkflowReceipt {
  step: CliWorkflowStepName;
  recordedAt: string;
  workingDirectory: string;
  objectiveKey?: string;
  engine?: string;
  verificationPlanKey?: string;
  scopeKey?: string;
  pathScopeKey?: string;
  budgetKey?: string;
}

interface WorkflowState {
  version: 1;
  firstRunBannerShown?: boolean;
  cli?: Partial<Record<CliWorkflowStepName, CliWorkflowReceipt>>;
}

export interface CliWorkflowStepInput {
  runsRoot: string;
  step: CliWorkflowStepName;
  workingDirectory: string;
  objective?: string;
  engine?: string;
  verificationPlan?: string[];
  receiptScope?: ReceiptScope;
  allowedPaths?: string[];
  deniedPaths?: string[];
  budget?: LoopBudget;
}

export interface CliRunGateInput {
  runsRoot: string;
  workingDirectory: string;
  objective: string;
  engine?: string;
  verificationPlan: string[];
  mutationMode?: MutationMode;
  receiptScope?: ReceiptScope;
  allowedPaths?: string[];
  deniedPaths?: string[];
  budget?: LoopBudget;
}

export interface CliRunGateResult {
  allowed: boolean;
  nextCommand: string;
  message: string;
  missingSteps: CliWorkflowStepName[];
}

export async function consumeFirstRunBanner(runsRoot: string): Promise<string | undefined> {
  const state = await readWorkflowState(runsRoot);
  if (state.firstRunBannerShown) {
    return undefined;
  }

  state.firstRunBannerShown = true;
  await writeWorkflowState(runsRoot, state);

  return [
    "MartinLoop quick start",
    "  martin-loop tour",
    "  martin-loop start",
    "  martin-loop doctor",
    "",
    "MartinLoop will block real governed runs until doctor and preflight receipts exist for this repo."
  ].join("\n");
}

export async function recordCliWorkflowStep(input: CliWorkflowStepInput): Promise<void> {
  const state = await readWorkflowState(input.runsRoot);
  const receipt: CliWorkflowReceipt = {
    step: input.step,
    recordedAt: new Date().toISOString(),
    workingDirectory: normalizeWorkingDirectory(input.workingDirectory),
    ...(input.objective ? { objectiveKey: normalizeObjective(input.objective) } : {}),
    ...(input.engine ? { engine: input.engine } : {}),
    ...(input.verificationPlan ? { verificationPlanKey: hashVerificationPlan(input.verificationPlan) } : {}),
    ...(input.receiptScope ? { scopeKey: hashReceiptScope(input.receiptScope) } : {}),
    pathScopeKey: hashPathScope(input.allowedPaths ?? [], input.deniedPaths ?? []),
    ...(input.budget ? { budgetKey: hashBudget(input.budget) } : {})
  };

  state.cli ??= {};
  state.cli[input.step] = receipt;
  await writeWorkflowState(input.runsRoot, state);
}

export async function evaluateCliRunGate(input: CliRunGateInput): Promise<CliRunGateResult> {
  if (input.mutationMode === "verify_only") {
    return {
      allowed: true,
      nextCommand: "martin-loop run --verify-only",
      message: "verify_only mode does not require a governed coding receipt chain.",
      missingSteps: []
    };
  }

  const state = await readWorkflowState(input.runsRoot);
  const cliState = state.cli ?? {};
  const workingDirectory = normalizeWorkingDirectory(input.workingDirectory);
  const objectiveKey = normalizeObjective(input.objective);
  const verificationPlanKey = hashVerificationPlan(input.verificationPlan);
  const engine = input.engine ?? "claude";
  const scopeKey = hashReceiptScope(
    input.receiptScope ?? {
      invocationRoot: input.workingDirectory,
      workingDirectory: input.workingDirectory,
      repoRoot: input.workingDirectory,
      runsRoot: input.runsRoot
    }
  );
  const pathScopeKey = hashPathScope(input.allowedPaths ?? [], input.deniedPaths ?? []);
  const budgetKey = input.budget ? hashBudget(input.budget) : undefined;
  const missingSteps: CliWorkflowStepName[] = [];

  const doctorReady = isFresh(cliState["doctor"], DOCTOR_TTL_MS, (receipt) =>
    receipt.workingDirectory === workingDirectory &&
    receipt.scopeKey === scopeKey
  );
  if (!doctorReady) {
    missingSteps.push("doctor");
  }

  const sessionReady =
    isFresh(cliState["session-start"], SESSION_TTL_MS, (receipt) =>
      receipt.workingDirectory === workingDirectory &&
      receipt.scopeKey === scopeKey
    ) ||
    isFresh(cliState["start"], SESSION_TTL_MS, (receipt) =>
      receipt.workingDirectory === workingDirectory &&
      receipt.scopeKey === scopeKey
    ) ||
    isFresh(cliState["tour"], SESSION_TTL_MS, (receipt) =>
      receipt.workingDirectory === workingDirectory &&
      receipt.scopeKey === scopeKey
    );
  if (!sessionReady) {
    missingSteps.push("session-start");
  }

  const preflightReady = isFresh(cliState["preflight"], PREFLIGHT_TTL_MS, (receipt) =>
    receipt.workingDirectory === workingDirectory &&
    receipt.objectiveKey === objectiveKey &&
    receipt.engine === engine &&
    receipt.verificationPlanKey === verificationPlanKey &&
    receipt.scopeKey === scopeKey &&
    receipt.pathScopeKey === pathScopeKey &&
    (budgetKey === undefined || receipt.budgetKey === budgetKey)
  );
  if (!preflightReady) {
    missingSteps.push("preflight");
  }

  if (missingSteps.length === 0) {
    return {
      allowed: true,
      nextCommand: "martin-loop run",
      message: "Governed CLI workflow receipts are present for this task.",
      missingSteps
    };
  }

  const nextCommand = selectNextCommand(missingSteps, input.objective, input.verificationPlan);
  return {
    allowed: false,
    nextCommand,
    message: buildBlockedMessage(missingSteps, nextCommand),
    missingSteps
  };
}

function selectNextCommand(
  missingSteps: CliWorkflowStepName[],
  objective: string,
  verificationPlan: string[]
): string {
  if (missingSteps.includes("doctor")) {
    return "martin-loop doctor";
  }

  if (missingSteps.includes("session-start")) {
    return "martin-loop session-start";
  }

  const verify = verificationPlan[0] ? ` --verify "${verificationPlan[0]}"` : "";
  return `martin-loop preflight "${objective}"${verify}`;
}

function buildBlockedMessage(missingSteps: CliWorkflowStepName[], nextCommand: string): string {
  const labels = missingSteps.map((step) =>
    step === "session-start" ? "session start" : step
  );
  return `Governed run blocked until MartinLoop receipts exist for ${labels.join(", ")}. Next command: ${nextCommand}`;
}

async function readWorkflowState(runsRoot: string): Promise<WorkflowState> {
  const statePath = resolveWorkflowStatePath(runsRoot);
  try {
    const raw = await readFile(statePath, "utf8");
    const parsed = JSON.parse(raw) as WorkflowState;
    return parsed.version === 1 ? parsed : { version: 1 };
  } catch {
    return { version: 1 };
  }
}

async function writeWorkflowState(runsRoot: string, state: WorkflowState): Promise<void> {
  const statePath = resolveWorkflowStatePath(runsRoot);
  await mkdir(join(resolve(runsRoot), WORKFLOW_STATE_DIRECTORY), { recursive: true });
  await writeFile(statePath, JSON.stringify(state, null, 2), "utf8");
}

function resolveWorkflowStatePath(runsRoot: string): string {
  return join(resolve(runsRoot), WORKFLOW_STATE_DIRECTORY, WORKFLOW_STATE_FILENAME);
}

function isFresh(
  receipt: CliWorkflowReceipt | undefined,
  ttlMs: number,
  predicate: (receipt: CliWorkflowReceipt) => boolean
): boolean {
  if (!receipt || !predicate(receipt)) {
    return false;
  }

  const recordedAt = Date.parse(receipt.recordedAt);
  if (Number.isNaN(recordedAt)) {
    return false;
  }

  return Date.now() - recordedAt <= ttlMs;
}

function normalizeWorkingDirectory(workingDirectory: string): string {
  const resolved = resolve(workingDirectory);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function normalizeObjective(objective: string): string {
  return objective.trim().replace(/\s+/gu, " ").toLowerCase();
}

function hashVerificationPlan(verificationPlan: string[]): string {
  const normalized = verificationPlan.map((step) => step.trim()).filter(Boolean);
  return createHash("sha256").update(JSON.stringify(normalized)).digest("hex").slice(0, 12);
}

function hashReceiptScope(receiptScope: ReceiptScope): string {
  const normalized = {
    invocationRoot: normalizeWorkingDirectory(
      receiptScope.invocationRoot ?? receiptScope.workingDirectory ?? ""
    ),
    workingDirectory: normalizeWorkingDirectory(
      receiptScope.workingDirectory ?? receiptScope.repoRoot ?? ""
    ),
    repoRoot: normalizeWorkingDirectory(receiptScope.repoRoot ?? receiptScope.workingDirectory ?? ""),
    runsRoot: normalizeWorkingDirectory(receiptScope.runsRoot ?? "")
  };
  return createHash("sha256").update(JSON.stringify(normalized)).digest("hex").slice(0, 12);
}

function hashPathScope(allowedPaths: string[], deniedPaths: string[]): string {
  const normalized = {
    allowedPaths: [...new Set(allowedPaths.map((entry) => entry.trim()).filter(Boolean))].sort(),
    deniedPaths: [...new Set(deniedPaths.map((entry) => entry.trim()).filter(Boolean))].sort()
  };
  return createHash("sha256").update(JSON.stringify(normalized)).digest("hex").slice(0, 12);
}

function hashBudget(budget: LoopBudget): string {
  const normalized = {
    maxUsd: Number(budget.maxUsd.toFixed(4)),
    softLimitUsd: Number(budget.softLimitUsd.toFixed(4)),
    maxIterations: budget.maxIterations,
    maxTokens: budget.maxTokens
  };
  return createHash("sha256").update(JSON.stringify(normalized)).digest("hex").slice(0, 12);
}
