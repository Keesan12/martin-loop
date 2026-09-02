#!/usr/bin/env node

/**
 * Martin Loop MCP Server
 *
 * Martin Loop MCP is a governed execution cockpit for AI coding agents.
 * It exposes execution, diagnostics, run inspection, resources, and prompts
 * over the Model Context Protocol (stdio transport).
 *
 * Setup (Claude Code):
 *   macOS/Linux: claude mcp add --scope user martin-loop -- npx @martinloop/mcp
 *   Windows:     claude mcp add --scope user martin-loop cmd /c "npx @martinloop/mcp"
 *
 * Packaged smoke test:
 *   pnpm --filter @martinloop/mcp smoke:pack
 *
 * Manual start:
 *   node dist/server.js
 */

import { createServer as createHttpServer, type IncomingMessage, type Server as NodeHttpServer, type ServerResponse } from "node:http";
import { fileURLToPath, pathToFileURL } from "node:url";
import { realpathSync } from "node:fs";
import path from "node:path";

import { resolveRunsRoot } from "@martin/core";
import type { LoopBudget, ReceiptScope } from "@martin/contracts";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema
} from "@modelcontextprotocol/sdk/types.js";

import { MARTIN_MCP_PACKAGE_VERSION } from "./package-version.js";
import { MARTIN_DIRECTORY_TOOL_NAMES } from "./discovery-metadata.js";
import {
  MARTIN_ARCADE_FALLBACK_TEXT,
  MARTIN_ARCADE_MIME_TYPE,
  MARTIN_ARCADE_RESOURCE_URI,
  MARTIN_ARCADE_UI_EXTENSION_ID,
  buildArcadeToolDefinitions,
  supportsMartinArcadeApp
} from "./arcade/capabilities.js";
import { listArcadeResources, readArcadeResource } from "./arcade/resource.js";
import { readArcadeStatus } from "./arcade/status.js";
import { getMartinPrompt, listMartinPrompts } from "./prompts.js";
import {
  listMartinResources,
  listMartinResourceTemplates,
  readMartinResource
} from "./resources.js";
import { martinDoctorTool } from "./tools/doctor.js";
import { martinEvalTool } from "./tools/eval.js";
import { martinGetAttemptTool } from "./tools/get-attempt.js";
import { martinGetRunTool } from "./tools/get-run.js";
import { martinGetVerificationResultsTool } from "./tools/get-verification-results.js";
import { getStatusTool } from "./tools/get-status.js";
import { inspectLoopTool } from "./tools/inspect-loop.js";
import { martinListRunsTool } from "./tools/list-runs.js";
import { martinLogsTool } from "./tools/logs.js";
import { martinPlanTool } from "./tools/plan.js";
import { martinPreflightTool } from "./tools/preflight.js";
import { martinCreatePrTool, martinPrSummaryTool, martinReviewPrTool } from "./tools/pr-tools.js";
import { martinRunDossierTool } from "./tools/run-dossier.js";
import { createRunControlReceipt } from "./tools/run-controls.js";
import { martinTriageRunsTool } from "./tools/triage-runs.js";
import { runLoopTool } from "./tools/run-loop.js";
import { MARTIN_ENGINE_VALUES, type MartinEngine } from "./tools/tool-support.js";
import { classifyRoute } from "@martin/core";
import { createToolErrorResult, createToolSuccessResult } from "./tools/tool-response.js";
import { buildGovernedPlanStages, renderGovernedRunPlanMarkdown, renderVerifiedHandoffMarkdown } from "@martin/presentation";
import { MartinToolError, toToolFailure } from "./tools/tool-errors.js";
import { normalizeLoopBudget } from "./tools/workflow-governance.js";
import { resolveSafeRepoRoot, sanitizeToolErrorMessage, validateToolInput } from "./server-validation.js";
import { evaluateMcpRunGate, recordMcpWorkflowStep } from "./workflow-state.js";

const stringArraySchema = {
  type: "array",
  items: { type: "string" }
} as const;

export type MartinMcpToolProfile = "full" | "directory";

const martinDirectoryToolNames = new Set<string>(MARTIN_DIRECTORY_TOOL_NAMES);

export function shouldExposeMartinTool(name: string, profile: MartinMcpToolProfile): boolean {
  return profile === "full" || martinDirectoryToolNames.has(name);
}

const loopPreviewSchema = {
  type: "object",
  additionalProperties: true,
  properties: {
    loopId: { type: "string" },
    title: { type: "string" },
    objective: { type: "string" },
    status: { type: "string" },
    lifecycleState: { type: "string" },
    createdAt: { type: "string" },
    updatedAt: { type: "string" },
    attempts: { type: "integer" },
    costUsd: { type: "number" },
    avoidedUsd: { type: "number" },
    pressure: { type: "string" },
    shouldStop: { type: "boolean" },
    remainingBudgetUsd: { type: "number" },
    remainingIterations: { type: "integer" },
    remainingTokens: { type: "integer" },
    lastAttempt: {
      type: "object",
      additionalProperties: true
    }
  },
  required: [
    "loopId",
    "title",
    "objective",
    "status",
    "lifecycleState",
    "attempts",
    "costUsd",
    "avoidedUsd",
    "pressure",
    "shouldStop",
    "remainingBudgetUsd",
    "remainingIterations"
  ]
} as const;

const budgetSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    maxUsd: { type: "number" },
    softLimitUsd: { type: "number" },
    maxIterations: { type: "integer" },
    maxTokens: { type: "integer" }
  },
  required: ["maxUsd", "softLimitUsd", "maxIterations"]
} as const;

const costSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    actualUsd: { type: "number" },
    avoidedUsd: { type: "number" },
    tokensIn: { type: "integer" },
    tokensOut: { type: "integer" },
    provenance: {
      type: "string",
      enum: ["actual", "calculated", "estimated", "unavailable"]
    }
  },
  required: ["actualUsd", "avoidedUsd", "tokensIn", "tokensOut", "provenance"]
} as const;

const verificationSchema = {
  type: "object",
  additionalProperties: true,
  properties: {
    status: { type: "string", enum: ["passed", "failed", "contradicted", "not_run"] },
    eventCount: { type: "integer" },
    ledgerEventCount: { type: "integer" },
    latestAttemptIndex: { type: "integer" },
    completedAt: { type: "string" },
    summary: { type: "string" },
    steps: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: true,
        properties: {
          command: { type: "string" },
          launched: { type: "boolean" },
          exitCode: { type: "integer" },
          timedOut: { type: "boolean" },
          fastFail: { type: "boolean" },
          detail: { type: "string" }
        },
        required: ["command", "launched"]
      }
    },
    warnings: stringArraySchema
  },
  required: ["status", "eventCount", "ledgerEventCount", "warnings"]
} as const;

const receiptScopeSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    invocationRoot: { type: "string" },
    workingDirectory: { type: "string" },
    repoRoot: { type: "string" },
    runsRoot: { type: "string" }
  },
  required: ["invocationRoot", "workingDirectory", "repoRoot", "runsRoot"]
} as const;

const artifactSummarySchema = {
  type: "object",
  additionalProperties: true,
  properties: {
    totalCount: { type: "integer" },
    kinds: {
      type: "object",
      additionalProperties: { type: "integer" }
    },
    highlights: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          artifactId: { type: "string" },
          kind: { type: "string" },
          label: { type: "string" },
          uri: { type: "string" }
        },
        required: ["artifactId", "kind", "label", "uri"]
      }
    }
  },
  required: ["totalCount", "kinds", "highlights"]
} as const;

const attemptArtifactsSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    directory: { type: "string" },
    available: { type: "boolean" },
    files: stringArraySchema
  },
  required: ["directory", "available", "files"]
} as const;

const attemptSummarySchema = {
  type: "object",
  additionalProperties: true,
  properties: {
    index: { type: "integer" },
    attemptId: { type: "string" },
    adapterId: { type: "string" },
    model: { type: "string" },
    failureClass: { type: "string" },
    intervention: { type: "string" },
    startedAt: { type: "string" },
    completedAt: { type: "string" },
    summary: { type: "string" },
    artifacts: attemptArtifactsSchema,
    artifactFiles: stringArraySchema
  },
  required: ["index"]
} as const;

const inspectionPathsSchema = {
  type: "object",
  additionalProperties: true,
  properties: {
    runsRoot: { type: "string" },
    runDirectory: { type: "string" },
    loopRecordPath: { type: "string" },
    ledgerPath: { type: "string" },
    canonicalRunDirectory: { type: "string" },
    canonicalLoopRecordPath: { type: "string" }
  },
  required: ["runsRoot"]
} as const;

const eventSummarySchema = {
  type: "object",
  additionalProperties: true,
  properties: {
    type: { type: "string" },
    timestamp: { type: "string" },
    lifecycleState: { type: "string" },
    payload: {
      type: "object",
      additionalProperties: true
    }
  },
  required: ["type", "payload"]
} as const;

