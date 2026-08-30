// SPDX-FileCopyrightText: MartinLoop contributors
//
// SPDX-License-Identifier: Apache-2.0

import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import type { LoopBudget, MutationMode, ReceiptScope } from "@martin/contracts";

const WORKFLOW_STATE_DIRECTORY = "_martin";
const WORKFLOW_STATE_FILENAME = "workflow-state.json";
const WORKSPACES_DIRECTORY = "workspaces";
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

// Write the "plan" step into the mcp section of the per-workspace workflow-state.json.
// CLI and MCP share the same per-workspace file so that martin://agent/governance-status
// and martin gate reflect plan completion.
export async function recordMcpPlanStep(input: {
  runsRoot: string;
  workingDirectory: string;
  objective: string;
  receiptScope?: ReceiptScope;
}): Promise<void> {
  const workspaceKey = deriveWorkspaceKey(input.workingDirectory);
  const mcpDir = join(resolve(input.runsRoot), WORKFLOW_STATE_DIRECTORY, WORKSPACES_DIRECTORY, workspaceKey);
  const statePath = join(mcpDir, WORKFLOW_STATE_FILENAME);
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

  await mkdir(mcpDir, { recursive: true });
  const mcpTmp = `${statePath}.${randomBytes(4).toString("hex")}.tmp`;
  await writeFile(mcpTmp, JSON.stringify(state, null, 2), "utf8");
  await rename(mcpTmp, statePath);
}

export async function recordCliWorkflowStep(input: CliWorkflowStepInput): Promise<void> {
  const state = await readWorkflowState(input.runsRoot, input.workingDirectory);
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
    ...(input.budget
      ? { budgetKey: input.step === "estimate" ? hashEstimateBudget(input.budget) : hashBudget(input.budget) }
      : {})
  };

  state.cli ??= {};
  state.cli[input.step] = receipt;
  await writeWorkflowState(input.runsRoot, state, input.workingDirectory);
}

export async function evaluateCliRunGate(input: CliRunGateInput): Promise<CliRunGateResult> {
  const state = await readWorkflowState(input.runsRoot, input.workingDirectory);
  const cliState = state.cli ?? {};
  const workingDirectory = normalizeWorkingDirectory(input.workingDirectory);
  const verificationPlanKey = hashVerificationPlan(input.verificationPlan);
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
    receipt.workingDirectory === workingDirectory &&
    receipt.objectiveKey === normalizeObjective(input.objective) &&
    matchesCanonicalScope(receipt, canonicalScopeKey, scopeKey) &&
    (!input.budget || receipt.budgetKey === hashEstimateBudget(input.budget))
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

  // Preflight scope: workspace identity + verifier + path policy only.
  // Engine, budget, max-iterations, and token limits are runtime execution controls —
  // not safety identity. Changing them does NOT require a fresh preflight.
  // Only a changed verifier command or path scope invalidates the receipt.
  const preflightReady = isFresh(cliState["preflight"], PREFLIGHT_TTL_MS, (receipt) =>
    receipt.workingDirectory === workingDirectory &&
    receipt.verificationPlanKey === verificationPlanKey &&
    receipt.pathScopeKey === pathScopeKey
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
    ? " Preflight must be rerun when verifier or path scope changed."
    : "";
  return `Governed run blocked until MartinLoop receipts exist for ${labels.join(", ")}.${preflightReason} Next command: ${nextCommand}`;
}

// Reads per-workspace state when workingDirectory is supplied; reads global state otherwise.
// Global state is used only for flags like firstRunBannerShown that are not workspace-scoped.
async function readWorkflowState(runsRoot: string, workingDirectory?: string): Promise<WorkflowState> {
  const statePath = resolveWorkflowStatePath(runsRoot, workingDirectory);
  try {
    const raw = await readFile(statePath, "utf8");
    const parsed = JSON.parse(raw) as WorkflowState;
    return parsed.version === 1 ? parsed : { version: 1 };
  } catch {
    return { version: 1 };
  }
}

// Writes per-workspace state atomically (tmp → rename) when workingDirectory is supplied.
// Atomic rename prevents partial reads from concurrent processes in the same workspace.
async function writeWorkflowState(runsRoot: string, state: WorkflowState, workingDirectory?: string): Promise<void> {
  const statePath = resolveWorkflowStatePath(runsRoot, workingDirectory);
  const dir = workingDirectory
    ? join(resolve(runsRoot), WORKFLOW_STATE_DIRECTORY, WORKSPACES_DIRECTORY, deriveWorkspaceKey(workingDirectory))
    : join(resolve(runsRoot), WORKFLOW_STATE_DIRECTORY);
  await mkdir(dir, { recursive: true });
  const tmpPath = `${statePath}.${randomBytes(4).toString("hex")}.tmp`;
  await writeFile(tmpPath, JSON.stringify(state, null, 2), "utf8");
  await rename(tmpPath, statePath);
}

// Per-workspace path: <runsRoot>/_martin/workspaces/<workspaceKey>/workflow-state.json
// Global path:        <runsRoot>/_martin/workflow-state.json  (firstRunBanner only)
//
// COMPATIBILITY: pre-fix versions wrote all CLI receipts to the global path.
// Legacy state is NOT migrated. Users must re-run the governance sequence once after upgrading.
function resolveWorkflowStatePath(runsRoot: string, workingDirectory?: string): string {
  const base = join(resolve(runsRoot), WORKFLOW_STATE_DIRECTORY);
  if (workingDirectory) {
    return join(base, WORKSPACES_DIRECTORY, deriveWorkspaceKey(workingDirectory), WORKFLOW_STATE_FILENAME);
  }
  return join(base, WORKFLOW_STATE_FILENAME);
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

// Derives a stable per-workspace key from the normalized working directory path.
// Uses SHA-256 so the key is portable (same repo on same machine = same key),
// but does not encode machine-specific absolute paths into the stored receipts.
export function deriveWorkspaceKey(workingDirectory: string): string {
  return createHash("sha256")
    .update(normalizeWorkingDirectory(workingDirectory))
    .digest("hex")
    .slice(0, 16);
}

export function deriveWorkspaceId(workingDirectory: string): string {
  return `ws_${deriveWorkspaceKey(workingDirectory)}`;
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
    ...(budget.maxTokens !== undefined ? { maxTokens: budget.maxTokens } : {})
  };
  return createHash("sha256").update(JSON.stringify(normalized)).digest("hex").slice(0, 12);
}

function hashEstimateBudget(budget: Pick<LoopBudget, "maxUsd">): string {
  return createHash("sha256")
    .update(JSON.stringify({ maxUsd: Number(budget.maxUsd.toFixed(4)) }))
    .digest("hex")
    .slice(0, 12);
}
