import type { ApprovalPolicy, LoopBudget, LoopTask, MutationMode } from "./index.js";
import type {
  DestructiveActionPolicy,
  PolicyProfile,
  TelemetryDestination
} from "./governance.js";

export interface ExecutionPolicy {
  configPath: string;
  budget: LoopBudget;
  governance: {
    policyProfile: PolicyProfile;
    telemetryDestination: TelemetryDestination;
    destructiveActionPolicy: DestructiveActionPolicy;
  };
  task: {
    verificationPlan: string[];
    mutationMode?: MutationMode;
    repoRoot?: string;
    allowedPaths?: string[];
    deniedPaths?: string[];
    acceptanceCriteria?: string[];
    approvalPolicy?: ApprovalPolicy;
  };
  provenance: ExecutionPolicyProvenanceEntry[];
}

export interface ExecutionPolicyProvenanceEntry {
  field: string;
  source: "default" | "config" | "request";
  value: string;
}

export interface ExecutionPolicyDefaults {
  budget: LoopBudget;
  policyProfile: PolicyProfile;
  telemetryDestination: TelemetryDestination;
  destructiveActionPolicy: DestructiveActionPolicy;
  verifierRules: string[];
}

export interface ExecutionPolicyConfigInput {
  policyProfile?: string;
  budget?: Partial<LoopBudget>;
  governance?: {
    destructiveActionPolicy?: string;
    telemetryDestination?: string;
    verifierRules?: string[];
  };
}

export interface ExecutionPolicyRequestInput {
  budget: LoopBudget;
  budgetOverrides?: Partial<Record<keyof LoopBudget, true>>;
  policyProfile?: string;
  telemetryDestination?: string;
  verificationPlan?: string[];
  mutationMode?: LoopTask["mutationMode"];
  repoRoot?: string;
  allowedPaths?: string[];
  deniedPaths?: string[];
  acceptanceCriteria?: string[];
  approvalPolicy?: ApprovalPolicy;
}

export interface ExecutionPolicyCompileInput {
  configPath: string;
  defaults: ExecutionPolicyDefaults;
  config?: ExecutionPolicyConfigInput;
  request: ExecutionPolicyRequestInput;
}

// ---------------------------------------------------------------------------
// Routing policy — controls pre-work coordination cost
// ---------------------------------------------------------------------------

export type RoutingMode = "direct" | "manager" | "adaptive" | "consensus";

export interface RoutingPolicy {
  enabled: boolean;
  mode: RoutingMode;
  /** Max percentage of total budget that can be spent before first code change. */
  maxPreworkBudgetPct: number;
  /** Hard dollar cap on pre-work spend. */
  maxPreworkCostUsd: number;
  /** Max model calls allowed for manager/router/planner before worker starts. */
  maxManagerCalls: number;
  /** Skip orchestration entirely if task confidence is above this threshold (0-1). */
  skipOrchestrationIfConfidenceAbove: number;
  /** Force direct execution for tasks classified as simple. */
  requireDirectForSimpleTasks: boolean;
}

export const DEFAULT_ROUTING_POLICY: RoutingPolicy = {
  enabled: true,
  mode: "adaptive",
  maxPreworkBudgetPct: 25,
  maxPreworkCostUsd: 2.0,
  maxManagerCalls: 2,
  skipOrchestrationIfConfidenceAbove: 0.85,
  requireDirectForSimpleTasks: true
};

export function cloneExecutionPolicy(policy: ExecutionPolicy): ExecutionPolicy {
  return {
    configPath: policy.configPath,
    budget: {
      maxUsd: policy.budget.maxUsd,
      softLimitUsd: policy.budget.softLimitUsd,
      maxIterations: policy.budget.maxIterations,
      ...(policy.budget.maxTokens !== undefined ? { maxTokens: policy.budget.maxTokens } : {})
    },
    governance: {
      policyProfile: policy.governance.policyProfile,
      telemetryDestination: policy.governance.telemetryDestination,
      destructiveActionPolicy: policy.governance.destructiveActionPolicy
    },
    task: {
      verificationPlan: [...policy.task.verificationPlan],
      ...(policy.task.mutationMode ? { mutationMode: policy.task.mutationMode } : {}),
      ...(policy.task.repoRoot ? { repoRoot: policy.task.repoRoot } : {}),
      ...(policy.task.allowedPaths ? { allowedPaths: [...policy.task.allowedPaths] } : {}),
      ...(policy.task.deniedPaths ? { deniedPaths: [...policy.task.deniedPaths] } : {}),
      ...(policy.task.acceptanceCriteria
        ? { acceptanceCriteria: [...policy.task.acceptanceCriteria] }
        : {}),
      ...(policy.task.approvalPolicy
        ? {
            approvalPolicy: {
              ...policy.task.approvalPolicy
            }
          }
        : {})
    },
    provenance: policy.provenance.map((entry) => ({ ...entry }))
  };
}