const runOutputSchema = {
  type: "object",
  additionalProperties: true,
  properties: {
    status: { type: "string" },
    lifecycleState: { type: "string" },
    reason: { type: "string" },
    attempts: { type: "integer" },
    costUsd: { type: "number" },
    verificationPassed: { type: "boolean" },
    loopId: { type: "string" },
    pressure: { type: "string" },
    shouldStop: { type: "boolean" },
    remainingBudgetUsd: { type: "number" },
    remainingIterations: { type: "integer" },
    remainingTokens: { type: "integer" },
    engine: { type: "string" },
    workingDirectory: { type: "string" },
    budget: budgetSchema,
    inspection: {
      type: "object",
      additionalProperties: true,
      properties: {
        runsRoot: { type: "string" },
        runDirectory: { type: "string" },
        loopRecordPath: { type: "string" },
        ledgerPath: { type: "string" },
        loop: loopPreviewSchema,
        verification: verificationSchema,
        artifacts: artifactSummarySchema
      },
      required: ["runsRoot", "runDirectory", "loopRecordPath", "ledgerPath", "loop", "verification", "artifacts"]
    }
  },
  required: [
    "status",
    "lifecycleState",
    "reason",
    "attempts",
    "costUsd",
    "verificationPassed",
    "loopId",
    "pressure",
    "shouldStop",
    "remainingBudgetUsd",
    "remainingIterations",
    "engine",
    "workingDirectory",
    "budget",
    "inspection"
  ]
} as const;

const inspectOutputSchema = {
  type: "object",
  additionalProperties: true,
  properties: {
    source: { type: "string" },
    loopCount: { type: "integer" },
    portfolio: {
      type: "object",
      additionalProperties: true
    },
    latestRun: loopPreviewSchema,
    recentRuns: {
      type: "array",
      items: loopPreviewSchema
    },
    statusBreakdown: {
      type: "object",
      additionalProperties: { type: "integer" }
    },
    lifecycleBreakdown: {
      type: "object",
      additionalProperties: { type: "integer" }
    },
    inspection: {
      type: "object",
      additionalProperties: false,
      properties: {
        sourceKind: { type: "string", enum: ["file", "runs_root"] }
      },
      required: ["sourceKind"]
    },
    warnings: stringArraySchema
  },
  required: [
    "source",
    "loopCount",
    "portfolio",
    "recentRuns",
    "statusBreakdown",
    "lifecycleBreakdown",
    "inspection",
    "warnings"
  ]
} as const;

const statusOutputSchema = {
  type: "object",
  additionalProperties: true,
  properties: {
    source: { type: "string" },
    loopId: { type: "string" },
    status: { type: "string" },
    lifecycleState: { type: "string" },
    attempts: { type: "integer" },
    costUsd: { type: "number" },
    avoidedUsd: { type: "number" },
    pressure: { type: "string" },
    shouldStop: { type: "boolean" },
    remainingBudgetUsd: { type: "number" },
    remainingIterations: { type: "integer" },
    remainingTokens: { type: "integer" },
    budget: budgetSchema,
    inspection: {
      type: "object",
      additionalProperties: false,
      properties: {
        loop: loopPreviewSchema
      },
      required: ["loop"]
    }
  },
  required: [
    "source",
    "loopId",
    "status",
    "lifecycleState",
    "attempts",
    "costUsd",
    "avoidedUsd",
    "pressure",
    "shouldStop",
    "remainingBudgetUsd",
    "remainingIterations",
    "budget",
    "inspection"
  ]
} as const;

const doctorOutputSchema = {
  type: "object",
  additionalProperties: true,
  properties: {
    status: { type: "string", enum: ["ok", "degraded"] },
    summary: { type: "string" },
    server: {
      type: "object",
      additionalProperties: false,
      properties: {
        name: { type: "string" },
        nodeVersion: { type: "string" },
        platform: { type: "string" }
      },
      required: ["name", "nodeVersion", "platform"]
    },
    environment: {
      type: "object",
      additionalProperties: false,
      properties: {
        workspaceRoot: { type: "string" },
        workingDirectory: { type: "string" },
        runsRoot: { type: "string" },
        mode: { type: "string", enum: ["live", "proof"] },
        liveMode: { type: "boolean" }
      },
      required: ["workspaceRoot", "workingDirectory", "runsRoot", "mode", "liveMode"]
    },
    receiptScope: receiptScopeSchema,
    engines: {
      type: "object",
      additionalProperties: true
    },
    requestedEngine: { type: "string" },
    runStore: {
      type: "object",
      additionalProperties: true,
      properties: {
        exists: { type: "boolean" },
        loopCount: { type: "integer" },
        latestRun: loopPreviewSchema
      },
      required: ["exists", "loopCount"]
    },
    warnings: stringArraySchema
  },
  required: ["status", "summary", "server", "environment", "receiptScope", "engines", "runStore", "warnings"]
} as const;

const preflightOutputSchema = {
  type: "object",
  additionalProperties: true,
  properties: {
    ok: { type: "boolean" },
    summary: { type: "string" },
    warnings: stringArraySchema,
    receiptScope: receiptScopeSchema,
    readiness: {
      type: "object",
      additionalProperties: false,
      properties: {
        mode: { type: "string", enum: ["live", "proof"] },
        liveMode: { type: "boolean" },
        engineReady: { type: "boolean" }
      },
      required: ["mode", "liveMode", "engineReady"]
    },
    normalized: {
      type: "object",
      additionalProperties: true,
      properties: {
        objective: { type: "string" },
        workingDirectory: { type: "string" },
        engine: { type: "string" },
        model: { type: "string" },
        budget: budgetSchema,
        verificationPlan: stringArraySchema,
        allowedPaths: stringArraySchema,
        deniedPaths: stringArraySchema,
        workspaceId: { type: "string" },
        projectId: { type: "string" }
      },
      required: [
        "objective",
        "workingDirectory",
        "engine",
        "budget",
        "verificationPlan",
        "workspaceId",
        "projectId"
      ]
    },
    execution: {
      type: "object",
      additionalProperties: false,
      properties: {
        requestedEngine: { type: "string" },
        engineAvailability: {
          type: "object",
          additionalProperties: true,
          properties: {
            available: { type: "boolean" },
            detail: { type: "string" },
            resolvedPath: { type: "string" }
          },
          required: ["available", "detail"]
        },
        runsRoot: { type: "string" },
        pathScope: {
          type: "object",
          additionalProperties: false,
          properties: {
            repoRoot: { type: "string" },
            allowedPathsCount: { type: "integer" },
            deniedPathsCount: { type: "integer" },
            hasScopeConflicts: { type: "boolean" }
          },
          required: ["repoRoot", "allowedPathsCount", "deniedPathsCount", "hasScopeConflicts"]
        },
        expectedRunLayout: {
          type: "object",
          additionalProperties: false,
          properties: {
            runDirectoryPattern: { type: "string" },
            loopRecordPathPattern: { type: "string" }
          },
          required: ["runDirectoryPattern", "loopRecordPathPattern"]
        }
      },
      required: ["requestedEngine", "engineAvailability", "runsRoot", "pathScope", "expectedRunLayout"]
    }
  },
  required: ["ok", "summary", "warnings", "receiptScope", "readiness", "normalized", "execution"]
} as const;

const listRunsOutputSchema = {
  type: "object",
  additionalProperties: true,
  properties: {
    source: { type: "string" },
    runsRoot: { type: "string" },
    filters: {
      type: "object",
      additionalProperties: true
    },
    loopCount: { type: "integer" },
    latestRun: loopPreviewSchema,
    recentRuns: {
      type: "array",
      items: loopPreviewSchema
    },
    statusBreakdown: {
      type: "object",
      additionalProperties: { type: "integer" }
    },
    lifecycleBreakdown: {
      type: "object",
      additionalProperties: { type: "integer" }
    },
    warnings: stringArraySchema
  },
  required: [
    "source",
    "runsRoot",
    "filters",
    "loopCount",
    "recentRuns",
    "statusBreakdown",
    "lifecycleBreakdown",
    "warnings"
  ]
} as const;

const triageFindingSchema = {
  type: "object",
  additionalProperties: true,
  properties: {
    severity: { type: "string", enum: ["critical", "high", "medium", "low"] },
    summary: { type: "string" },
    reasonCodes: stringArraySchema,
    loop: loopPreviewSchema,
    verification: verificationSchema,
    suggestedResources: stringArraySchema,
    suggestedPrompts: stringArraySchema
  },
  required: [
    "severity",
    "summary",
    "reasonCodes",
    "loop",
    "verification",
    "suggestedResources",
    "suggestedPrompts"
  ]
} as const;

const triageRunsOutputSchema = {
  type: "object",
  additionalProperties: true,
  properties: {
    source: { type: "string" },
    runsRoot: { type: "string" },
    filters: {
      type: "object",
      additionalProperties: true
    },
    evaluatedRuns: { type: "integer" },
    findingCount: { type: "integer" },
    severityBreakdown: {
      type: "object",
      additionalProperties: { type: "integer" }
    },
    findings: {
      type: "array",
      items: triageFindingSchema
    },
    warnings: stringArraySchema
  },
  required: [
    "source",
    "runsRoot",
    "filters",
    "evaluatedRuns",
    "findingCount",
    "severityBreakdown",
    "findings",
    "warnings"
  ]
} as const;

