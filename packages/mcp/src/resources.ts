import type {
  ReadResourceResult,
  Resource,
  ResourceTemplate
} from "@modelcontextprotocol/sdk/types.js";

import { buildMartinDiscoveryMetadata } from "./discovery-metadata.js";
import { MARTIN_MCP_PACKAGE_VERSION } from "./package-version.js";
import { inspectLoopTool } from "./tools/inspect-loop.js";
import { martinDoctorTool } from "./tools/doctor.js";
import { martinTriageRunsTool } from "./tools/triage-runs.js";
import {
  buildAttemptSnapshot,
  buildPersistedLoopPreview,
  buildVerificationHistorySnapshot,
  parseAttemptIndex,
  resolveMartinDiscoveryContext,
  toPrettyJson
} from "./discovery-support.js";
import { loadDetailedLoopRecord, readLedgerEvents } from "./tools/run-store.js";
import { invalidArgumentsError } from "./tools/tool-errors.js";

export const MARTIN_STATIC_RESOURCE_URIS = {
  serverHealth: "martin://server/health",
  recentRuns: "martin://runs/recent",
  triage: "martin://runs/triage",
  mcpUsageGuide: "martin://guides/mcp-usage",
  publishReadinessGuide: "martin://guides/publish-readiness"
} as const;

export const MARTIN_RESOURCE_TEMPLATES: ResourceTemplate[] = [
  {
    name: "martin_run_record",
    title: "Martin Run Record",
    uriTemplate: "martin://runs/{loopId}",
    description: "Read a canonical Martin loop record using the same selector path as martin_status."
  },
  {
    name: "martin_run_attempt",
    title: "Martin Run Attempt",
    uriTemplate: "martin://runs/{loopId}/attempts/{attemptIndex}",
    description: "Inspect a specific persisted Martin attempt and its linked verification event."
  },
  {
    name: "martin_run_verification",
    title: "Martin Run Verification History",
    uriTemplate: "martin://runs/{loopId}/verification",
    description: "Inspect verification.completed events for a persisted Martin loop."
  }
];

export const MARTIN_STATIC_RESOURCES: Resource[] = [
  {
    uri: MARTIN_STATIC_RESOURCE_URIS.serverHealth,
    name: "martin_server_health",
    title: "Martin Server Health",
    description: "Health and environment readiness for the Martin MCP server.",
    mimeType: "application/json"
  },
  {
    uri: MARTIN_STATIC_RESOURCE_URIS.recentRuns,
    name: "martin_recent_runs",
    title: "Martin Recent Runs",
    description: "Recent Martin loop previews derived from the current runs root.",
    mimeType: "application/json"
  },
  {
    uri: MARTIN_STATIC_RESOURCE_URIS.triage,
    name: "martin_run_triage",
    title: "Martin Run Triage",
    description: "Priority-ranked Martin runs that likely need attention.",
    mimeType: "application/json"
  },
  {
    uri: MARTIN_STATIC_RESOURCE_URIS.mcpUsageGuide,
    name: "martin_mcp_usage_guide",
    title: "Martin MCP Usage Guide",
    description: "Recommended workflow for using Martin Loop over MCP.",
    mimeType: "text/markdown"
  },
  {
    uri: MARTIN_STATIC_RESOURCE_URIS.publishReadinessGuide,
    name: "martin_publish_readiness_guide",
    title: "Martin Publish Readiness Guide",
    description: "Checklist-oriented guide for MCP publish readiness reviews.",
    mimeType: "text/markdown"
  }
];

export interface MartinReadResourceInput {
  uri: string;
  runsDir?: string;
  workingDirectory?: string;
  engine?: "claude" | "codex";
}

export function listMartinResources(): { resources: Resource[] } {
  return {
    resources: MARTIN_STATIC_RESOURCES.map((resource) => ({ ...resource }))
  };
}

export function listMartinResourceTemplates(): {
  resourceTemplates: ResourceTemplate[];
} {
  return {
    resourceTemplates: MARTIN_RESOURCE_TEMPLATES.map((template) => ({ ...template }))
  };
}

