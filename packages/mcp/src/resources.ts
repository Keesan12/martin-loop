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
import { martinRunDossierTool } from "./tools/run-dossier.js";
import { inspectRepoSignals, buildPolicyPackDefinition, buildRepoRiskMap } from "./tools/workflow-governance.js";
import { readWorkflowState } from "./workflow-state.js";
import { readMemoryEntries, buildMemorySummary } from "@martin/core";
import {
  buildAttemptSnapshot,
  buildPersistedLoopPreview,
  buildVerificationHistorySnapshot,
  parseAttemptIndex,
  resolveMartinDiscoveryContext,
  toPrettyJson
} from "./discovery-support.js";
import { loadDetailedLoopRecord, readLedgerEvents } from "./tools/run-store.js";
import { invalidArgumentsError, MartinToolError } from "./tools/tool-errors.js";
import type { MartinEngine } from "./tools/tool-support.js";

export const MARTIN_STATIC_RESOURCE_URIS = {
  serverHealth: "martin://server/health",
  recentRuns: "martin://runs/recent",
  triage: "martin://runs/triage",
  latestRun: "martin://runs/latest",
  latestSummary: "martin://runs/latest/summary",
  latestProofCard: "martin://runs/latest/proof-card",
  latestBudgetStatus: "martin://runs/latest/budget-status",
  latestVerifierEvidence: "martin://runs/latest/verifier-evidence",
  latestRollbackEvidence: "martin://runs/latest/rollback-evidence",
  currentPolicies: "martin://policies/current",
  repoRiskMap: "martin://repo/risk-map",
  verifierResults: "martin://verifiers/results",
  agentNextStep: "martin://agent/next-step",
  mcpUsageGuide: "martin://guides/mcp-usage",
  agentStartGuide: "martin://guides/agent-start",
  commandMapGuide: "martin://guides/command-map",
  ideOnboardingGuide: "martin://guides/ide-onboarding",
  operatingRulesGuide: "martin://guides/operating-rules",
  publishReadinessGuide: "martin://guides/publish-readiness",
  governanceStatus: "martin://agent/governance-status",
  memorySummary: "martin://agent/memory-summary"
} as const;

