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
  | "estimate"
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
  canonicalScopeKey?: string;
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

// Write the "plan" step into the mcp section of the shared workflow-state.json.
// The CLI and MCP packages share the same _martin/workflow-state.json file;
// the CLI writes to `cli.*` steps and can also stamp `mcp.plan` so that
// martin://agent/governance-status and martin gate reflect plan completion.
export async function recordMcpPlanStep(input: {
  runsRoot: string;
  workingDirectory: string;
  objective: string;
  receiptScope?: ReceiptScope;
}): Promise<void> {
  const statePath = join(resolve(input.runsRoot), WORKFLOW_STATE_DIRECTORY, WORKFLOW_STATE_FILENAME);
  let state: { version: 1; cli?: Record<string, unknown>; mcp?: Record<string, unknown> } = { version: 1 };
  try {
    const raw = await readFile(statePath, "utf8");
    const parsed = JSON.parse(raw) as typeof state;
    if (parsed.version === 1) {
      state = parsed;
    }
  } catch { /* fresh state */ }

  const normalized = process.platform === "win32" ? resolve(input.workingDirectory).toLowerCase() : resolve(input.workingDirectory);
  const objectiveKey = input.objective.trim().replace(/\s+/gu, " ").toLowerCase();
  const scopeKey = input.receiptScope
    ? createHash("sha256").update(JSON.stringify({
        invocationRoot: process.platform === "win32" ? resolve(input.receiptScope.invocationRoot ?? input.receiptScope.workingDirectory ?? "").toLowerCase() : resolve(input.receiptScope.invocationRoot ?? input.receiptScope.workingDirectory ?? ""),
        workingDirectory: process.platform === "win32" ? resolve(input.receiptScope.workingDirectory ?? input.receiptScope.repoRoot ?? "").toLowerCase() : resolve(input.receiptScope.workingDirectory ?? input.receiptScope.repoRoot ?? ""),
        repoRoot: process.platform === "win32" ? resolve(input.receiptScope.repoRoot ?? input.receiptScope.workingDirectory ?? "").toLowerCase() : resolve(input.receiptScope.repoRoot ?? input.receiptScope.workingDirectory ?? ""),
        runsRoot: process.platform === "win32" ? resolve(input.receiptScope.runsRoot ?? "").toLowerCase() : resolve(input.receiptScope.runsRoot ?? "")
      })).digest("hex").slice(0, 12)
    : undefined;

  state.mcp ??= {};
  state.mcp["plan"] = {
    step: "plan",
    recordedAt: new Date().toISOString(),
    workingDirectory: normalized,
    objectiveKey,
    ...(scopeKey ? { scopeKey } : {})
  };

  await mkdir(join(resolve(input.runsRoot), WORKFLOW_STATE_DIRECTORY), { recursive: true });
  await writeFile(statePath, JSON.stringify(state, null, 2), "utf8");
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
    ...(input.receiptScope ? { canonicalScopeKey: hashCanonicalReceiptScope(input.receiptScope) } : {}),
    pathScopeKey: hashPathScope(input.allowedPaths ?? [], input.deniedPaths ?? []),
    ...(input.budget ? { budgetKey: hashBudget(input.budget) } : {})
  };

  state.cli ??= {};
  state.cli[input.step] = receipt;
  await writeWorkflowState(input.runsRoot, state);
}

export async function evaluateCliRunGate(input: CliRunGateInput): Promise<CliRunGateResult> {


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
  const canonicalScopeKey = hashCanonicalReceiptScope(
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

  // Doctor/session-start are repo-scoped readiness checks. They should remain
  // valid when INIT_CWD changes inside the same repo, but must still fail
  // closed if the canonical repo/runsRoot identity changes.
  const doctorReady = isFresh(cliState["doctor"], DOCTOR_TTL_MS, (receipt) =>
    receipt.workingDirectory === workingDirectory &&
    matchesCanonicalScope(receipt, canonicalScopeKey, scopeKey)
  );
  if (!doctorReady) {
    missingSteps.push("doctor");
  }

  // Estimate is required before any governed run — it proves the agent
  // saw the cost estimate and budget recommendation before spending.
  // This is the root enforcement: no estimate receipt = no run.
  const estimateReady = isFresh(cliState["estimate"], PREFLIGHT_TTL_MS, (receipt) =>
    receipt.workingDirectory === workingDirectory
  );
  if (!estimateReady) {
    missingSteps.push("estimate");
  }

  // Session-start is optional when estimate is present — estimate proves the
  // user understood the cost before starting. This prevents the gate from
  // blocking users who ran doctor + estimate + preflight but skipped session-start.
  const sessionReady =
    estimateReady || // estimate satisfies session requirement
    isFresh(cliState["session-start"], SESSION_TTL_MS, (receipt) =>
      receipt.workingDirectory === workingDirectory &&
      matchesCanonicalScope(receipt, canonicalScopeKey, scopeKey)
    ) ||
    isFresh(cliState["start"], SESSION_TTL_MS, (receipt) =>
      receipt.workingDirectory === workingDirectory &&
      matchesCanonicalScope(receipt, canonicalScopeKey, scopeKey)
    ) ||
    isFresh(cliState["tour"], SESSION_TTL_MS, (receipt) =>
      receipt.workingDirectory === workingDirectory &&
      matchesCanonicalScope(receipt, canonicalScopeKey, scopeKey)
    );
  if (!sessionReady) {
    missingSteps.push("session-start");
  }

  // Preflight check: match on workingDirectory + engine + execution bounds.
  // The full hash match was too strict — minor objective wording differences would break
  // the receipt chain. The key governance signal is that preflight ran for this directory
  // and engine recently; the exact objective text can drift between preflight and run.
  // Path policy and budget are execution bounds, so changing them requires a fresh preflight.
  const preflightReady = isFresh(cliState["preflight"], PREFLIGHT_TTL_MS, (receipt) =>
    receipt.workingDirectory === workingDirectory &&
    receipt.engine === engine &&
    receipt.verificationPlanKey === verificationPlanKey &&
    receipt.pathScopeKey === pathScopeKey &&
    (!budgetKey || receipt.budgetKey === budgetKey)
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

  if (missingSteps.includes("estimate")) {
    return `martin-loop estimate "${objective}" --budget-usd 5`;
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
  const preflightReason = missingSteps.includes("preflight")
    ? " Preflight must be rerun when engine, verifier, path scope or budget changed."
    : "";
  return `Governed run blocked until MartinLoop receipts exist for ${labels.join(", ")}.${preflightReason} Next command: ${nextCommand}`;
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

function hashCanonicalReceiptScope(receiptScope: ReceiptScope): string {
  const normalized = {
    workingDirectory: normalizeWorkingDirectory(
      receiptScope.workingDirectory ?? receiptScope.repoRoot ?? ""
    ),
    repoRoot: normalizeWorkingDirectory(receiptScope.repoRoot ?? receiptScope.workingDirectory ?? ""),
    runsRoot: normalizeWorkingDirectory(receiptScope.runsRoot ?? "")
  };
  return createHash("sha256").update(JSON.stringify(normalized)).digest("hex").slice(0, 12);
}

function matchesCanonicalScope(
  receipt: CliWorkflowReceipt,
  canonicalScopeKey: string,
  exactScopeKey: string
): boolean {
  if (receipt.canonicalScopeKey) {
    return receipt.canonicalScopeKey === canonicalScopeKey;
  }

  return receipt.scopeKey === exactScopeKey;
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