export async function readMartinResource(
  input: MartinReadResourceInput
): Promise<ReadResourceResult> {
  const context = resolveMartinDiscoveryContext(input);

  switch (input.uri) {
    case MARTIN_STATIC_RESOURCE_URIS.serverHealth: {
      const health = await martinDoctorTool({
        runsDir: context.runsRoot,
        workingDirectory: context.workingDirectory,
        ...(context.engine ? { engine: context.engine } : {})
      });
      return jsonResource(input.uri, withDiscoveryMetadata(health, context.runsRoot));
    }

    case MARTIN_STATIC_RESOURCE_URIS.recentRuns: {
      const recentRuns = await inspectLoopTool({ runsDir: context.runsRoot });
      return jsonResource(input.uri, withDiscoveryMetadata(recentRuns, context.runsRoot));
    }

    case MARTIN_STATIC_RESOURCE_URIS.triage: {
      const triage = await martinTriageRunsTool({ runsDir: context.runsRoot });
      return jsonResource(input.uri, withDiscoveryMetadata(triage, context.runsRoot));
    }

    case MARTIN_STATIC_RESOURCE_URIS.mcpUsageGuide:
      return textResource(input.uri, "text/markdown", buildMcpUsageGuide(context.runsRoot));

    case MARTIN_STATIC_RESOURCE_URIS.publishReadinessGuide:
      return textResource(input.uri, "text/markdown", buildPublishReadinessGuide(context.runsRoot));

    default:
      return readDynamicMartinResource({
        uri: input.uri,
        runsDir: context.runsRoot
      });
  }
}

function textResource(
  uri: string,
  mimeType: string,
  text: string
): ReadResourceResult {
  return {
    contents: [
      {
        uri,
        mimeType,
        text
      }
    ]
  };
}

function jsonResource(uri: string, value: unknown): ReadResourceResult {
  return textResource(uri, "application/json", toPrettyJson(value));
}

async function readDynamicMartinResource(input: {
  uri: string;
  runsDir: string;
}): Promise<ReadResourceResult> {
  const runMatch = /^martin:\/\/runs\/([^/]+)$/u.exec(input.uri);
  if (runMatch?.[1]) {
    const loopId = decodeURIComponent(runMatch[1]);
    const detail = await loadDetailedLoopRecord({ loopId, runsDir: input.runsDir });
    const ledgerEvents = await readLedgerEvents(detail);
    const loop = detail.loop as Parameters<typeof buildPersistedLoopPreview>[0];
    const verification = buildVerificationHistorySnapshot(loop, ledgerEvents);

    return jsonResource(input.uri, withDiscoveryMetadata({
      source: detail.source,
      loop: buildPersistedLoopPreview(loop),
      task: loop.task,
      budget: loop.budget,
      cost: loop.cost,
      attempts: loop.attempts,
      verification,
      warnings: [...detail.warnings, ...verification.warnings]
    }, input.runsDir));
  }

  const attemptMatch = /^martin:\/\/runs\/([^/]+)\/attempts\/([^/]+)$/u.exec(input.uri);
  if (attemptMatch?.[1] && attemptMatch[2]) {
    const loopId = decodeURIComponent(attemptMatch[1]);
    const attemptIndex = parseAttemptIndex(decodeURIComponent(attemptMatch[2]));
    const detail = await loadDetailedLoopRecord({ loopId, runsDir: input.runsDir });
    const ledgerEvents = await readLedgerEvents(detail);
    const loop = detail.loop as Parameters<typeof buildAttemptSnapshot>[0];
    const attempt = buildAttemptSnapshot(loop, attemptIndex, ledgerEvents);

    return jsonResource(
      input.uri,
      withDiscoveryMetadata({
        ...attempt,
        warnings: [...detail.warnings, ...attempt.warnings]
      }, input.runsDir)
    );
  }

  const verificationMatch = /^martin:\/\/runs\/([^/]+)\/verification$/u.exec(input.uri);
  if (verificationMatch?.[1]) {
    const loopId = decodeURIComponent(verificationMatch[1]);
    const detail = await loadDetailedLoopRecord({ loopId, runsDir: input.runsDir });
    const ledgerEvents = await readLedgerEvents(detail);
    const loop = detail.loop as Parameters<typeof buildVerificationHistorySnapshot>[0];
    const verification = buildVerificationHistorySnapshot(loop, ledgerEvents);

    return jsonResource(
      input.uri,
      withDiscoveryMetadata({
        ...verification,
        warnings: [...detail.warnings, ...verification.warnings]
      }, input.runsDir)
    );
  }

  throw invalidArgumentsError(
    `Unknown resource URI '${input.uri}'.`,
    "Use resources/list or resources/templates/list to discover Martin resource URIs."
  );
}

