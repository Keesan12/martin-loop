// SPDX-FileCopyrightText: MartinLoop contributors
//
// SPDX-License-Identifier: Apache-2.0

export type PolicyProfile = "strict" | "balanced" | "overnight" | "debug";
export type DestructiveActionPolicy = "never" | "approval" | "allowed";
export type TelemetryDestination = "local-only" | "control-plane";

export type GovernanceSnapshot = {
  policyProfile: PolicyProfile;
  maxUsd: number;
  softLimitUsd: number;
  maxTokens: number;
  maxIterations: number;
  allowedAdapters: string[];
  allowedModels: string[];
  destructiveActionPolicy: DestructiveActionPolicy;
  approvalRequired: boolean;
  verifierRules: string[];
  escalationRoute: string;
  telemetryDestination: TelemetryDestination;
  retentionPolicy: string;
  provenance: Array<{ field: string; value: string; source: string }>;
};

export function createGovernanceSnapshot(snapshot: GovernanceSnapshot): GovernanceSnapshot {
  return {
    ...snapshot,
    allowedAdapters: [...snapshot.allowedAdapters],
    allowedModels: [...snapshot.allowedModels],
    verifierRules: [...snapshot.verifierRules],
    provenance: snapshot.provenance.map((entry) => ({
      ...entry
    }))
  };
}
