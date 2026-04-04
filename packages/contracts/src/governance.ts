export type GovernanceSnapshot = {
  policyProfile: "strict" | "balanced" | "overnight" | "debug";
  maxUsd: number;
  softLimitUsd: number;
  maxTokens: number;
  maxIterations: number;
  allowedAdapters: string[];
  allowedModels: string[];
  destructiveActionPolicy: "never" | "approval" | "allowed";
  approvalRequired: boolean;
  verifierRules: string[];
  escalationRoute: string;
  telemetryDestination: "local-only" | "control-plane";
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
