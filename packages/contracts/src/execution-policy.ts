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

export function cloneExecutionPolicy(policy: ExecutionPolicy): ExecutionPolicy {
  return {
    configPath: policy.configPath,
    budget: {
      maxUsd: policy.budget.maxUsd,
      softLimitUsd: policy.budget.softLimitUsd,
      maxIterations: policy.budget.maxIterations,
      maxTokens: policy.budget.maxTokens
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
