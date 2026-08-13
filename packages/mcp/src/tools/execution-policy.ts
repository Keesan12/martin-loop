import { DEFAULT_BUDGET, type ExecutionPolicy } from "@martin/contracts";
import { compileExecutionPolicy } from "@martin/core";

export interface CompileMcpExecutionPolicyInput {
  workingDirectory: string;
  maxUsd?: number;
  maxIterations?: number;
  maxTokens?: number;
  verificationPlan?: string[];
  allowedPaths?: string[];
  deniedPaths?: string[];
}

export function compileMcpExecutionPolicy(
  input: CompileMcpExecutionPolicyInput
): ExecutionPolicy {
  const normalizedBudget = {
    maxUsd: input.maxUsd ?? DEFAULT_BUDGET.maxUsd,
    softLimitUsd: Math.min(
      DEFAULT_BUDGET.softLimitUsd,
      input.maxUsd ?? DEFAULT_BUDGET.maxUsd
    ),
    maxIterations: input.maxIterations ?? DEFAULT_BUDGET.maxIterations,
    maxTokens: input.maxTokens ?? DEFAULT_BUDGET.maxTokens
  };

  const policy = compileExecutionPolicy({
    configPath: "mcp://inline",
    defaults: {
      budget: DEFAULT_BUDGET,
      policyProfile: "balanced",
      telemetryDestination: "local-only",
      destructiveActionPolicy: "approval",
      verifierRules: []
    },
    request: {
      budget: normalizedBudget,
      budgetOverrides: {
        ...(input.maxUsd !== undefined ? { maxUsd: true } : {}),
        ...(input.maxIterations !== undefined ? { maxIterations: true } : {}),
        ...(input.maxTokens !== undefined ? { maxTokens: true } : {})
      },
      verificationPlan: input.verificationPlan,
      repoRoot: input.workingDirectory,
      allowedPaths: input.allowedPaths,
      deniedPaths: input.deniedPaths
    }
  });

  const softLimitSource =
    input.maxUsd !== undefined && normalizedBudget.softLimitUsd !== DEFAULT_BUDGET.softLimitUsd
      ? "request"
      : "default";

  return {
    ...policy,
    budget: normalizedBudget,
    provenance: [
      ...policy.provenance.filter((entry) => entry.field !== "budget.softLimitUsd"),
      {
        field: "budget.softLimitUsd",
        source: softLimitSource,
        value: String(normalizedBudget.softLimitUsd)
      }
    ]
  };
}
