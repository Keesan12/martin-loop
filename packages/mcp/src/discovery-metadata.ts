import { createHash } from "node:crypto";

export const MARTIN_TOOL_NAMES = [
  "martin_run",
  "martin_inspect",
  "martin_status",
  "martin_doctor",
  "martin_plan",
  "martin_preflight",
  "martin_estimate",
  "martin_logs",
  "martin_pause",
  "martin_cancel",
  "martin_continue",
  "martin_list_runs",
  "martin_triage_runs",
  "martin_get_run",
  "martin_get_attempt",
  "martin_get_verification_results",
  "martin_run_dossier",
  "martin_dossier",
  "martin_eval",
  "martin_pr_summary",
  "martin_create_pr",
  "martin_review_pr"
] as const;

export const MARTIN_STARTER_TOOL_NAMES = [
  "martin_doctor",
  "martin_plan",
  "martin_preflight",
  "martin_estimate",
  "martin_run",
  "martin_triage_runs",
  "martin_dossier"
] as const;

export const MARTIN_MINIMAL_TOOL_NAMES = [
  "martin_doctor",
  "martin_plan",
  "martin_preflight",
  "martin_estimate",
  "martin_list_runs",
  "martin_triage_runs",
  "martin_dossier"
] as const;

export const MARTIN_DIAGNOSTIC_TOOL_NAMES = [
  "martin_doctor",
  "martin_plan",
  "martin_preflight",
  "martin_estimate",
  "martin_logs",
  "martin_list_runs",
  "martin_triage_runs",
  "martin_get_run",
  "martin_get_attempt",
  "martin_get_verification_results",
  "martin_dossier",
  "martin_eval"
] as const;

export const MARTIN_GITHUB_REVIEW_TOOL_NAMES = [
  "martin_doctor",
  "martin_plan",
  "martin_preflight",
  "martin_dossier",
  "martin_eval",
  "martin_pr_summary",
  "martin_create_pr",
  "martin_review_pr"
] as const;

export const MARTIN_PAID_REMOTE_TOOL_NAMES = [
  "martin_doctor",
  "martin_plan",
  "martin_preflight",
  "martin_estimate",
  "martin_run",
  "martin_list_runs",
  "martin_triage_runs",
  "martin_get_run",
  "martin_get_verification_results",
  "martin_dossier",
  "martin_eval"
] as const;

export const MARTIN_RESOURCE_URIS = [
  "martin://server/health",
  "martin://runs/recent",
  "martin://runs/triage",
  "martin://runs/latest",
  "martin://runs/latest/summary",
  "martin://runs/latest/receipt",
  "martin://runs/latest/proof-card",
  "martin://runs/latest/budget-status",
  "martin://runs/latest/verifier-evidence",
  "martin://runs/latest/rollback-evidence",
  "martin://policies/current",
  "martin://repo/risk-map",
  "martin://verifiers/results",
  "martin://agent/next-step",
  "martin://agent/governance-status",
  "martin://agent/memory-summary",
  "martin://guides/mcp-usage",
  "martin://guides/agent-start",
  "martin://guides/command-map",
  "martin://guides/ide-onboarding",
  "martin://guides/operating-rules",
  "martin://guides/publish-readiness"
] as const;

export const MARTIN_RESOURCE_TEMPLATE_URIS = [
  "martin://runs/{loopId}",
  "martin://runs/{loopId}/dossier",
  "martin://runs/{loopId}/attempts/{attemptIndex}",
  "martin://runs/{loopId}/verification"
] as const;

export const MARTIN_PROMPT_NAMES = [
  "martin_start",
  "martin_preflight",
  "martin_triage",
  "martin_resume",
  "martin_prove",
  "martin_release_check",
  "martin_governed_coding_kickoff",
  "martin_debug_failed_run",
  "martin_publish_readiness_review",
  "martin_triage_run_store",
  "safe_bug_fix",
  "write_tests_first",
  "small_refactor",
  "security_review",
  "pr_review",
  "release_check"
] as const;

export interface MartinDiscoveryMetadata {
  serverVersion: string;
  discoveryRevision: string;
  generatedAt: string;
  toolCount: number;
  resourceCount: number;
  resourceTemplateCount: number;
  promptCount: number;
  starterTools: string[];
  profiles: Record<string, string[]>;
}

export function buildMartinDiscoveryMetadata(serverVersion: string): MartinDiscoveryMetadata {
  const surface = {
    tools: [...MARTIN_TOOL_NAMES],
    resources: [...MARTIN_RESOURCE_URIS],
    resourceTemplates: [...MARTIN_RESOURCE_TEMPLATE_URIS],
    prompts: [...MARTIN_PROMPT_NAMES],
    starterTools: [...MARTIN_STARTER_TOOL_NAMES],
    profiles: {
      minimal: [...MARTIN_MINIMAL_TOOL_NAMES],
      diagnostic: [...MARTIN_DIAGNOSTIC_TOOL_NAMES],
      "github-review": [...MARTIN_GITHUB_REVIEW_TOOL_NAMES],
      "full-local": [...MARTIN_TOOL_NAMES],
      starter: [...MARTIN_STARTER_TOOL_NAMES],
      full: [...MARTIN_TOOL_NAMES]
    }
  };

  const discoveryRevision = createHash("sha256")
    .update(JSON.stringify({ serverVersion, surface }))
    .digest("hex")
    .slice(0, 12);

  return {
    serverVersion,
    discoveryRevision,
    generatedAt: new Date().toISOString(),
    toolCount: surface.tools.length,
    resourceCount: surface.resources.length,
    resourceTemplateCount: surface.resourceTemplates.length,
    promptCount: surface.prompts.length,
    starterTools: [...surface.starterTools],
    profiles: surface.profiles
  };
}