const getRunOutputSchema = {
  type: "object",
  additionalProperties: true,
  properties: {
    source: { type: "string" },
    sourceKind: { type: "string", enum: ["file", "loop_id", "latest", "runs_root"] },
    loop: loopPreviewSchema,
    budget: budgetSchema,
    cost: costSchema,
    verification: verificationSchema,
    artifacts: artifactSummarySchema,
    inspection: inspectionPathsSchema,
    warnings: stringArraySchema
  },
  required: ["source", "sourceKind", "loop", "budget", "cost", "verification", "artifacts", "inspection", "warnings"]
} as const;

const getAttemptOutputSchema = {
  type: "object",
  additionalProperties: true,
  properties: {
    source: { type: "string" },
    sourceKind: { type: "string", enum: ["file", "loop_id", "latest", "runs_root"] },
    loop: loopPreviewSchema,
    attempt: attemptSummarySchema,
    warnings: stringArraySchema
  },
  required: ["source", "sourceKind", "loop", "attempt", "warnings"]
} as const;

const verificationResultsOutputSchema = {
  type: "object",
  additionalProperties: true,
  properties: {
    source: { type: "string" },
    sourceKind: { type: "string", enum: ["file", "loop_id", "latest", "runs_root"] },
    loop: loopPreviewSchema,
    verification: verificationSchema,
    warnings: stringArraySchema
  },
  required: ["source", "sourceKind", "loop", "verification", "warnings"]
} as const;

const dossierOutputSchema = {
  type: "object",
  additionalProperties: true,
  properties: {
    source: { type: "string" },
    sourceKind: { type: "string", enum: ["file", "loop_id", "latest", "runs_root"] },
    loop: loopPreviewSchema,
    budget: budgetSchema,
    cost: costSchema,
    attempts: {
      type: "array",
      items: attemptSummarySchema
    },
    verification: verificationSchema,
    artifacts: artifactSummarySchema,
    recentEvents: {
      type: "array",
      items: eventSummarySchema
    },
    related: {
      type: "object",
      additionalProperties: false,
      properties: {
        resources: stringArraySchema,
        prompts: stringArraySchema
      },
      required: ["resources", "prompts"]
    },
    inspection: inspectionPathsSchema,
    warnings: stringArraySchema
  },
  required: [
    "source",
    "sourceKind",
    "loop",
    "budget",
    "cost",
    "attempts",
    "verification",
    "artifacts",
    "recentEvents",
    "related",
    "inspection",
    "warnings"
  ]
} as const;

const planOutputSchema = {
  type: "object",
  additionalProperties: true
} as const;

const logsOutputSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    source: { type: "string", description: "Resolved path to the loop-record source file." },
    sourceKind: {
      type: "string",
      enum: ["file", "loop_id", "latest", "runs_root"],
      description: "How the run was identified: by file path, loop ID, latest flag, or runs directory."
    },
    loopId: { type: "string", description: "Unique MartinLoop run identifier." },
    logCount: { type: "integer", description: "Number of log entries returned after applying the limit." },
    live: {
      type: "object",
      additionalProperties: false,
      properties: {
        lifecycleState: { type: "string", description: "Current run lifecycle state (e.g. running, completed, cancelled)." },
        pauseState: {
          type: "string",
          enum: ["active", "paused", "cancellation_requested"],
          description: "Whether the run is active, paused, or has a pending cancellation."
        },
        approvalState: {
          type: "string",
          enum: ["not_required", "resume_requested"],
          description: "Whether the run is waiting at a human-approval checkpoint."
        }
      },
      required: ["lifecycleState", "pauseState", "approvalState"]
    },
    entries: {
      type: "array",
      description: "Log entries sorted by timestamp descending, capped at limit.",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          timestamp: { type: "string", description: "ISO 8601 timestamp of the event, if present." },
          source: {
            type: "string",
            enum: ["event", "ledger", "control"],
            description: "Origin stream: loop event bus, governance ledger, or operator control receipts."
          },
          kind: { type: "string", description: "Event type or control action name." },
          payload: { type: "object", additionalProperties: true, description: "Event-specific payload data." }
        },
        required: ["source", "kind", "payload"]
      }
    }
  },
  required: ["source", "sourceKind", "loopId", "logCount", "live", "entries"]
} as const;

const controlOutputSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    loopId: { type: "string", description: "MartinLoop run identifier the control was applied to." },
    action: {
      type: "string",
      enum: ["pause", "cancel", "continue"],
      description: "The control action that was recorded."
    },
    controlId: { type: "string", description: "Unique receipt ID for this control action." },
    requestedAt: { type: "string", description: "ISO 8601 timestamp when the control was recorded." },
    requestedBy: { type: "string", description: "Identity that requested the control, if provided." },
    reason: { type: "string", description: "Human-readable reason for the control, if provided." }
  },
  required: ["loopId", "action", "controlId", "requestedAt"]
} as const;

const evalOutputSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    source: { type: "string", description: "Resolved path to the loop-record source file." },
    sourceKind: {
      type: "string",
      enum: ["file", "loop_id", "latest", "runs_root"],
      description: "How the run was identified."
    },
    loopId: { type: "string", description: "Unique MartinLoop run identifier." },
    score: { type: "number", description: "Numeric evaluation score from 0–100." },
    grade: {
      type: "string",
      enum: ["mergeable", "mergeable_with_review", "needs_review", "blocked", "insufficient_evidence"],
      description: "Overall merge readiness grade derived from the six check dimensions."
    },
    checks: {
      type: "object",
      additionalProperties: false,
      properties: {
        taskCompletion: { type: "string", enum: ["passed", "warning", "failed"], description: "Whether the run reached a completed status." },
        verifier: { type: "string", enum: ["passed", "warning", "failed"], description: "Whether automated verifiers passed." },
        diffDiscipline: { type: "string", enum: ["passed", "warning", "failed"], description: "Whether file-scope discipline was maintained." },
        regressionRisk: { type: "string", enum: ["passed", "warning", "failed"], description: "Whether regression risk signals were detected." },
        securityRisk: { type: "string", enum: ["passed", "warning", "failed"], description: "Whether security risk signals were detected." },
        reviewability: { type: "string", enum: ["passed", "warning", "failed"], description: "Whether the PR body and dossier are reviewer-ready." }
      },
      required: ["taskCompletion", "verifier", "diffDiscipline", "regressionRisk", "securityRisk", "reviewability"]
    },
    warnings: { type: "array", items: { type: "string" }, description: "Non-blocking advisory warnings from the evaluation." },
    summary: { type: "string", description: "One-paragraph plain-English evaluation summary." }
  },
  required: ["source", "sourceKind", "loopId", "score", "grade", "checks", "warnings", "summary"]
} as const;

const prSummaryOutputSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    loopId: { type: "string", description: "MartinLoop run identifier used to generate the summary." },
    title: { type: "string", description: "Suggested GitHub pull-request title." },
    body: { type: "string", description: "GitHub-flavoured Markdown PR body containing the run dossier." },
    grade: {
      type: "string",
      enum: ["mergeable", "mergeable_with_review", "needs_review", "blocked", "insufficient_evidence"],
      description: "Verification grade assigned to the run."
    },
    score: { type: "number", description: "Numeric verification score from 0–100." }
  },
  required: ["loopId", "title", "body", "grade", "score"]
} as const;

const prReviewOutputSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    loopId: { type: "string", description: "MartinLoop run identifier the review was performed against." },
    verdict: {
      type: "string",
      enum: ["approve_with_review", "needs_changes", "blocked"],
      description: "Merge verdict: approve_with_review means safe to merge with human review; needs_changes requires fixes; blocked means do not merge."
    },
    findings: {
      type: "array",
      items: { type: "string" },
      description: "Specific findings that informed the verdict."
    },
    summary: { type: "string", description: "Plain-English review summary." }
  },
  required: ["loopId", "verdict", "findings", "summary"]
} as const;

