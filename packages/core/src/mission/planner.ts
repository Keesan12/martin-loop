import type { MissionBudgetInput } from "./supervisor.js";

export interface MissionPlanWorkItem {
  id: string;
  title: string;
  dependsOn: readonly string[];
  maxAttempts: number;
}

export interface MissionProviderPolicy {
  primary: string;
  fallback?: string;
  allowFallback: boolean;
}

export interface MissionPlan {
  objective: string;
  sourceSha: string;
  workspace: { workspaceId: string; identityHash: string };
  context: { manifestHash: string; tokenCount: number; compactAtTokens: number };
  memory: { ledgerHeadHash: string | null; snapshotHash: string | null };
  budget: MissionBudgetInput;
  workItems: readonly MissionPlanWorkItem[];
  providerPolicy?: MissionProviderPolicy;
  writerId: string;
  now?: string;
}