export const MARTIN_RESOURCE_TEMPLATES: ResourceTemplate[] = [
  {
    name: "martin_run_record",
    title: "Martin Run Record",
    uriTemplate: "martin://runs/{loopId}",
    description: "Read a canonical Martin loop record using the same selector path as martin_status."
  },
  {
    name: "martin_run_dossier_resource",
    title: "Martin Run Dossier",
    uriTemplate: "martin://runs/{loopId}/dossier",
    description: "Read the dossier-shaped summary for a persisted Martin loop."
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
    uri: MARTIN_STATIC_RESOURCE_URIS.latestRun,
    name: "martin_latest_run",
    title: "Martin Latest Run",
    description: "Full latest-run dossier surface for agents that need more than the compact summary.",
    mimeType: "application/json"
  },
  {
    uri: MARTIN_STATIC_RESOURCE_URIS.latestSummary,
    name: "martin_latest_summary",
    title: "Martin Latest Summary",
    description: "Compact latest-run summary for context-constrained agents.",
    mimeType: "application/json"
  },
  {
    uri: MARTIN_STATIC_RESOURCE_URIS.latestProofCard,
    name: "martin_latest_proof_card",
    title: "Martin Latest Proof Card",
    description: "Small Markdown receipt showing what happened, what Martin prevented, and the next safe action.",
    mimeType: "text/markdown"
  },
  {
    uri: MARTIN_STATIC_RESOURCE_URIS.latestBudgetStatus,
    name: "martin_latest_budget_status",
    title: "Martin Latest Budget Status",
    description: "Compact budget, token, and stop-condition snapshot for the latest run.",
    mimeType: "application/json"
  },
  {
    uri: MARTIN_STATIC_RESOURCE_URIS.latestVerifierEvidence,
    name: "martin_latest_verifier_evidence",
    title: "Martin Latest Verifier Evidence",
    description: "Compact verifier evidence and warnings for the latest run.",
    mimeType: "application/json"
  },
  {
    uri: MARTIN_STATIC_RESOURCE_URIS.latestRollbackEvidence,
    name: "martin_latest_rollback_evidence",
    title: "Martin Latest Rollback Evidence",
    description: "Compact rollback and artifact evidence for the latest run.",
    mimeType: "application/json"
  },
  {
    uri: MARTIN_STATIC_RESOURCE_URIS.currentPolicies,
    name: "martin_current_policies",
    title: "Martin Current Policies",
    description: "Local policy-pack presets and the recommended default pack for the current repo.",
    mimeType: "application/json"
  },
  {
    uri: MARTIN_STATIC_RESOURCE_URIS.repoRiskMap,
    name: "martin_repo_risk_map",
    title: "Martin Repo Risk Map",
    description: "Sensitive repo surfaces and the recommended policy pack for this workspace.",
    mimeType: "application/json"
  },
  {
    uri: MARTIN_STATIC_RESOURCE_URIS.verifierResults,
    name: "martin_latest_verifier_results",
    title: "Martin Latest Verifier Results",
    description: "Latest verifier results alias for compact run evidence.",
    mimeType: "application/json"
  },
  {
    uri: MARTIN_STATIC_RESOURCE_URIS.agentNextStep,
    name: "martin_agent_next_step",
    title: "Martin Agent Next Step",
    description: "Single next recommended Martin tool, prompt, or resource for a context-constrained agent.",
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
    uri: MARTIN_STATIC_RESOURCE_URIS.agentStartGuide,
    name: "martin_agent_start_guide",
    title: "Martin Agent Start Guide",
    description: "Short agent-facing guide for using Martin with minimal context and low tool bloat.",
    mimeType: "text/markdown"
  },
  {
    uri: MARTIN_STATIC_RESOURCE_URIS.commandMapGuide,
    name: "martin_command_map_guide",
    title: "Martin Command Map Guide",
    description: "Command-by-command guide for choosing the right Martin tool or surface.",
    mimeType: "text/markdown"
  },
  {
    uri: MARTIN_STATIC_RESOURCE_URIS.ideOnboardingGuide,
    name: "martin_ide_onboarding_guide",
    title: "Martin IDE Onboarding Guide",
    description: "IDE-facing setup guide for making MartinLoop part of the default MCP workflow.",
    mimeType: "text/markdown"
  },
  {
    uri: MARTIN_STATIC_RESOURCE_URIS.operatingRulesGuide,
    name: "martin_operating_rules_guide",
    title: "Martin Operating Rules",
    description: "Built-in operating rules that tell agents when Martin commands must be used before work proceeds.",
    mimeType: "text/markdown"
  },
  {
    uri: MARTIN_STATIC_RESOURCE_URIS.publishReadinessGuide,
    name: "martin_publish_readiness_guide",
    title: "Martin Publish Readiness Guide",
    description: "Checklist-oriented guide for MCP publish readiness reviews.",
    mimeType: "text/markdown"
  },
  {
    uri: MARTIN_STATIC_RESOURCE_URIS.governanceStatus,
    name: "martin_governance_status",
    title: "Martin Governance Status",
    description: "Proactive governance status: whether work is governed, budget remaining, unreceipted runs, and recommended next action. Read this before starting agent work.",
    mimeType: "application/json"
  },
  {
    uri: MARTIN_STATIC_RESOURCE_URIS.memorySummary,
    name: "martin_memory_summary",
    title: "Martin Memory Summary",
    description: "MartinLoop persistent memory: user preferences, consent signals, budget patterns, and behavioral observations aggregated over time. Read at session start to personalize recommendations.",
    mimeType: "application/json"
  }
];

export interface MartinReadResourceInput {
  uri: string;
  runsDir?: string;
  workingDirectory?: string;
  engine?: MartinEngine;
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

    case MARTIN_STATIC_RESOURCE_URIS.latestRun:
      return jsonResource(
        input.uri,
        withDiscoveryMetadata(
          await martinRunDossierTool({ latest: true, runsDir: context.runsRoot }),
          context.runsRoot
        )
      );

    case MARTIN_STATIC_RESOURCE_URIS.latestSummary:
      return jsonResource(input.uri, withDiscoveryMetadata(await buildLatestSummaryResource(context.runsRoot), context.runsRoot));

    case MARTIN_STATIC_RESOURCE_URIS.latestProofCard:
      return textResource(input.uri, "text/markdown", await buildLatestProofCardResource(context.runsRoot));

    case MARTIN_STATIC_RESOURCE_URIS.latestBudgetStatus:
      return jsonResource(input.uri, withDiscoveryMetadata(await buildLatestBudgetStatusResource(context.runsRoot), context.runsRoot));

    case MARTIN_STATIC_RESOURCE_URIS.latestVerifierEvidence:
      return jsonResource(input.uri, withDiscoveryMetadata(await buildLatestVerifierEvidenceResource(context.runsRoot), context.runsRoot));