export function createMartinMcpServer(serverInfo?: {
  name?: string;
  version?: string;
  toolProfile?: MartinMcpToolProfile;
}) {
  const toolProfile = serverInfo?.toolProfile ?? "full";
  const server = new Server(
    {
      name: serverInfo?.name ?? "martin-loop",
      version: serverInfo?.version ?? MARTIN_MCP_PACKAGE_VERSION
    },
    {
      capabilities: {
        tools: {},
        resources: {},
        prompts: {},
        extensions: {
          [MARTIN_ARCADE_UI_EXTENSION_ID]: { mimeTypes: [MARTIN_ARCADE_MIME_TYPE] }
        }
      }
    } as never
  );

  server.setRequestHandler(ListToolsRequestSchema, () => ({
  tools: [
    {
      name: "martin_run",
      description:
        "Execute a governed MartinLoop coding run after MCP workflow admission is satisfied. Use when the user has authorized implementation, bug fixing, tests, or refactoring and doctor/estimate/plan/preflight receipts match this task. Do not use for question-only diagnosis or when policy, budget, credentials, or scope still need consent. Next: read martin_dossier and verifier evidence.",
      annotations: {
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false
      },
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          objective: {
            type: "string",
            description: "The coding task to complete. Be specific about what needs to change."
          },
          workingDirectory: {
            type: "string",
            description:
              "Optional repo-root override resolved under the MCP workspace root. Must stay within that safe root."
          },
          engine: {
            type: "string",
            enum: [...MARTIN_ENGINE_VALUES],
            description: "Which agent CLI to use. Defaults to claude."
          },
          model: {
            type: "string",
            description: "Optional model override passed to the CLI."
          },
          maxUsd: {
            type: "number",
            exclusiveMinimum: 0,
            description: "Hard budget ceiling in USD."
          },
          maxIterations: {
            type: "integer",
            exclusiveMinimum: 0,
            description: "Maximum number of loop attempts."
          },
          maxTokens: {
            type: "integer",
            exclusiveMinimum: 0,
            description: "Maximum total tokens across all attempts."
          },
          verifyTimeoutMs: {
            type: "integer",
            exclusiveMinimum: 0,
            description: "Hard timeout for each verifier command in milliseconds."
          },
          providerExecutionTimeoutMs: {
            type: "integer",
            exclusiveMinimum: 0,
            description: "Hard timeout for each provider coding process in milliseconds."
          },
          verificationPlan: {
            type: "array",
            items: { type: "string" },
            description: "Commands that must all exit 0 for the task to be considered complete."
          },
          allowedPaths: {
            type: "array",
            items: { type: "string" },
            description: "Repo-relative path globs Martin may modify."
          },
          deniedPaths: {
            type: "array",
            items: { type: "string" },
            description: "Repo-relative path globs Martin must never modify."
          },
          workspaceId: {
            type: "string",
            description: "Workspace identifier for telemetry."
          },
          projectId: {
            type: "string",
            description: "Project identifier for telemetry."
          }
        },
        required: ["objective"]
      },
      outputSchema: runOutputSchema
    },
    {
      name: "martin_inspect",
      description:
        "Summarise Martin Loop run records from a saved loop file or run-store directory.",
      annotations: {
        readOnlyHint: true,
        idempotentHint: true
      },
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          file: {
            type: "string",
            description:
              "Optional path under the Martin runs root to a loop-record.json file, a legacy .jsonl file, or a run-store directory."
          },
          runsDir: {
            type: "string",
            description:
              "Optional runs-root override resolved under the default Martin runs root."
          }
        }
      },
      outputSchema: inspectOutputSchema
    },
    {
      name: "martin_status",
      description:
        "Read the current budget, cost, remaining limits, and stop pressure for one MartinLoop run. Provide exactly one selector: loopJson for an inline record, file for a saved record, loopId for a run-store ID, or latest for the newest run; runsDir only changes the run-store root. Use for a compact budget check. Do not use for full events or artifacts; use martin_get_run or martin_run_dossier instead.",
      annotations: {
        readOnlyHint: true,
        idempotentHint: true
      },
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          loopJson: { type: "string", description: "JSON-serialized LoopRecord." },
          file: {
            type: "string",
            description:
              "Path under the Martin runs root to a loop-record.json file, a legacy .jsonl file, or a run-store directory. Mutually exclusive with loopJson, loopId, and latest."
          },
          loopId: {
            type: "string",
            description: "Loop ID resolved as <runsDir>/<loopId>/loop-record.json. Mutually exclusive with loopJson, file, and latest."
          },
          runsDir: {
            type: "string",
            description: "Optional runs-root override resolved under the default Martin runs root."
          },
          latest: {
            const: true,
            description: "When true, loads the most recently updated loop record. Mutually exclusive with loopJson, file, and loopId."
          }
        },
        oneOf: [
          { required: ["loopJson"] },
          { required: ["file"] },
          { required: ["loopId"] },
          { required: ["latest"] }
        ]
      },
      outputSchema: statusOutputSchema
    },
    {
      name: "martin_doctor",
      description:
        "Read-only environment, engine, workspace, and run-store diagnostics for MartinLoop. Use first for software work, fresh installs, suspicious state, or before retries. Do not use as proof that a task is complete. Next: call martin_estimate or martin_triage_runs depending on whether this is new work or failed prior work.",
      annotations: {
        readOnlyHint: true,
        idempotentHint: true
      },
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          workingDirectory: {
            type: "string",
            description: "Optional repo-root override for doctor context."
          },
          runsDir: {
            type: "string",
            description: "Optional runs-root override resolved under the default Martin runs root."
          },
          engine: {
            type: "string",
            enum: [...MARTIN_ENGINE_VALUES],
            description: "Optional engine to highlight in diagnostics."
          }
        }
      },
      outputSchema: doctorOutputSchema
    },
    {
      name: "martin_plan",
      description:
        "Read-only planning step that turns an objective into bounded scope, verifier proposal, policy pack, and risk recommendation. Use for authorized software changes before preflight/run. Do not use to mutate files or replace the verifier. Next: call martin_preflight with the chosen scope, budget, and verifier.",
      annotations: {
        readOnlyHint: true,
        idempotentHint: true
      },
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          objective: { type: "string", description: "The coding objective to plan." },
          workingDirectory: {
            type: "string",
            description: "Optional repo-root override resolved under the MCP workspace root."
          },
          context: { type: "string", description: "Optional extra issue or bug context." },
          policyPack: {
            type: "string",
            enum: ["solo-founder", "startup-team", "enterprise-strict", "oss-maintainer", "security-sensitive"]
          },
          verificationPlan: { type: "array", items: { type: "string" } },
          allowedPaths: { type: "array", items: { type: "string" } },
          deniedPaths: { type: "array", items: { type: "string" } },
          maxUsd: { type: "number", exclusiveMinimum: 0 },
          maxIterations: { type: "integer", exclusiveMinimum: 0 },
          maxTokens: { type: "integer", exclusiveMinimum: 0 },
          maxMinutes: { type: "integer", exclusiveMinimum: 0 },
          maxFilesChanged: { type: "integer", exclusiveMinimum: 0 },
          maxCommands: { type: "integer", exclusiveMinimum: 0 }
        },
        required: ["objective"]
      },
      outputSchema: planOutputSchema
    },
    {
      name: "martin_preflight",
      description:
        "Read-only validation of the exact run contract before execution or spend. Use after planning and before martin_run to check engine, verifier, path scope, and budget. Do not use as execution or completion proof. Next: call martin_run if allowed, otherwise resolve the reported blocker.",
      annotations: {
        readOnlyHint: true,
        idempotentHint: true
      },
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          objective: {
            type: "string",
            description: "The coding task to validate."
          },
          workingDirectory: {
            type: "string",
            description: "Optional repo-root override resolved under the MCP workspace root."
          },
          engine: {
            type: "string",
            enum: [...MARTIN_ENGINE_VALUES],
            description: "Which agent CLI would be used. Defaults to claude."
          },
          model: {
            type: "string",
            description: "Model override passed to the CLI."
          },
          context: {
            type: "string",
            description: "Optional issue context carried into the run contract."
          },
          policyPack: {
            type: "string",
            enum: ["solo-founder", "startup-team", "enterprise-strict", "oss-maintainer", "security-sensitive"]
          },
          maxUsd: {
            type: "number",
            exclusiveMinimum: 0,
            description: "Hard budget ceiling in USD."
          },
          maxIterations: {
            type: "integer",
            exclusiveMinimum: 0,
            description: "Maximum number of loop attempts."
          },
          maxTokens: {
            type: "integer",
            exclusiveMinimum: 0,
            description: "Maximum total tokens across all attempts."
          },
          maxMinutes: {
            type: "integer",
            exclusiveMinimum: 0,
            description: "Estimated wall-clock minutes allowed for the run contract."
          },
          maxFilesChanged: {
            type: "integer",
            exclusiveMinimum: 0,
            description: "Estimated maximum files changed for the run contract."
          },
          maxCommands: {
            type: "integer",
            exclusiveMinimum: 0,
            description: "Estimated maximum commands allowed for the run contract."
          },
          verificationPlan: {
            type: "array",
            items: { type: "string" },
            description: "Commands that must all exit 0 for completion."
          },
          allowedPaths: {
            type: "array",
            items: { type: "string" },
            description: "Repo-relative path globs Martin may modify."
          },
          deniedPaths: {
            type: "array",
            items: { type: "string" },
            description: "Repo-relative path globs Martin must never modify."
          },
          workspaceId: { type: "string" },
          projectId: { type: "string" }
        },
        required: ["objective"]
      },
      outputSchema: preflightOutputSchema
    },
    {
      name: "martin_logs",
      description:
        "Read recent MartinLoop events, ledger entries, and operator control receipts for a single run. " +
        "Use to observe live or completed run activity, diagnose stuck or failed runs, or audit operator actions. " +
        "Do not use to check run completion status — use martin_get_status instead. " +
        "Do not use to retrieve verification evidence — use martin_get_verification_results instead. " +
        "This tool only reads persisted run files and does not execute commands, modify state, or contact GitHub.",
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      },
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          file: { type: "string", description: "Absolute or relative path to a loop-record.json file or run directory. Mutually exclusive with loopId and latest." },
          loopId: { type: "string", description: "MartinLoop run identifier from the run store. Mutually exclusive with file and latest." },
          runsDir: { type: "string", description: "Override the default run-store root directory. Optional; defaults to the MartinLoop runs directory." },
          latest: { const: true, description: "When true, loads the most recently updated run in the run store. Mutually exclusive with file and loopId." },
          limit: { type: "integer", minimum: 1, description: "Maximum number of log entries to return, sorted by timestamp descending. Defaults to 20." }
        },
        oneOf: [{ required: ["file"] }, { required: ["loopId"] }, { required: ["latest"] }]
      },
      outputSchema: logsOutputSchema
    },
    {
      name: "martin_pause",
      description:
        "Write a durable pause receipt for one canonical MartinLoop run. Provide exactly one selector: file, loopId, or latest; runsDir changes the run-store root, while reason and requestedBy add audit context. Use for a temporary hold before risky follow-up work. This records a request and does not kill a process; use martin_cancel to abandon work or martin_continue to resume.",
      annotations: {
        destructiveHint: true,
        idempotentHint: false
      },
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          file: { type: "string", description: "Path to one canonical run record or directory. Mutually exclusive with loopId and latest." },
          loopId: { type: "string", description: "Canonical MartinLoop run identifier. Mutually exclusive with file and latest." },
          runsDir: { type: "string", description: "Optional run-store root override used to resolve loopId or latest." },
          latest: { const: true, description: "When true, targets the latest canonical run. Mutually exclusive with file and loopId." },
          reason: { type: "string", description: "Optional non-empty reason recorded in the pause receipt." },
          requestedBy: { type: "string", description: "Optional human or runtime identity label recorded for audit context." }
        },
        oneOf: [{ required: ["file"] }, { required: ["loopId"] }, { required: ["latest"] }]
      },
      outputSchema: controlOutputSchema
    },
    {
      name: "martin_cancel",
      description:
        "Write a durable cancellation receipt for one canonical MartinLoop run. Provide exactly one selector: file, loopId, or latest; runsDir changes the run-store root, while reason and requestedBy add audit context. Use when work must be abandoned, not temporarily held. This records a request and does not kill a process; use martin_pause for a reversible hold.",
      annotations: {
        destructiveHint: true,
        idempotentHint: false
      },
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          file: { type: "string", description: "Path to one canonical run record or directory. Mutually exclusive with loopId and latest." },
          loopId: { type: "string", description: "Canonical MartinLoop run identifier. Mutually exclusive with file and latest." },
          runsDir: { type: "string", description: "Optional run-store root override used to resolve loopId or latest." },
          latest: { const: true, description: "When true, targets the latest canonical run. Mutually exclusive with file and loopId." },
          reason: { type: "string", description: "Optional non-empty reason recorded in the cancellation receipt." },
          requestedBy: { type: "string", description: "Optional human or runtime identity label recorded for audit context." }
        },
        oneOf: [{ required: ["file"] }, { required: ["loopId"] }, { required: ["latest"] }]
      },
      outputSchema: controlOutputSchema
    },
    {
      name: "martin_continue",
      description:
        "Record a durable continue or resume request for a Martin run after a human pause or approval checkpoint.",
      annotations: {
        destructiveHint: true,
        idempotentHint: false
      },
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          file: { type: "string" },
          loopId: { type: "string" },
          runsDir: { type: "string" },
          latest: { const: true },
          reason: { type: "string" },
          requestedBy: { type: "string" }
        },
        oneOf: [{ required: ["file"] }, { required: ["loopId"] }, { required: ["latest"] }]
      },
      outputSchema: controlOutputSchema
    },
    {
      name: "martin_list_runs",
      description:
        "List recent Martin runs from the run store with lightweight filters for status, lifecycle, engine metadata, and recency.",
      annotations: {
        readOnlyHint: true,
        idempotentHint: true
      },
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          runsDir: { type: "string", description: "Optional runs-root override." },
          limit: {
            type: "integer",
            minimum: 1,
            description: "Maximum number of runs to return. Defaults to 20."
          },
          status: { type: "string", description: "Filter by loop status." },
          lifecycleState: { type: "string", description: "Filter by lifecycle state." },
          adapterId: { type: "string", description: "Filter by attempt adapter ID." },
          model: { type: "string", description: "Filter by attempt model." },
          updatedAfter: {
            type: "string",
            description: "Optional ISO-8601 timestamp for recency filtering."
          }
        }
      },
      outputSchema: listRunsOutputSchema
    },
    {
      name: "martin_triage_runs",
      description:
        "Read-only prioritization of saved Martin runs that need attention. Use when the user says a prior attempt failed, asks what to fix next, or resumes an interrupted session. Do not use for a brand-new objective with no relevant run history. Next: inspect the selected run or dossier before retrying.",
      annotations: {
        readOnlyHint: true,
        idempotentHint: true
      },
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          runsDir: { type: "string", description: "Optional runs-root override." },
          limit: {
            type: "integer",
            minimum: 1,
            description: "Maximum number of runs to triage. Defaults to 20."
          },
          status: { type: "string", description: "Filter by loop status." },
          lifecycleState: {
            type: "string",
            description: "Filter by lifecycle state."
          },
          adapterId: { type: "string", description: "Filter by attempt adapter ID." },
          model: { type: "string", description: "Filter by attempt model." },
          updatedAfter: {
            type: "string",
            description: "Optional ISO-8601 timestamp for recency filtering."
          },
          includeHealthy: {
            type: "boolean",
            description: "When true, include healthy runs instead of only attention-worthy findings."
          }
        }
      },
      outputSchema: triageRunsOutputSchema
    },
    {
      name: "martin_get_run",
      description:
        "Load one Martin run and return its budget, cost, verification, artifact, and canonical path summary.",
      annotations: {
        readOnlyHint: true,
        idempotentHint: true
      },
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          file: {
            type: "string",
            description: "Path to a canonical loop-record.json, legacy file, or run-store directory."
          },
          loopId: { type: "string", description: "Loop ID under the run store." },
          runsDir: { type: "string", description: "Optional runs-root override." },
          latest: {
            const: true,
            description: "When true, loads the most recently updated loop record in the run store."
          }
        },
        oneOf: [
          { required: ["file"] },
          { required: ["loopId"] },
          { required: ["latest"] }
        ]
      },
      outputSchema: getRunOutputSchema
    },
    {
      name: "martin_get_attempt",
      description:
        "Load one Martin attempt summary with artifact directory references for a canonical run.",
      annotations: {
        readOnlyHint: true,
        idempotentHint: true
      },
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          file: {
            type: "string",
            description: "Path to a canonical loop-record.json file or run directory."
          },
          loopId: { type: "string", description: "Loop ID under the run store." },
          runsDir: { type: "string", description: "Optional runs-root override." },
          attemptIndex: {
            type: "integer",
            minimum: 1,
            description: "Attempt index to inspect. Defaults to the latest attempt."
          }
        },
        oneOf: [{ required: ["file"] }, { required: ["loopId"] }]
      },
      outputSchema: getAttemptOutputSchema
    },
    {
      name: "martin_get_verification_results",
      description:
        "Load structured verification evidence for a MartinLoop run — verifier commands, pass/fail outcomes, and contradiction signals — from stored loop events and ledger entries. " +
        "Use after a run completes to confirm whether automated verifiers passed before merging or promoting the result. " +
        "Do not use to get a merge-readiness grade — use martin_eval for a scored grade with six check dimensions. " +
        "Do not use for live run status — use martin_get_status instead. " +
        "This tool only reads persisted run files and does not execute commands, modify state, or contact GitHub.",
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      },
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          file: {
            type: "string",
            description: "Absolute or relative path to a loop-record.json file or run directory. Mutually exclusive with loopId."
          },
          loopId: { type: "string", description: "MartinLoop run identifier from the run store. Mutually exclusive with file." },
          runsDir: { type: "string", description: "Override the default run-store root directory. Optional." }
        },
        oneOf: [{ required: ["file"] }, { required: ["loopId"] }]
      },
      outputSchema: verificationResultsOutputSchema
    },
    {
      name: "martin_run_dossier",
      description:
        "Read the full structured execution dossier for one MartinLoop run, including attempts, events, artifacts, verification, integrity, cost, and related discovery surfaces. Provide exactly one selector: file, loopId, or latest; runsDir changes the run-store root. Use for comprehensive evidence review. Do not use for a compact state check; use martin_get_run, or use martin_dossier when formatted sharing output is required.",
      annotations: {
        readOnlyHint: true,
        idempotentHint: true
      },
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          file: {
            type: "string",
            description: "Path to a canonical loop-record.json, legacy file, or run-store directory. Mutually exclusive with loopId and latest."
          },
          loopId: { type: "string", description: "Loop ID under the run store. Mutually exclusive with file and latest." },
          runsDir: { type: "string", description: "Optional run-store root override used to resolve loopId or latest." },
          latest: {
            const: true,
            description: "When true, loads the most recently updated loop record. Mutually exclusive with file and loopId."
          }
        },
        oneOf: [
          { required: ["file"] },
          { required: ["loopId"] },
          { required: ["latest"] }
        ]
      },
      outputSchema: dossierOutputSchema
    },
    {
      name: "martin_dossier",
      description:
        "Read a formatted evidence summary for one MartinLoop run. Provide exactly one selector: file, loopId, or latest; runsDir changes the run-store root. Set format to json, md, or github-pr; json is the default. Use after martin_run, before merge or release claims, or when sharing what happened. Do not use as a substitute for missing verifier evidence; use martin_run_dossier for the full structured record. Next: review verification results, retry, or hand off the receipt.",
      annotations: {
        readOnlyHint: true,
        idempotentHint: true
      },
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          file: { type: "string", description: "Path to one run record or directory. Mutually exclusive with loopId and latest." },
          loopId: { type: "string", description: "MartinLoop run identifier. Mutually exclusive with file and latest." },
          runsDir: { type: "string", description: "Optional run-store root override used to resolve loopId or latest." },
          latest: { const: true, description: "When true, loads the latest run. Mutually exclusive with file and loopId." },
          format: { type: "string", enum: ["json", "md", "github-pr"], description: "Output format. Defaults to json." }
        },
        oneOf: [{ required: ["file"] }, { required: ["loopId"] }, { required: ["latest"] }]
      },
      outputSchema: dossierOutputSchema
    },
    {
      name: "martin_eval",
      description:
        "Grade a MartinLoop run across six dimensions — task completion, verifier health, diff discipline, regression risk, security risk, and reviewability — and return a scored merge-readiness verdict. " +
        "Use after a governed run completes to decide whether the result is safe to merge or promote. " +
        "Use before martin_pr_summary or martin_create_pr to confirm the run is merge-ready. " +
        "Do not use to retrieve raw verification command output — use martin_get_verification_results for that. " +
        "Do not use to review an existing PR body — use martin_review_pr instead. " +
        "This tool reads saved run evidence and inspects local git signals; it does not modify state or contact GitHub.",
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      },
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          file: { type: "string", description: "Absolute or relative path to a loop-record.json file or run directory. Mutually exclusive with loopId and latest." },
          loopId: { type: "string", description: "MartinLoop run identifier from the run store. Mutually exclusive with file and latest." },
          runsDir: { type: "string", description: "Override the default run-store root directory. Optional." },
          latest: { const: true, description: "When true, evaluates the most recently updated run in the run store. Mutually exclusive with file and loopId." }
        },
        oneOf: [{ required: ["file"] }, { required: ["loopId"] }, { required: ["latest"] }]
      },
      outputSchema: evalOutputSchema
    },
    {
      name: "martin_pr_summary",
      description:
        "Generate a GitHub-ready pull-request title and Markdown body from a completed MartinLoop run dossier, including its verification grade and score. " +
        "Use after a governed run completes when you need PR copy without creating the PR. " +
        "Use martin_create_pr instead to actually open the PR on GitHub. " +
        "Use martin_review_pr to evaluate an existing PR body against run evidence. " +
        "Use martin_eval first if you need a merge-readiness grade before generating the PR body. " +
        "This tool only reads saved run evidence and does not modify the repository or contact GitHub.",
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      },
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          file: { type: "string", description: "Absolute or relative path to a loop-record.json file or run directory. Mutually exclusive with loopId and latest." },
          loopId: { type: "string", description: "MartinLoop run identifier from the run store. Mutually exclusive with file and latest." },
          runsDir: { type: "string", description: "Override the default run-store root directory. Optional." },
          latest: { const: true, description: "When true, generates the summary for the most recently updated run. Mutually exclusive with file and loopId." },
          format: { type: "string", enum: ["json", "md", "github-pr"], description: "Dossier rendering format. Defaults to github-pr for PR body generation. Use md for plain Markdown or json for structured output." }
        },
        oneOf: [{ required: ["file"] }, { required: ["loopId"] }, { required: ["latest"] }]
      },
      outputSchema: prSummaryOutputSchema
    },
    {
      name: "martin_create_pr",
      description:
        "Create or preview a GitHub PR with a MartinLoop dossier body. Use execute=true to actually call gh.",
      annotations: {
        destructiveHint: true,
        idempotentHint: false
      },
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          file: { type: "string" },
          loopId: { type: "string" },
          runsDir: { type: "string" },
          latest: { const: true },
          format: { type: "string", enum: ["json", "md", "github-pr"] },
          title: { type: "string" },
          base: { type: "string" },
          execute: { type: "boolean" }
        },
        oneOf: [{ required: ["file"] }, { required: ["loopId"] }, { required: ["latest"] }]
      },
      outputSchema: prSummaryOutputSchema
    },
    {
      name: "martin_review_pr",
      description:
        "Review a PR body or draft against the MartinLoop run dossier and evaluation evidence, and return a verdict with specific findings. " +
        "Use when you have an existing PR body and want to check whether it accurately represents the governed run evidence. " +
        "Supply prBody to review a specific body string; omit it to evaluate the auto-generated dossier body. " +
        "Do not use to generate a PR body from scratch — use martin_pr_summary instead. " +
        "Do not use to open or create a PR — use martin_create_pr instead. " +
        "This tool only reads saved run evidence and does not modify the repository or contact GitHub.",
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      },
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          file: { type: "string", description: "Absolute or relative path to a loop-record.json file or run directory. Mutually exclusive with loopId and latest." },
          loopId: { type: "string", description: "MartinLoop run identifier from the run store. Mutually exclusive with file and latest." },
          runsDir: { type: "string", description: "Override the default run-store root directory. Optional." },
          latest: { const: true, description: "When true, reviews against the most recently updated run. Mutually exclusive with file and loopId." },
          format: { type: "string", enum: ["json", "md", "github-pr"], description: "Dossier format used when generating the reference body for comparison. Defaults to github-pr." },
          prBody: { type: "string", description: "The PR body text to review. If omitted, the auto-generated dossier body is evaluated instead." }
        },
        oneOf: [{ required: ["file"] }, { required: ["loopId"] }, { required: ["latest"] }]
      },
      outputSchema: prReviewOutputSchema
    },
    {
      name: "martin_estimate",
      description:
        "Read-only cost, route, and pre-work burn estimate for a software objective. Use before planning/preflight when a change may spend agent time or exceed budget. Do not use for casual questions or as permission to execute. Next: call martin_plan if the estimate is acceptable, or ask for consent if budget/risk is high.",
      annotations: {
        readOnlyHint: true,
        idempotentHint: true
      },
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          objective: {
            type: "string",
            description: "The coding task to estimate."
          },
          engine: {
            type: "string",
            enum: [...MARTIN_ENGINE_VALUES],
            description: "Which agent CLI would be used. Defaults to claude."
          },
          budgetUsd: {
            type: "number",
            exclusiveMinimum: 0,
            description: "Budget ceiling for estimation. Defaults to 5."
          },
          fileScope: {
            type: "array",
            items: { type: "string" },
            description: "Optional file paths to scope the estimate."
          },
          workingDirectory: {
            type: "string",
            description: "Optional workspace path for recording the estimate receipt against the same task root you plan to run."
          }
        },
        required: ["objective"]
      },
      outputSchema: {
        type: "object",
        additionalProperties: true,
        properties: {
          objective: { type: "string" },
          engine: { type: "string" },
          budgetUsd: { type: "number" },
          selectedMode: { type: "string" },
          confidence: { type: "number" },
          expectedCostUsd: { type: "number" },
          expectedPreworkBurnPct: { type: "number" },
          reason: { type: "array", items: { type: "string" } },
          blockedSteps: { type: "array", items: { type: "string" } },
          compressed: { type: "boolean" },
          compressionSummary: { type: "string" },
          recommendedBudgetUsd: { type: "number" }
        },
        required: ["objective", "engine", "budgetUsd", "selectedMode", "confidence", "expectedCostUsd", "expectedPreworkBurnPct", "reason"]
      }
    },
    ...buildArcadeToolDefinitions(server.getClientCapabilities())
  ].filter((tool) => shouldExposeMartinTool(tool.name, toolProfile))
  }));

  server.setRequestHandler(ListResourcesRequestSchema, () => {
  const listed = listMartinResources();
  const arcade = listArcadeResources(server.getClientCapabilities());
  return { resources: [...listed.resources, ...arcade.resources] };
  });

  server.setRequestHandler(ListResourceTemplatesRequestSchema, () => ({
  ...listMartinResourceTemplates()
  }));

  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
  try {
    if (request.params.uri === MARTIN_ARCADE_RESOURCE_URI) {
      return await readArcadeResource(request.params.uri);
    }
    return await readMartinResource({ uri: request.params.uri });
  } catch (error) {
    if (error instanceof MartinToolError) {
      throw error;
    }
    throw new Error(sanitizeToolErrorMessage(error));
  }
  });

  server.setRequestHandler(ListPromptsRequestSchema, () => ({
  ...listMartinPrompts()
  }));

  server.setRequestHandler(GetPromptRequestSchema, async (request) => {
  try {
    return await getMartinPrompt({
      name: request.params.name,
      arguments: request.params.arguments
    });
  } catch (error) {
    if (error instanceof MartinToolError) {
      throw error;
    }
    throw new Error(sanitizeToolErrorMessage(error));
  }
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    if (name === "martin_arcade") {
      const available = supportsMartinArcadeApp(server.getClientCapabilities());
      return createToolSuccessResult(
        {
          available,
          resourceUri: available ? MARTIN_ARCADE_RESOURCE_URI : null
        },
        MARTIN_ARCADE_FALLBACK_TEXT,
        { human: MARTIN_ARCADE_FALLBACK_TEXT }
      );
    }

    if (name === "martin_arcade_status") {
      const input = args ?? {};
      if (!input || typeof input !== "object" || Array.isArray(input)) {
        throw new MartinToolError("invalid_arguments", "Arcade status input must be an object.", {
          category: "invalid_input"
        });
      }
      const keys = Object.keys(input);
      if (keys.some((key) => key !== "loopId") || ("loopId" in input && typeof input.loopId !== "string")) {
        throw new MartinToolError("invalid_arguments", "Arcade status accepts only an optional loopId.", {
          category: "invalid_input"
        });
      }
      const output = await readArcadeStatus(input as { loopId?: string });
      return createToolSuccessResult(
        output,
        `MartinLoop Arcade status for ${output.loopId}: ${output.displayOutcome ?? output.lifecycleState}.`
      );
    }

    if (name === "martin_run") {
      const input = validateToolInput("martin_run", args) as Parameters<typeof runLoopTool>[0];
      const runsRoot = resolveRunsRoot(process.env);
      const workingDirectory = input.workingDirectory ?? resolveSafeRepoRoot();
      const receiptScope: ReceiptScope = {
        invocationRoot: resolveSafeRepoRoot(),
        workingDirectory,
        repoRoot: workingDirectory,
        runsRoot
      };
      const gate = await evaluateMcpRunGate({
        runsRoot,
        workingDirectory,
        objective: input.objective,
        engine: input.engine,
        verificationPlan: input.verificationPlan,
        receiptScope,
        allowedPaths: input.allowedPaths,
        deniedPaths: input.deniedPaths,
        budget: normalizeRunBudget(input)
      });
      if (!gate.allowed) {
        throw new MartinToolError("policy_blocked", gate.summary, {
          category: "policy_blocked",
          suggestion: gate.nextAction,
          retryable: false,
          details: {
            missingSteps: gate.missingSteps,
            receiptScope
          }
        });
      }
      const output = await runLoopTool(input);
      return createToolSuccessResult(
        output,
        [
          `Run ${output.loopId} is ${output.status}/${output.lifecycleState}`,
          `after ${output.attempts} attempt(s); spend ${output.costUsd.toFixed(2)} USD.`,
          `Execution mode: ${output.executionMode}; governance claim eligible:`,
          `${output.governanceClaimEligible ? "yes" : "no"}.`
        ].join(" ")
      );
    }

    if (name === "martin_inspect") {
      const input = validateToolInput("martin_inspect", args) as Parameters<typeof inspectLoopTool>[0];
      const output = await inspectLoopTool(input);
      return createToolSuccessResult(
        output,
        `Inspected ${output.loopCount} run(s) from ${output.source}; total actual spend ${output.portfolio.totalActualUsd.toFixed(2)} USD.`
      );
    }

    if (name === "martin_status") {
      const input = validateToolInput("martin_status", args) as Parameters<typeof getStatusTool>[0];
      const output = await getStatusTool(input);
      return createToolSuccessResult(
        output,
        `Loop ${output.loopId} is ${output.status}/${output.lifecycleState}; pressure is ${output.pressure} with ${output.remainingBudgetUsd.toFixed(2)} USD remaining.`
      );
    }

    if (name === "martin_doctor") {
      const input = validateToolInput("martin_doctor", args) as Parameters<typeof martinDoctorTool>[0];
      const output = await martinDoctorTool(input);
      await recordMcpWorkflowStep({
        runsRoot: output.environment.runsRoot,
        step: "doctor",
        workingDirectory: output.environment.workingDirectory,
        engine: input.engine,
        receiptScope: output.receiptScope
      }).catch(() => {});
      return createToolSuccessResult(output, output.summary);
    }

    if (name === "martin_plan") {
      const input = validateToolInput("martin_plan", args) as Parameters<typeof martinPlanTool>[0];
      const output = await martinPlanTool(input);
      await recordMcpWorkflowStep({
        runsRoot: resolveRunsRoot(process.env),
        step: "plan",
        workingDirectory: output.workingDirectory,
        objective: output.objective,
        receiptScope: {
          invocationRoot: resolveSafeRepoRoot(),
          workingDirectory: output.workingDirectory,
          repoRoot: output.workingDirectory,
          runsRoot: resolveRunsRoot(process.env)
        }
      }).catch(() => {});
      return createToolSuccessResult(
        output,
        `Plan ready for ${output.objective} with ${output.risk.level} risk and ${output.approvalRecommendation.replace(/_/gu, " ")} approval.`
      );
    }

    if (name === "martin_preflight") {
      const input = validateToolInput("martin_preflight", args) as Parameters<typeof martinPreflightTool>[0];
      const output = await martinPreflightTool(input);
      if (output.ok) {
        await recordMcpWorkflowStep({
          runsRoot: output.execution.runsRoot,
          step: "preflight",
          workingDirectory: output.normalized.workingDirectory,
          objective: output.normalized.objective,
          engine: output.normalized.engine,
          verificationPlan: output.normalized.verificationPlan,
          receiptScope: output.receiptScope,
          allowedPaths: output.normalized.allowedPaths,
          deniedPaths: output.normalized.deniedPaths,
          budget: output.normalized.budget
        }).catch(() => {});
      }
      const prefPlanView = {
        ready: output.ok,
        task: output.normalized.objective,
        engine: output.normalized.engine,
        mode: output.readiness.liveMode ? ("live" as const) : ("proof" as const),
        budget: output.normalized.budget,
        verifier: output.normalized.verificationPlan,
        receiptScope: output.receiptScope,
        policyProfile: output.policy.name,
        blockingIssues: output.ok ? [] : [output.summary],
        warnings: output.warnings,
        stages: [] as ReturnType<typeof buildGovernedPlanStages>
      };
      prefPlanView.stages = buildGovernedPlanStages(prefPlanView);
      return createToolSuccessResult(output, output.summary, {
        human: renderGovernedRunPlanMarkdown(prefPlanView)
      });
    }

    if (name === "martin_logs") {
      const input = validateToolInput("martin_logs", args) as Parameters<typeof martinLogsTool>[0];
      const output = await martinLogsTool(input);
      return createToolSuccessResult(
        output,
        `Loaded ${output.logCount} log entries for Martin run ${output.loopId}.`
      );
    }

    if (name === "martin_pause") {
      const input = validateToolInput("martin_pause", args) as Parameters<typeof createRunControlReceipt>[1];
      const output = await createRunControlReceipt("pause", input);
      return createToolSuccessResult(output, output.summary);
    }

    if (name === "martin_cancel") {
      const input = validateToolInput("martin_cancel", args) as Parameters<typeof createRunControlReceipt>[1];
      const output = await createRunControlReceipt("cancel", input);
      return createToolSuccessResult(output, output.summary);
    }

    if (name === "martin_continue") {
      const input = validateToolInput("martin_continue", args) as Parameters<typeof createRunControlReceipt>[1];
      const output = await createRunControlReceipt("continue", input);
      return createToolSuccessResult(output, output.summary);
    }

    if (name === "martin_list_runs") {
      const input = validateToolInput("martin_list_runs", args) as Parameters<typeof martinListRunsTool>[0];
      const output = await martinListRunsTool(input);
      return createToolSuccessResult(
        output,
        `Listed ${output.loopCount} Martin run(s) from ${output.runsRoot}.`
      );
    }

    if (name === "martin_triage_runs") {
      const input = validateToolInput("martin_triage_runs", args) as Parameters<typeof martinTriageRunsTool>[0];
      const output = await martinTriageRunsTool(input);
      return createToolSuccessResult(
        output,
        `Triaged ${output.evaluatedRuns} Martin run(s) and found ${output.findingCount} attention item(s).`
      );
    }

    if (name === "martin_get_run") {
      const input = validateToolInput("martin_get_run", args) as Parameters<typeof martinGetRunTool>[0];
      const output = await martinGetRunTool(input);
      return createToolSuccessResult(
        output,
        `Loaded Martin run ${output.loop.loopId} from ${output.source}.`
      );
    }

    if (name === "martin_get_attempt") {
      const input = validateToolInput("martin_get_attempt", args) as Parameters<typeof martinGetAttemptTool>[0];
      const output = await martinGetAttemptTool(input);
      return createToolSuccessResult(
        output,
        `Loaded attempt ${output.attempt.index} for Martin run ${output.loop.loopId}.`
      );
    }

    if (name === "martin_get_verification_results") {
      const input = validateToolInput("martin_get_verification_results", args) as Parameters<typeof martinGetVerificationResultsTool>[0];
      const output = await martinGetVerificationResultsTool(input);
      return createToolSuccessResult(
        output,
        `Verification for ${output.loop.loopId} is ${output.verification.status}.`
      );
    }

    if (name === "martin_run_dossier") {
      const input = validateToolInput("martin_run_dossier", args) as Parameters<typeof martinRunDossierTool>[0];
      const output = await martinRunDossierTool(input);
      return createToolSuccessResult(
        output,
        `Dossier ready for Martin run ${output.loop.loopId} with ${output.attempts.length} attempt(s).`,
        { human: renderVerifiedHandoffMarkdown(output.verifiedHandoff) }
      );
    }

    if (name === "martin_dossier") {
      const input = validateToolInput("martin_dossier", args) as Parameters<typeof martinRunDossierTool>[0];
      const output = await martinRunDossierTool(input);
      return createToolSuccessResult(
        output,
        `Dossier ready for Martin run ${output.loop.loopId} in ${output.format} format.`,
        { human: renderVerifiedHandoffMarkdown(output.verifiedHandoff) }
      );
    }

    if (name === "martin_eval") {
      const input = validateToolInput("martin_eval", args) as Parameters<typeof martinEvalTool>[0];
      const output = await martinEvalTool(input);
      return createToolSuccessResult(
        output,
        `Evaluation for ${output.loopId}: ${output.grade} (${output.score}).`
      );
    }

    if (name === "martin_pr_summary") {
      const input = validateToolInput("martin_pr_summary", args) as Parameters<typeof martinPrSummaryTool>[0];
      const output = await martinPrSummaryTool(input);
      return createToolSuccessResult(
        output,
        `PR summary ready for Martin run ${output.loopId}.`
      );
    }

    if (name === "martin_create_pr") {
      const input = validateToolInput("martin_create_pr", args) as Parameters<typeof martinCreatePrTool>[0];
      const output = await martinCreatePrTool(input);
      return createToolSuccessResult(
        output,
        output.created
          ? `Created PR for Martin run ${output.loopId}.`
          : `PR preview ready for Martin run ${output.loopId}.`
      );
    }

    if (name === "martin_review_pr") {
      const input = validateToolInput("martin_review_pr", args) as Parameters<typeof martinReviewPrTool>[0];
      const output = await martinReviewPrTool(input);
      return createToolSuccessResult(
        output,
        `PR review verdict for ${output.loopId}: ${output.verdict}.`
      );
    }

    if (name === "martin_estimate") {
      const input = validateToolInput("martin_estimate", args) as {
        objective: string;
        engine?: string;
        budgetUsd?: number;
        fileScope?: string[];
        workingDirectory?: string;
      };
      const objective = input.objective;
      const engine = input.engine ?? "claude";
      const budgetUsd = input.budgetUsd ?? 5;
      const fileScope = input.fileScope ?? [];
      const runsRoot = resolveRunsRoot(process.env);
      const workingDirectory = input.workingDirectory ?? resolveSafeRepoRoot();
      const route = classifyRoute({
        objective,
        verificationPlan: [],
        budgetUsd,
        allowedPaths: fileScope,
        scopedFileCount: fileScope.length > 0 ? fileScope.length : undefined
      });
      const recommendedBudgetUsd = route.selectedMode === "direct"
        ? Math.max(2, Math.round(route.expectedCostUsd * 3 * 100) / 100)
        : Math.max(5, Math.round(route.expectedCostUsd * 2 * 100) / 100);
      const output = {
        objective,
        engine,
        budgetUsd,
        selectedMode: route.selectedMode,
        confidence: route.confidence,
        expectedCostUsd: route.expectedCostUsd,
        expectedPreworkBurnPct: route.expectedPreworkBurnPct,
        reason: route.reason,
        blockedSteps: route.blockedSteps,
        compressed: route.compressed,
        ...(route.compressionSummary ? { compressionSummary: route.compressionSummary } : {}),
        recommendedBudgetUsd,
        modelAuthority: "agent_or_provider_default"
      };
      await recordMcpWorkflowStep({
        runsRoot,
        step: "estimate",
        workingDirectory,
        objective,
        engine,
        receiptScope: {
          invocationRoot: resolveSafeRepoRoot(),
          workingDirectory,
          repoRoot: workingDirectory,
          runsRoot
        }
      }).catch(() => {});
      return createToolSuccessResult(
        output,
        `Estimate: ${route.selectedMode} route, ~$${route.expectedCostUsd.toFixed(2)} expected cost, ${route.expectedPreworkBurnPct}% pre-work burn. Model authority remains with the agent/provider. Recommended budget: $${recommendedBudgetUsd.toFixed(2)}.`
      );
    }

    return createToolErrorResult(toToolFailure(new Error(`Unknown tool: ${name}`)));
  } catch (error) {
    return createToolErrorResult(toToolFailure(error));
  }
  });

  return server;
}