function buildMcpUsageGuide(runsRoot: string): string {
  const metadata = buildMartinDiscoveryMetadata(MARTIN_MCP_PACKAGE_VERSION);
  return `# Martin Loop MCP Usage

Discovery revision: \`${metadata.discoveryRevision}\`
Server version: \`${metadata.serverVersion}\`
Runs root: \`${runsRoot}\`

Martin Loop exposes governed coding workflows over MCP. Use the server health and run-store views to decide when to preflight, execute, inspect, or escalate.

## Recommended Flow

1. Read \`${MARTIN_STATIC_RESOURCE_URIS.serverHealth}\` or call \`martin_doctor\` to confirm the environment and run-store visibility.
2. Use the \`martin_governed_coding_kickoff\` prompt to frame a governed coding request.
3. Call \`martin_preflight\` before \`martin_run\` when the task or safety envelope is non-trivial.
4. After execution, inspect \`${MARTIN_STATIC_RESOURCE_URIS.recentRuns}\`, \`martin://runs/{loopId}\`, and \`martin://runs/{loopId}/verification\`.
5. Read \`${MARTIN_STATIC_RESOURCE_URIS.triage}\` or call \`martin_triage_runs\` to prioritize which run needs attention first.
6. Use \`martin_debug_failed_run\` when a loop exits failed, budget-bound, or escalated.

## Current Martin MCP Surface

- Tools: \`martin_run\`, \`martin_inspect\`, \`martin_status\`, \`martin_doctor\`, \`martin_preflight\`, \`martin_list_runs\`, \`martin_triage_runs\`, \`martin_get_run\`, \`martin_get_attempt\`, \`martin_get_verification_results\`, \`martin_run_dossier\`
- Static resources: \`${MARTIN_STATIC_RESOURCE_URIS.serverHealth}\`, \`${MARTIN_STATIC_RESOURCE_URIS.recentRuns}\`, \`${MARTIN_STATIC_RESOURCE_URIS.triage}\`, \`${MARTIN_STATIC_RESOURCE_URIS.mcpUsageGuide}\`, \`${MARTIN_STATIC_RESOURCE_URIS.publishReadinessGuide}\`
- Resource templates: \`martin://runs/{loopId}\`, \`martin://runs/{loopId}/attempts/{attemptIndex}\`, \`martin://runs/{loopId}/verification\`
- Prompts: \`martin_governed_coding_kickoff\`, \`martin_debug_failed_run\`, \`martin_publish_readiness_review\`, \`martin_triage_run_store\`

## Notes

- Discovery helpers read the existing Martin run-store; they do not create new schema.
- Verification history is derived from persisted \`verification.completed\` evidence in loop records and ledgers.
- Attempt inspection stays aligned with the same loop selectors used by \`martin_status\` and \`martin_inspect\`.
`;
}

function buildPublishReadinessGuide(runsRoot: string): string {
  const metadata = buildMartinDiscoveryMetadata(MARTIN_MCP_PACKAGE_VERSION);
  return `# Martin MCP Publish Readiness

Discovery revision: \`${metadata.discoveryRevision}\`
Server version: \`${metadata.serverVersion}\`
Runs root: \`${runsRoot}\`

Use this guide when reviewing whether the public MCP package is ready to publish, promote, or hand off for registry submission.

## Review Areas

1. Environment health: confirm \`${MARTIN_STATIC_RESOURCE_URIS.serverHealth}\` shows a sane working directory, runs root, and engine availability for the target mode.
2. Discovery surface: verify tools, prompts, static resources, and resource templates are all discoverable and named consistently.
3. Run evidence: inspect \`${MARTIN_STATIC_RESOURCE_URIS.recentRuns}\` and, when relevant, \`martin://runs/{loopId}/verification\` to confirm verification outcomes are explainable from persisted data.
4. Packaging lane: run the MCP package test, build, and smoke-pack commands before calling the package publish-ready.
5. Findings-first reporting: call out missing schema, integration gaps, triage-critical runs, and verification blockers before summarizing strengths.

## Evidence Expectations

- Prefer concrete run IDs, attempt indices, and verification summaries over vague statements.
- Distinguish local package validation from live registry readiness.
- If a discovery helper exists but is not yet wired into the server, report that as an integration gap instead of treating the capability as fully shipped.
`;
}

function withDiscoveryMetadata(value: unknown, runsRoot?: string): Record<string, unknown> {
  return {
    metadata: {
      ...buildMartinDiscoveryMetadata(MARTIN_MCP_PACKAGE_VERSION),
      ...(runsRoot ? { runsRoot } : {})
    },
    value
  };
}