    case MARTIN_STATIC_RESOURCE_URIS.latestRollbackEvidence:
      return jsonResource(input.uri, withDiscoveryMetadata(await buildLatestRollbackEvidenceResource(context.runsRoot), context.runsRoot));

    case MARTIN_STATIC_RESOURCE_URIS.currentPolicies:
      return jsonResource(input.uri, withDiscoveryMetadata(buildCurrentPoliciesResource(context.workingDirectory), context.runsRoot));

    case MARTIN_STATIC_RESOURCE_URIS.repoRiskMap:
      return jsonResource(input.uri, withDiscoveryMetadata(buildRepoRiskMap(inspectRepoSignals(context.workingDirectory)), context.runsRoot));

    case MARTIN_STATIC_RESOURCE_URIS.verifierResults:
      return jsonResource(input.uri, withDiscoveryMetadata(await buildLatestVerifierEvidenceResource(context.runsRoot), context.runsRoot));

    case MARTIN_STATIC_RESOURCE_URIS.memorySummary: {
      const entries = await readMemoryEntries(context.runsRoot);
      const summary = buildMemorySummary(entries);
      return jsonResource(input.uri, withDiscoveryMetadata(summary, context.runsRoot));
    }

    case MARTIN_STATIC_RESOURCE_URIS.governanceStatus:
      return jsonResource(input.uri, withDiscoveryMetadata(await buildGovernanceStatusResource(context.runsRoot, context.workingDirectory), context.runsRoot));

    case MARTIN_STATIC_RESOURCE_URIS.agentNextStep:
      return jsonResource(input.uri, withDiscoveryMetadata(await buildAgentNextStepResource(context.runsRoot), context.runsRoot));

    case MARTIN_STATIC_RESOURCE_URIS.mcpUsageGuide:
      return textResource(input.uri, "text/markdown", buildMcpUsageGuide(context.runsRoot));

    case MARTIN_STATIC_RESOURCE_URIS.agentStartGuide:
      return textResource(input.uri, "text/markdown", buildAgentStartGuide(context.runsRoot));

    case MARTIN_STATIC_RESOURCE_URIS.commandMapGuide:
      return textResource(input.uri, "text/markdown", buildCommandMapGuide(context.runsRoot));

    case MARTIN_STATIC_RESOURCE_URIS.ideOnboardingGuide:
      return textResource(input.uri, "text/markdown", buildIdeOnboardingGuide(context.runsRoot));

    case MARTIN_STATIC_RESOURCE_URIS.operatingRulesGuide:
      return textResource(input.uri, "text/markdown", buildOperatingRulesGuide(context.runsRoot));

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