function normalizeRunBudget(input: Parameters<typeof runLoopTool>[0]): LoopBudget {
  return normalizeLoopBudget({
    maxUsd: input.maxUsd,
    maxIterations: input.maxIterations,
    maxTokens: input.maxTokens
  });
}

export async function connectMartinMcpStdioServer(options: { toolProfile?: MartinMcpToolProfile } = {}) {
  const server = createMartinMcpServer({
    ...(options.toolProfile ? { toolProfile: options.toolProfile } : {})
  });
  const transport = new StdioServerTransport();
  await server.connect(transport);
  return server;
}

export interface MartinMcpHttpServerOptions {
  host?: string;
  port?: number;
  path?: string;
  toolProfile?: MartinMcpToolProfile;
}

export interface MartinMcpHttpServerHandle {
  server: NodeHttpServer;
  host: string;
  port: number;
  path: string;
  endpoint: string;
  close: () => Promise<void>;
}

export function parseMartinMcpServerArgs(argv: string[]): { transport: "stdio"; toolProfile?: MartinMcpToolProfile } | {
  transport: "http";
  host: string;
  port: number;
  path: string;
  toolProfile?: MartinMcpToolProfile;
} {
  let transport: "stdio" | "http" = "stdio";
  let host = "127.0.0.1";
  let port = 3033;
  let path = "/mcp";
  let toolProfile: MartinMcpToolProfile | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--http") {
      transport = "http";
      continue;
    }
    if (token === "--tool-profile") {
      const next = argv[index + 1];
      if (next !== "full" && next !== "directory") {
        throw new Error(`Invalid --tool-profile value '${next ?? ""}'.`);
      }
      toolProfile = next;
      index += 1;
      continue;
    }
    if (token === "--port") {
      const next = argv[index + 1];
      const parsed = Number(next);
      if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65535) {
        throw new Error(`Invalid --port value '${next ?? ""}'.`);
      }
      port = parsed;
      index += 1;
      continue;
    }
    if (token === "--host") {
      const next = argv[index + 1];
      if (!next) {
        throw new Error("Missing value for --host.");
      }
      host = next;
      index += 1;
      continue;
    }
    if (token === "--path") {
      const next = argv[index + 1];
      if (!next || !next.startsWith("/")) {
        throw new Error("MCP HTTP path must start with '/'.");
      }
      path = next;
      index += 1;
    }
  }

  return transport === "http"
    ? { transport, host, port, path, ...(toolProfile ? { toolProfile } : {}) }
    : { transport, ...(toolProfile ? { toolProfile } : {}) };
}

