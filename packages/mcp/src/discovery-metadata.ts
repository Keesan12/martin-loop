import { createHash } from "node:crypto";

export const MARTIN_TOOL_NAMES = [
  "martin_run",
  "martin_inspect",
  "martin_status",
  "martin_doctor",
  "martin_preflight",
  "martin_list_runs",
  "martin_triage_runs",
  "martin_get_run",
  "martin_get_attempt",
  "martin_get_verification_results",
  "martin_run_dossier"
] as const;

export const MARTIN_STARTER_TOOL_NAMES = [
  "martin_doctor",
  "martin_preflight",
  "martin_run",
  "martin_triage_runs",
  "martin_run_dossier"
] as const;

export const MARTIN_RESOURCE_URIS = [
  "martin://server/health",
  "martin://runs/recent",
  "martin://runs/triage",
  "martin://guides/mcp-usage",
  "martin://guides/publish-readiness"
] as const;

export const MARTIN_RESOURCE_TEMPLATE_URIS = [
  "martin://runs/{loopId}",
  "martin://runs/{loopId}/attempts/{attemptIndex}",
  "martin://runs/{loopId}/verification"
] as const;

export const MARTIN_PROMPT_NAMES = [
  "martin_governed_coding_kickoff",
  "martin_debug_failed_run",
  "martin_publish_readiness_review",
  "martin_triage_run_store"
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
}

export function buildMartinDiscoveryMetadata(serverVersion: string): MartinDiscoveryMetadata {
  const surface = {
    tools: [...MARTIN_TOOL_NAMES],
    resources: [...MARTIN_RESOURCE_URIS],
    resourceTemplates: [...MARTIN_RESOURCE_TEMPLATE_URIS],
    prompts: [...MARTIN_PROMPT_NAMES],
    starterTools: [...MARTIN_STARTER_TOOL_NAMES]
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
    starterTools: [...surface.starterTools]
  };
}
