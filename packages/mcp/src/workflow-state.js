import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
const WORKFLOW_STATE_DIRECTORY = "_martin";
const WORKFLOW_STATE_FILENAME = "workflow-state.json";
const DOCTOR_TTL_MS = 24 * 60 * 60 * 1000;
const PLAN_TTL_MS = 24 * 60 * 60 * 1000;
const PREFLIGHT_TTL_MS = 6 * 60 * 60 * 1000;
export async function recordMcpWorkflowStep(input) {
    const state = await readWorkflowState(input.runsRoot);
    state.mcp ??= {};
    state.mcp[input.step] = {
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
    await writeWorkflowState(input.runsRoot, state);
}
export async function evaluateMcpRunGate(input) {
    const state = await readWorkflowState(input.runsRoot);
    const mcpState = state.mcp ?? {};
    const workingDirectory = normalizeWorkingDirectory(input.workingDirectory);
    const objectiveKey = normalizeObjective(input.objective);
    const engine = input.engine ?? "claude";
    const verificationPlanKey = hashVerificationPlan(input.verificationPlan ?? []);
    const scopeKey = hashReceiptScope(input.receiptScope ?? {
        invocationRoot: input.workingDirectory,
        workingDirectory: input.workingDirectory,
        repoRoot: input.workingDirectory,
        runsRoot: input.runsRoot
    });
    const pathScopeKey = hashPathScope(input.allowedPaths ?? [], input.deniedPaths ?? []);
    const budgetKey = input.budget ? hashBudget(input.budget) : undefined;
    const missingSteps = [];
    if (!isFresh(mcpState["doctor"], DOCTOR_TTL_MS, (receipt) => receipt.workingDirectory === workingDirectory &&
        receipt.scopeKey === scopeKey)) {
        missingSteps.push("doctor");
    }
    if (!isFresh(mcpState["plan"], PLAN_TTL_MS, (receipt) => receipt.workingDirectory === workingDirectory &&
        receipt.scopeKey === scopeKey &&
        receipt.objectiveKey === objectiveKey)) {
        missingSteps.push("plan");
    }
    if (!isFresh(mcpState["preflight"], PREFLIGHT_TTL_MS, (receipt) => receipt.workingDirectory === workingDirectory &&
        receipt.objectiveKey === objectiveKey &&
        receipt.engine === engine &&
        receipt.verificationPlanKey === verificationPlanKey &&
        receipt.scopeKey === scopeKey &&
        receipt.pathScopeKey === pathScopeKey &&
        (budgetKey === undefined || receipt.budgetKey === budgetKey))) {
        missingSteps.push("preflight");
    }
    if (missingSteps.length === 0) {
        return {
            allowed: true,
            nextAction: "martin_run",
            summary: "Martin MCP governance receipts are present for this task.",
            missingSteps
        };
    }
    const nextAction = missingSteps[0] === "doctor"
        ? "Call martin_doctor for this workingDirectory before any real run."
        : missingSteps[0] === "plan"
            ? "Call martin_plan with the exact objective before martin_run."
            : "Call martin_preflight with the exact objective, verifier plan, and engine before martin_run.";
    return {
        allowed: false,
        nextAction,
        summary: `martin_run is blocked until Martin MCP receipts exist for ${missingSteps.join(", ")}.`,
        missingSteps
    };
}
export async function readWorkflowState(runsRoot) {
    const statePath = resolveWorkflowStatePath(runsRoot);
    try {
        const raw = await readFile(statePath, "utf8");
        const parsed = JSON.parse(raw);
        return parsed.version === 1 ? parsed : { version: 1 };
    }
    catch {
        return { version: 1 };
    }
}
async function writeWorkflowState(runsRoot, state) {
    const statePath = resolveWorkflowStatePath(runsRoot);
    await mkdir(join(resolve(runsRoot), WORKFLOW_STATE_DIRECTORY), { recursive: true });
    await writeFile(statePath, JSON.stringify(state, null, 2), "utf8");
}
function resolveWorkflowStatePath(runsRoot) {
    return join(resolve(runsRoot), WORKFLOW_STATE_DIRECTORY, WORKFLOW_STATE_FILENAME);
}
function isFresh(receipt, ttlMs, predicate) {
    if (!receipt || !predicate(receipt)) {
        return false;
    }
    const recordedAt = Date.parse(receipt.recordedAt);
    if (Number.isNaN(recordedAt)) {
        return false;
    }
    return Date.now() - recordedAt <= ttlMs;
}
function normalizeWorkingDirectory(workingDirectory) {
    const resolved = resolve(workingDirectory);
    return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}
function normalizeObjective(objective) {
    return objective.trim().replace(/\s+/gu, " ").toLowerCase();
}
function hashVerificationPlan(verificationPlan) {
    const normalized = verificationPlan.map((step) => step.trim()).filter(Boolean);
    return createHash("sha256").update(JSON.stringify(normalized)).digest("hex").slice(0, 12);
}
function hashReceiptScope(receiptScope) {
    const normalized = {
        invocationRoot: normalizeWorkingDirectory(receiptScope.invocationRoot ?? receiptScope.workingDirectory ?? ""),
        workingDirectory: normalizeWorkingDirectory(receiptScope.workingDirectory ?? receiptScope.repoRoot ?? ""),
        repoRoot: normalizeWorkingDirectory(receiptScope.repoRoot ?? receiptScope.workingDirectory ?? ""),
        runsRoot: normalizeWorkingDirectory(receiptScope.runsRoot ?? "")
    };
    return createHash("sha256").update(JSON.stringify(normalized)).digest("hex").slice(0, 12);
}
function hashPathScope(allowedPaths, deniedPaths) {
    const normalized = {
        allowedPaths: [...new Set(allowedPaths.map((entry) => entry.trim()).filter(Boolean))].sort(),
        deniedPaths: [...new Set(deniedPaths.map((entry) => entry.trim()).filter(Boolean))].sort()
    };
    return createHash("sha256").update(JSON.stringify(normalized)).digest("hex").slice(0, 12);
}
function hashBudget(budget) {
    const normalized = {
        maxUsd: Number(budget.maxUsd.toFixed(4)),
        softLimitUsd: Number(budget.softLimitUsd.toFixed(4)),
        maxIterations: budget.maxIterations,
        maxTokens: budget.maxTokens
    };
    return createHash("sha256").update(JSON.stringify(normalized)).digest("hex").slice(0, 12);
}
//# sourceMappingURL=workflow-state.js.map