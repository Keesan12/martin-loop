// SPDX-FileCopyrightText: MartinLoop contributors
//
// SPDX-License-Identifier: Apache-2.0

import {
  cloneExecutionPolicy,
  type DestructiveActionPolicy,
  type ExecutionPolicy,
  type ExecutionPolicyCompileInput,
  type PolicyProfile,
  type TelemetryDestination
} from "@martin/contracts";

export function compileExecutionPolicy(input: ExecutionPolicyCompileInput): ExecutionPolicy {
  const provenance: ExecutionPolicy["provenance"] = [];

  const budget = {
    maxUsd: resolveBudgetField("maxUsd", input, provenance),
    softLimitUsd: resolveBudgetField("softLimitUsd", input, provenance),
    maxIterations: resolveBudgetField("maxIterations", input, provenance),
    maxTokens: resolveBudgetField("maxTokens", input, provenance)
  };

  if (budget.softLimitUsd >= budget.maxUsd) {
    budget.softLimitUsd = Math.round(budget.maxUsd * 0.75 * 100) / 100;
    provenance.push({
      field: "budget.softLimitUsd",
      source: "config",
      value: String(budget.softLimitUsd)
    });
  }

  const governance = {
    policyProfile: resolveEnumField<PolicyProfile>({
      field: "governance.policyProfile",
      defaultsTo: input.defaults.policyProfile,
      configValue: input.config?.policyProfile,
      requestValue: input.request.policyProfile,
      allowed: ["strict", "balanced", "overnight", "debug"],
      provenance
    }),
    telemetryDestination: resolveEnumField<TelemetryDestination>({
      field: "governance.telemetryDestination",
      defaultsTo: input.defaults.telemetryDestination,
      configValue: input.config?.governance?.telemetryDestination,
      requestValue: input.request.telemetryDestination,
      allowed: ["local-only", "control-plane"],
      provenance
    }),
    destructiveActionPolicy: resolveEnumField<DestructiveActionPolicy>({
      field: "governance.destructiveActionPolicy",
      defaultsTo: input.defaults.destructiveActionPolicy,
      configValue: input.config?.governance?.destructiveActionPolicy,
      allowed: ["never", "approval", "allowed"],
      provenance
    })
  };

  const verificationPlan = resolveVerificationPlan(input, provenance);
  const task: ExecutionPolicy["task"] = {
    verificationPlan
  };

  if (input.request.mutationMode) {
    task.mutationMode = input.request.mutationMode;
    provenance.push({
      field: "task.mutationMode",
      source: "request",
      value: input.request.mutationMode
    });
  }
  if (input.request.repoRoot) {
    task.repoRoot = input.request.repoRoot;
    provenance.push({
      field: "task.repoRoot",
      source: "request",
      value: input.request.repoRoot
    });
  }
  if ((input.request.allowedPaths?.length ?? 0) > 0) {
    const allowedPaths = input.request.allowedPaths ?? [];
    task.allowedPaths = [...allowedPaths];
    provenance.push({
      field: "task.allowedPaths",
      source: "request",
      value: allowedPaths.join(", ")
    });
  }
  if ((input.request.deniedPaths?.length ?? 0) > 0) {
    const deniedPaths = input.request.deniedPaths ?? [];
    task.deniedPaths = [...deniedPaths];
    provenance.push({
      field: "task.deniedPaths",
      source: "request",
      value: deniedPaths.join(", ")
    });
  }
  if ((input.request.acceptanceCriteria?.length ?? 0) > 0) {
    const acceptanceCriteria = input.request.acceptanceCriteria ?? [];
    task.acceptanceCriteria = [...acceptanceCriteria];
    provenance.push({
      field: "task.acceptanceCriteria",
      source: "request",
      value: acceptanceCriteria.join(", ")
    });
  }
  if (input.request.approvalPolicy) {
    task.approvalPolicy = { ...input.request.approvalPolicy };
    provenance.push({
      field: "task.approvalPolicy",
      source: "request",
      value: JSON.stringify(input.request.approvalPolicy)
    });
  }

  return cloneExecutionPolicy({
    configPath: input.configPath,
    budget,
    governance,
    task,
    provenance
  });
}

function resolveBudgetField(
  field: keyof ExecutionPolicy["budget"],
  input: ExecutionPolicyCompileInput,
  provenance: ExecutionPolicy["provenance"]
): number {
  if (input.request.budgetOverrides?.[field]) {
    const value = input.request.budget[field];
    provenance.push({
      field: `budget.${String(field)}`,
      source: "request",
      value: String(value)
    });
    return value;
  }

  const configValue = input.config?.budget?.[field];
  if (typeof configValue === "number" && Number.isFinite(configValue)) {
    provenance.push({
      field: `budget.${String(field)}`,
      source: "config",
      value: String(configValue)
    });
    return configValue;
  }

  const value = input.defaults.budget[field];
  provenance.push({
    field: `budget.${String(field)}`,
    source: "default",
    value: String(value)
  });
  return value;
}

function resolveVerificationPlan(
  input: ExecutionPolicyCompileInput,
  provenance: ExecutionPolicy["provenance"]
): string[] {
  const requestVerificationPlan = normalizeStringList(input.request.verificationPlan);
  if (requestVerificationPlan.length > 0) {
    provenance.push({
      field: "task.verificationPlan",
      source: "request",
      value: requestVerificationPlan.join(", ")
    });
    return requestVerificationPlan;
  }

  const configVerificationPlan = normalizeStringList(input.config?.governance?.verifierRules);
  if (configVerificationPlan.length > 0) {
    provenance.push({
      field: "task.verificationPlan",
      source: "config",
      value: configVerificationPlan.join(", ")
    });
    return configVerificationPlan;
  }

  const defaultVerificationPlan = normalizeStringList(input.defaults.verifierRules);
  provenance.push({
    field: "task.verificationPlan",
    source: "default",
    value: defaultVerificationPlan.join(", ")
  });
  return defaultVerificationPlan;
}

function resolveEnumField<T extends string>(input: {
  field: string;
  defaultsTo: T;
  configValue?: string;
  requestValue?: string;
  allowed: readonly T[];
  provenance: ExecutionPolicy["provenance"];
}): T {
  const normalizedRequest = normalizeEnumCandidate(input.requestValue, input.allowed);
  if (normalizedRequest) {
    input.provenance.push({
      field: input.field,
      source: "request",
      value: normalizedRequest
    });
    return normalizedRequest;
  }

  const normalizedConfig = normalizeEnumCandidate(input.configValue, input.allowed);
  if (normalizedConfig) {
    input.provenance.push({
      field: input.field,
      source: "config",
      value: normalizedConfig
    });
    return normalizedConfig;
  }

  input.provenance.push({
    field: input.field,
    source: "default",
    value: input.defaultsTo
  });
  return input.defaultsTo;
}

function normalizeEnumCandidate<T extends string>(
  value: string | undefined,
  allowed: readonly T[]
): T | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  return allowed.find((candidate) => candidate === trimmed);
}

function normalizeStringList(values: string[] | undefined): string[] {
  return (values ?? []).map((value) => value.trim()).filter(Boolean);
}