  const dossierMatch = /^martin:\/\/runs\/([^/]+)\/dossier$/u.exec(input.uri);
  if (dossierMatch?.[1]) {
    const loopId = decodeURIComponent(dossierMatch[1]);
    const dossier = await martinRunDossierTool({ loopId, runsDir: input.runsDir });
    return jsonResource(input.uri, withDiscoveryMetadata(dossier, input.runsDir));
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

async function loadLatestRunForCompactResource(runsRoot: string): Promise<{
  empty: boolean;
  detail?: Awaited<ReturnType<typeof loadDetailedLoopRecord>>;
  warnings: string[];
}> {
  try {
    return {
      empty: false,
      detail: await loadDetailedLoopRecord({ latest: true, runsDir: runsRoot }),
      warnings: []
    };
  } catch (error) {
    if (error instanceof MartinToolError && error.code === "no_loop_records") {
      return {
        empty: true,
        warnings: [
          "No Martin run records were found yet.",
          "Run `npx martin-loop demo`, then run `npx martin-loop run ... --proof --verify <command>` for a no-spend local proof pass."
        ]
      };
    }

    throw error;
  }
}

async function buildLatestSummaryResource(runsRoot: string): Promise<Record<string, unknown>> {
  const latest = await loadLatestRunForCompactResource(runsRoot);
  if (latest.empty || !latest.detail) {
    return compactEmptyState("latest-summary", runsRoot, latest.warnings);
  }

  const ledgerEvents = await readLedgerEvents(latest.detail);
  const loop = latest.detail.loop as Parameters<typeof buildPersistedLoopPreview>[0];
  const verification = buildVerificationHistorySnapshot(loop, ledgerEvents);
  const preview = buildPersistedLoopPreview(loop);
  const nextStep = inferAgentNextStep(loop, verification);

  return {
    kind: "latest-summary",
    loop: preview,
    task: {
      title: loop.task?.title,
      objective: loop.task?.objective,
      verificationPlan: loop.task?.verificationPlan ?? []
    },
    budget: loop.budget,
    cost: {
      actualUsd: loop.cost.actualUsd,
      avoidedUsdEstimate: loop.cost.avoidedUsd ?? 0,
      tokensIn: loop.cost.tokensIn,
      tokensOut: loop.cost.tokensOut,
      estimateLabel: "Cost and avoided-spend fields are local run estimates unless your adapter reported authoritative usage."
    },
    verification: {
      status: verification.latestVerification?.passed === true
        ? "passed"
        : verification.latestVerification?.passed === false
          ? "failed"
          : "unavailable",
      latest: verification.latestVerification,
      count: verification.verificationCount
    },
    whatMartinPrevented: describePrevention(loop),
    nextStep,
    warnings: [...latest.detail.warnings, ...verification.warnings]
  };
}

async function buildLatestBudgetStatusResource(runsRoot: string): Promise<Record<string, unknown>> {
  const latest = await loadLatestRunForCompactResource(runsRoot);
  if (latest.empty || !latest.detail) {
    return compactEmptyState("budget-status", runsRoot, latest.warnings);
  }

  const loop = latest.detail.loop as Parameters<typeof buildPersistedLoopPreview>[0];
  const preview = buildPersistedLoopPreview(loop);

  return {
    kind: "budget-status",
    loopId: loop.loopId,
    lifecycleState: loop.lifecycleState,
    shouldStop: preview.shouldStop,
    pressure: preview.pressure,
    budget: loop.budget,
    cost: {
      actualUsd: loop.cost.actualUsd,
      avoidedUsdEstimate: loop.cost.avoidedUsd ?? 0,
      tokensIn: loop.cost.tokensIn,
      tokensOut: loop.cost.tokensOut,
      estimateLabel: "Avoided USD and token fields are estimates unless backed by adapter usage receipts."
    },
    remaining: {
      budgetUsd: preview.remainingBudgetUsd,
      iterations: preview.remainingIterations,
      tokens: preview.remainingTokens
    },
    whatStoppedOrWillStopNext: preview.shouldStop
      ? `Martin is at a stop condition: ${loop.lifecycleState}.`
      : "Martin still has budget/iteration/token room, but preflight should run before another attempt."
  };
}

async function buildLatestVerifierEvidenceResource(runsRoot: string): Promise<Record<string, unknown>> {
  const latest = await loadLatestRunForCompactResource(runsRoot);
  if (latest.empty || !latest.detail) {
    return compactEmptyState("verifier-evidence", runsRoot, latest.warnings);
  }

  const ledgerEvents = await readLedgerEvents(latest.detail);
  const loop = latest.detail.loop as Parameters<typeof buildPersistedLoopPreview>[0];
  const verification = buildVerificationHistorySnapshot(loop, ledgerEvents);

  return {
    kind: "verifier-evidence",
    loopId: loop.loopId,
    status: verification.latestVerification?.passed === true
      ? "passed"
      : verification.latestVerification?.passed === false
        ? "failed"
        : "unavailable",
    latestVerification: verification.latestVerification,
    verificationCount: verification.verificationCount,
    verificationHistory: verification.verificationHistory.slice(-3),
    warnings: [...latest.detail.warnings, ...verification.warnings],
    nextSafeAction: inferAgentNextStep(loop, verification)
  };
}

async function buildLatestRollbackEvidenceResource(runsRoot: string): Promise<Record<string, unknown>> {
  const latest = await loadLatestRunForCompactResource(runsRoot);
  if (latest.empty || !latest.detail) {
    return compactEmptyState("rollback-evidence", runsRoot, latest.warnings);
  }

  const loop = latest.detail.loop as Parameters<typeof buildPersistedLoopPreview>[0];
  const artifacts = loop.artifacts ?? [];
  const rollbackArtifacts = artifacts.filter((artifact) =>
    /rollback|restore|diff|patch/iu.test(`${artifact.kind} ${artifact.label} ${artifact.uri}`)
  );

  return {
    kind: "rollback-evidence",
    loopId: loop.loopId,
    artifactCount: artifacts.length,
    rollbackEvidenceCount: rollbackArtifacts.length,
    rollbackEvidence: rollbackArtifacts.slice(0, 5).map((artifact) => ({
      artifactId: artifact.artifactId,
      kind: artifact.kind,
      label: artifact.label,
      uri: artifact.uri
    })),
    boundary: rollbackArtifacts.length > 0
      ? "Rollback or diff evidence exists in the local run artifacts."
      : "No rollback artifact was found in this compact view; inspect the full dossier before claiming rollback evidence.",
    nextSafeAction: "If rollback evidence is required, call `martin_run_dossier` or read `martin://runs/{loopId}` before proceeding."
  };
}

async function buildAgentNextStepResource(runsRoot: string): Promise<Record<string, unknown>> {
  const latest = await loadLatestRunForCompactResource(runsRoot);
  if (latest.empty || !latest.detail) {
    return {
      ...compactEmptyState("agent-next-step", runsRoot, latest.warnings),
      nextTool: "martin_doctor",
      reason: "No run store evidence exists yet; confirm environment and run-store visibility first."
    };
  }

  const ledgerEvents = await readLedgerEvents(latest.detail);
  const loop = latest.detail.loop as Parameters<typeof buildPersistedLoopPreview>[0];
  const verification = buildVerificationHistorySnapshot(loop, ledgerEvents);
  const nextStep = inferAgentNextStep(loop, verification);

  return {
    kind: "agent-next-step",
    loopId: loop.loopId,
    nextStep,
    compactContext: {
      status: loop.status,
      lifecycleState: loop.lifecycleState,
      attempts: loop.attempts.length,
      latestFailureClass: loop.attempts.at(-1)?.failureClass,
      verifier: verification.latestVerification?.passed === true
        ? "passed"
        : verification.latestVerification?.passed === false
          ? "failed"
          : "unavailable"
    },
    requiredWorkflow: [
      "martin_doctor",
      "martin_plan",
      "martin_preflight",
      "martin_run",
      "martin_dossier",
      "martin_eval"
    ],
    preferredResource: MARTIN_STATIC_RESOURCE_URIS.latestSummary,
    proofCard: MARTIN_STATIC_RESOURCE_URIS.latestProofCard,
    operatingRules: MARTIN_STATIC_RESOURCE_URIS.operatingRulesGuide
  };
}

async function buildLatestProofCardResource(runsRoot: string): Promise<string> {
  const latest = await loadLatestRunForCompactResource(runsRoot);
  if (latest.empty || !latest.detail) {
    return [
      "# Martin Proof Card",
      "",
      "Status: no run evidence yet",
      "",
      "What happened: Martin has not found a local run record in this runs root.",
      "What Martin prevented: unknown until a governed run executes.",
      "Next safe action: call `martin_doctor`, run `npx martin-loop demo`, then inspect `martin://runs/latest/summary`.",
      "",
      "Estimate note: no cost or token savings are claimed without run evidence.",
      ""
    ].join("\n");
  }

  const ledgerEvents = await readLedgerEvents(latest.detail);
  const loop = latest.detail.loop as Parameters<typeof buildPersistedLoopPreview>[0];
  const verification = buildVerificationHistorySnapshot(loop, ledgerEvents);
  const preview = buildPersistedLoopPreview(loop);
  const latestAttempt = loop.attempts.at(-1);
  const verifierStatus = verification.latestVerification?.passed === true
    ? "passed"
    : verification.latestVerification?.passed === false
      ? "failed honestly"
      : "unavailable";

  return [
    "# Martin Proof Card",
    "",
    `Run: \`${loop.loopId}\``,
    `Status: ${loop.status} / ${loop.lifecycleState}`,
    `Attempts: ${loop.attempts.length}`,
    `Spend: $${loop.cost.actualUsd.toFixed(2)} actual, $${(loop.cost.avoidedUsd ?? 0).toFixed(2)} avoided estimate`,
    `Tokens: ${loop.cost.tokensIn} in / ${loop.cost.tokensOut} out`,
    `Verifier: ${verifierStatus}`,
    "",
    `What happened: ${latestAttempt?.summary ?? loop.task?.objective ?? "Martin produced a persisted governed run record."}`,
    `What Martin prevented: ${describePrevention(loop).join("; ")}`,
    `Budget state: ${preview.shouldStop ? "stop condition reached" : "budget still available"}; ${preview.remainingIterations} iteration(s) and ${preview.remainingTokens} token(s) remain.`,
    `Next safe action: ${inferAgentNextStep(loop, verification).instruction}`,
    "",
    "Evidence links:",
    `- Summary: \`${MARTIN_STATIC_RESOURCE_URIS.latestSummary}\``,
    `- Verifier: \`${MARTIN_STATIC_RESOURCE_URIS.latestVerifierEvidence}\``,
    `- Rollback/artifacts: \`${MARTIN_STATIC_RESOURCE_URIS.latestRollbackEvidence}\``,
    "",
    "Estimate note: avoided spend and token savings are directional local estimates unless backed by adapter/provider usage receipts.",
    ""
  ].join("\n");
}

function compactEmptyState(kind: string, runsRoot: string, warnings: string[]): Record<string, unknown> {
  return {
    kind,
    status: "empty",
    runsRoot,
    summary: "No Martin run records are available yet.",
    nextStep: "Run `npx martin-loop doctor`, create the demo workspace with `npx martin-loop demo`, then run `npx martin-loop run ... --proof --verify <command>`.",
    warnings
  };
}

async function buildGovernanceStatusResource(runsRoot: string, workingDirectory: string): Promise<Record<string, unknown>> {
  const state = await readWorkflowState(runsRoot);
  const mcpState = state.mcp ?? {};
  const hasDoctor = Boolean(mcpState.doctor);
  const hasPlan = Boolean(mcpState.plan);
  const hasPreflight = Boolean(mcpState.preflight);
  const governed = hasDoctor && hasPlan && hasPreflight;

  const latest = await loadLatestRunForCompactResource(runsRoot);
  const budgetRemaining = (!latest.empty && latest.detail)
    ? buildPersistedLoopPreview(latest.detail.loop as Parameters<typeof buildPersistedLoopPreview>[0]).remainingBudgetUsd
    : null;

  let unreceiptedRuns = 0;
  try {
    const inspection = await inspectLoopTool({ runsDir: runsRoot });
    const total = inspection.loopCount ?? 0;
    const completed = (inspection.statusBreakdown?.completed ?? 0) + (inspection.statusBreakdown?.failed ?? 0);
    unreceiptedRuns = Math.max(0, total - completed);
  } catch {
    // No runs yet
  }

  const missingSteps: string[] = [];
  if (!hasDoctor) missingSteps.push("martin_doctor");
  if (!hasPlan) missingSteps.push("martin_plan");
  if (!hasPreflight) missingSteps.push("martin_preflight");

  const recommendedAction = !hasDoctor
    ? "Run martin_doctor to confirm environment before any work."
    : !hasPlan
      ? "Run martin_plan with your objective to scope the task."
      : !hasPreflight
        ? "Run martin_preflight to validate the run contract before execution."
        : "Governance complete. You may proceed with martin_run.";

  return {
    kind: "governance-status",
    governed,
    workflowReceipts: {
      doctor: hasDoctor ? { recordedAt: mcpState.doctor!.recordedAt } : null,
      plan: hasPlan ? { recordedAt: mcpState.plan!.recordedAt } : null,
      preflight: hasPreflight ? { recordedAt: mcpState.preflight!.recordedAt } : null
    },
    missingSteps,
    budgetRemaining,
    unreceiptedRuns,
    recommendedAction,
    requiredSequence: ["martin_doctor", "martin_plan", "martin_preflight", "martin_run", "martin_dossier"],
    warning: governed ? undefined : "This session is NOT governed. Complete the required sequence before making changes."
  };
}

function buildCurrentPoliciesResource(workingDirectory: string): Record<string, unknown> {
  const signals = inspectRepoSignals(workingDirectory);
  const recommended = buildPolicyPackDefinition(undefined, signals);
  return {
    recommended: recommended.name,
    packs: [
      buildPolicyPackDefinition("solo-founder", signals),
      buildPolicyPackDefinition("startup-team", signals),
      buildPolicyPackDefinition("enterprise-strict", signals),
      buildPolicyPackDefinition("oss-maintainer", signals),
      buildPolicyPackDefinition("security-sensitive", signals)
    ]
  };
}

function describePrevention(loop: Parameters<typeof buildPersistedLoopPreview>[0]): string[] {
  const prevented = [];
  const latestAttempt = loop.attempts.at(-1);

  if (loop.lifecycleState === "budget_exit" || loop.lifecycleState === "diminishing_returns") {
    prevented.push("unsafe or uneconomical retry continuation");
  }
  if (latestAttempt?.failureClass) {
    prevented.push(`unlabeled failure drift (${latestAttempt.failureClass})`);
  }
  if ((loop.cost.avoidedUsd ?? 0) > 0) {
    prevented.push("estimated additional spend");
  }
  if (loop.status !== "completed") {
    prevented.push("false success claims before verifier-backed completion");
  }

  return prevented.length > 0 ? prevented : ["no extra prevention claim available from this compact record"];
}

function inferAgentNextStep(
  loop: Parameters<typeof buildPersistedLoopPreview>[0],
  verification: ReturnType<typeof buildVerificationHistorySnapshot>
): { action: string; toolOrResource: string; instruction: string } {
  if (verification.latestVerification?.passed === false) {
    return {
      action: "debug_failed_run",
      toolOrResource: "martin_debug_failed_run",
      instruction: `Use prompt \`martin_debug_failed_run\` for loop \`${loop.loopId}\`, then rerun only after the verifier failure is understood.`
    };
  }

  if (loop.lifecycleState === "budget_exit" || loop.lifecycleState === "diminishing_returns") {
    return {
      action: "triage_before_retry",
      toolOrResource: "martin_triage_runs",
      instruction: "Call `martin_triage_runs` and inspect the proof card before spending another attempt."
    };
  }

  if (loop.status === "completed" && verification.latestVerification?.passed === true) {
    return {
      action: "prove_and_share",
      toolOrResource: MARTIN_STATIC_RESOURCE_URIS.latestProofCard,
      instruction: "Read the proof card and full dossier before sharing or promoting the result."
    };
  }

  return {
    action: "preflight_next_attempt",
    toolOrResource: "martin_preflight",
    instruction: "Call `martin_preflight` with explicit verifier, budget, and path scope before the next run."
  };
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
5. For low-context agents, read \`${MARTIN_STATIC_RESOURCE_URIS.agentNextStep}\`, \`${MARTIN_STATIC_RESOURCE_URIS.latestSummary}\`, or \`${MARTIN_STATIC_RESOURCE_URIS.latestProofCard}\` before asking for full JSON.
6. Read \`${MARTIN_STATIC_RESOURCE_URIS.triage}\` or call \`martin_triage_runs\` to prioritize which run needs attention first.
7. Use \`martin_debug_failed_run\` when a loop exits failed, budget-bound, or escalated.

## Current Martin MCP Surface

- Tools: \`martin_run\`, \`martin_inspect\`, \`martin_status\`, \`martin_doctor\`, \`martin_preflight\`, \`martin_list_runs\`, \`martin_triage_runs\`, \`martin_get_run\`, \`martin_get_attempt\`, \`martin_get_verification_results\`, \`martin_run_dossier\`
- Static resources: \`${MARTIN_STATIC_RESOURCE_URIS.serverHealth}\`, \`${MARTIN_STATIC_RESOURCE_URIS.recentRuns}\`, \`${MARTIN_STATIC_RESOURCE_URIS.triage}\`, \`${MARTIN_STATIC_RESOURCE_URIS.latestSummary}\`, \`${MARTIN_STATIC_RESOURCE_URIS.latestProofCard}\`, \`${MARTIN_STATIC_RESOURCE_URIS.latestBudgetStatus}\`, \`${MARTIN_STATIC_RESOURCE_URIS.latestVerifierEvidence}\`, \`${MARTIN_STATIC_RESOURCE_URIS.latestRollbackEvidence}\`, \`${MARTIN_STATIC_RESOURCE_URIS.agentNextStep}\`, \`${MARTIN_STATIC_RESOURCE_URIS.mcpUsageGuide}\`, \`${MARTIN_STATIC_RESOURCE_URIS.agentStartGuide}\`, \`${MARTIN_STATIC_RESOURCE_URIS.publishReadinessGuide}\`
- Resource templates: \`martin://runs/{loopId}\`, \`martin://runs/{loopId}/attempts/{attemptIndex}\`, \`martin://runs/{loopId}/verification\`
- Prompts: \`martin_start\`, \`martin_preflight\`, \`martin_triage\`, \`martin_resume\`, \`martin_prove\`, \`martin_release_check\`, \`martin_governed_coding_kickoff\`, \`martin_debug_failed_run\`, \`martin_publish_readiness_review\`, \`martin_triage_run_store\`

## Notes

- Discovery helpers read the existing Martin run-store; they do not create new schema.
- Verification history is derived from persisted \`verification.completed\` evidence in loop records and ledgers.
- Attempt inspection stays aligned with the same loop selectors used by \`martin_status\` and \`martin_inspect\`.
`;
}

function buildAgentStartGuide(runsRoot: string): string {
  const metadata = buildMartinDiscoveryMetadata(MARTIN_MCP_PACKAGE_VERSION);
  return `# Agent Start Here

Discovery revision: \`${metadata.discoveryRevision}\`
Server version: \`${metadata.serverVersion}\`
Runs root: \`${runsRoot}\`

Use Martin Loop as the local governor before you spend agent tokens or retry a failed coding loop.

## Cheap Default Flow

1. Read \`${MARTIN_STATIC_RESOURCE_URIS.agentNextStep}\` first. It is the smallest "what should I do now?" payload.
2. If no runs exist, call \`martin_doctor\`, then \`martin_preflight\`.
3. If a run exists, read \`${MARTIN_STATIC_RESOURCE_URIS.latestSummary}\` before reading full run JSON.
4. If the verifier failed, use prompt \`martin_debug_failed_run\` or \`martin_triage\`.
5. If you need a shareable receipt, read \`${MARTIN_STATIC_RESOURCE_URIS.latestProofCard}\`.

## Install Profiles

- \`minimal\` (default): doctor, preflight, list, triage, dossier. Good for low tool bloat.
- \`diagnostic\`: read-only inspection tools for debugging without execution.
- \`full-local\`: all local tools, including \`martin_run\`.
- \`github-review\`: review-oriented local profile for PR drafting and reviewer evidence.
- \`starter\` and \`full\`: compatibility aliases.

## Copy-Paste Agent Rule

Before running or retrying an autonomous coding task, call Martin. Prefer compact resources first, then full dossiers only when the compact receipt says more evidence is needed. Never claim success unless Martin shows verifier-backed completion or a clear blocked reason.
`;
}

function buildCommandMapGuide(runsRoot: string): string {
  const metadata = buildMartinDiscoveryMetadata(MARTIN_MCP_PACKAGE_VERSION);
  return `# Martin Command Map

Discovery revision: \`${metadata.discoveryRevision}\`
Server version: \`${metadata.serverVersion}\`
Runs root: \`${runsRoot}\`

Use this guide when an IDE or agent needs to know which Martin surface to call next.

## Default Governed Sequence

1. \`martin_doctor\` — confirm environment and visibility.
2. \`martin_plan\` — propose the bounded approach without spending a run.
3. \`martin_preflight\` — turn the plan into an explicit contract.
4. \`martin_run\` — execute only after the contract is safe.
5. \`martin_dossier\` — inspect what happened and what Martin prevented.
6. \`martin_eval\` — convert the result into review posture when needed.

## When To Use Which Surface

- Need the smallest next action: \`${MARTIN_STATIC_RESOURCE_URIS.agentNextStep}\`
- Need a quick receipt: \`${MARTIN_STATIC_RESOURCE_URIS.latestSummary}\`
- Need a shareable proof object: \`${MARTIN_STATIC_RESOURCE_URIS.latestProofCard}\`
- Need a full run review: \`martin_dossier\`
- Need to decide whether to retry: \`martin_triage_runs\`
- Need IDE setup guidance: \`${MARTIN_STATIC_RESOURCE_URIS.ideOnboardingGuide}\`
`;
}

function buildIdeOnboardingGuide(runsRoot: string): string {
  const metadata = buildMartinDiscoveryMetadata(MARTIN_MCP_PACKAGE_VERSION);
  return `# Martin IDE Onboarding

Discovery revision: \`${metadata.discoveryRevision}\`
Server version: \`${metadata.serverVersion}\`
Runs root: \`${runsRoot}\`

Use this guide after the MCP server is installed so the host naturally uses MartinLoop during real work.

## IDE Default Flow

1. Read \`${MARTIN_STATIC_RESOURCE_URIS.agentStartGuide}\`
2. Read \`${MARTIN_STATIC_RESOURCE_URIS.operatingRulesGuide}\`
3. Use prompt \`martin_start\` or \`martin_governed_coding_kickoff\`
4. Call \`martin_doctor\`
5. Call \`martin_plan\`
6. Call \`martin_preflight\`
7. Only then call \`martin_run\`

## Goal

MartinLoop should become the normal path for coding work in the host, not a manual extra step the human has to remember.
`;
}

function buildOperatingRulesGuide(runsRoot: string): string {
  const metadata = buildMartinDiscoveryMetadata(MARTIN_MCP_PACKAGE_VERSION);
  return `# Martin Operating Rules

Discovery revision: \`${metadata.discoveryRevision}\`
Server version: \`${metadata.serverVersion}\`
Runs root: \`${runsRoot}\`

Use these rules inside the IDE or MCP host as the default MartinLoop operating posture.

## Required Sequence Before Real Work

1. \`martin_doctor\`
2. \`martin_plan\`
3. \`martin_preflight\`
4. \`martin_run\`
5. \`martin_dossier\`

## Enforcement Rule

Do not execute real coding work through MartinLoop until doctor and preflight have both been used for the current task.

## Completion Rule

Do not claim success until MartinLoop shows verifier-backed completion or an explicit blocked reason backed by evidence.
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
