import type { LoopBudget, ReceiptScope } from "./vendor/contracts/index.js";
type McpWorkflowStepName = "doctor" | "plan" | "preflight" | "estimate" | "start";
interface McpWorkflowReceipt {
    step: McpWorkflowStepName;
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
    cli?: unknown;
    mcp?: Partial<Record<McpWorkflowStepName, McpWorkflowReceipt>>;
}
export interface RecordMcpWorkflowStepInput {
    runsRoot: string;
    step: McpWorkflowStepName;
    workingDirectory: string;
    objective?: string;
    engine?: string;
    verificationPlan?: string[];
    receiptScope?: ReceiptScope;
    allowedPaths?: string[];
    deniedPaths?: string[];
    budget?: LoopBudget;
}
export interface EvaluateMcpRunGateInput {
    runsRoot: string;
    workingDirectory: string;
    objective: string;
    engine?: string;
    verificationPlan?: string[];
    receiptScope?: ReceiptScope;
    allowedPaths?: string[];
    deniedPaths?: string[];
    budget?: LoopBudget;
}
export interface McpRunGateResult {
    allowed: boolean;
    nextAction: string;
    summary: string;
    missingSteps: McpWorkflowStepName[];
}
export declare function recordMcpWorkflowStep(input: RecordMcpWorkflowStepInput): Promise<void>;
export declare function evaluateMcpRunGate(input: EvaluateMcpRunGateInput): Promise<McpRunGateResult>;
export declare function readWorkflowState(runsRoot: string, workingDirectory?: string): Promise<WorkflowState>;
export {};