export async function connectMartinMcpHttpServer(
  options: MartinMcpHttpServerOptions = {}
): Promise<MartinMcpHttpServerHandle> {
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? 3033;
  const path = options.path ?? "/mcp";

  const mcpServer = createMartinMcpServer({
    ...(options.toolProfile ? { toolProfile: options.toolProfile } : {})
  });
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined
  });
  await mcpServer.connect(transport);

  const httpServer = createHttpServer(async (req, res) => {
    try {
      const requestUrl = new URL(req.url ?? "/", `http://${req.headers.host ?? `${host}:${port}`}`);
      if (requestUrl.pathname !== path) {
        res.statusCode = 404;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ error: "not_found", path: requestUrl.pathname }));
        return;
      }

      if (req.method === "POST") {
        const parsedBody = await readJsonBody(req, res);
        if (res.writableEnded) {
          return;
        }
        await transport.handleRequest(req, res, parsedBody);
        return;
      }

      if (req.method === "GET" || req.method === "DELETE") {
        await transport.handleRequest(req, res);
        return;
      }

      res.statusCode = 405;
      res.setHeader("allow", "GET, POST, DELETE");
      res.end();
    } catch (error) {
      if (!res.headersSent) {
        res.statusCode = 500;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ error: "internal_error", message: (error as Error).message }));
      }
    }
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(port, host, () => {
      httpServer.off("error", reject);
      resolve();
    });
  });

  const address = httpServer.address();
  const resolvedPort = typeof address === "object" && address ? address.port : port;

  return {
    server: httpServer,
    host,
    port: resolvedPort,
    path,
    endpoint: `http://${host}:${resolvedPort}${path}`,
    close: async () => {
      await transport.close();
      await new Promise<void>((resolve) => {
        httpServer.close(() => resolve());
      });
    }
  };
}

export function isDirectExecutionEntry(
  entryPath: string | undefined,
  moduleUrl: string = import.meta.url
): boolean {
  if (typeof entryPath !== "string" || entryPath.length === 0) {
    return false;
  }

  const modulePath = realPathOrResolved(fileURLToPath(moduleUrl));
  const resolvedEntryPath = realPathOrResolved(entryPath);
  return modulePath === resolvedEntryPath;
}

function isDirectExecution(): boolean {
  return isDirectExecutionEntry(process.argv[1]);
}

function realPathOrResolved(filePath: string): string {
  try {
    return realpathSync.native(filePath);
  } catch {
    return path.resolve(filePath);
  }
}

if (isDirectExecution()) {
  const startup = parseMartinMcpServerArgs(process.argv.slice(2));
  if (startup.transport === "http") {
    await connectMartinMcpHttpServer(startup);
  } else {
    await connectMartinMcpStdioServer({ toolProfile: startup.toolProfile });
  }
}

async function readJsonBody(
  req: IncomingMessage,
  res: ServerResponse
): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) {
    return undefined;
  }
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    res.statusCode = 400;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ error: "invalid_json" }));
    return undefined;
  }
}
