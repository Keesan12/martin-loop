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

import { fileURLToPath, pathToFileURL } from "node:url";
import { realpathSync } from "node:fs";
import path from "node:path";

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
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
import { getMartinPrompt, listMartinPrompts } from "./prompts.js";
import {
  listMartinResources,
  listMartinResourceTemplates,
  readMartinResource
} from "./resources.js";
import { martinDoctorTool } from "./tools/doctor.js";
import { martinGetAttemptTool } from "./tools/get-attempt.js";
import { martinGetRunTool } from "./tools/get-run.js";
import { martinGetVerificationResultsTool } from "./tools/get-verification-results.js";
import { getStatusTool } from "./tools/get-status.js";
import { inspectLoopTool } from "./tools/inspect-loop.js";
import { martinListRunsTool } from "./tools/list-runs.js";
import { martinPreflightTool } from "./tools/preflight.js";
import { martinRunDossierTool } from "./tools/run-dossier.js";
import { martinTriageRunsTool } from "./tools/triage-runs.js";
import { runLoopTool } from "./tools/run-loop.js";
import { createToolErrorResult, createToolSuccessResult } from "./tools/tool-response.js";
import { MartinToolError, toToolFailure } from "./tools/tool-errors.js";
import { sanitizeToolErrorMessage, validateToolInput } from "./server-validation.js";

const stringArraySchema = {
  type: "array",
  items: { type: "string" }
} as const;

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
    "remainingIterations",
    "remainingTokens"
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
  required: ["maxUsd", "softLimitUsd", "maxIterations", "maxTokens"]
} as const;

const costSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    actualUsd: { type: "number" },
    avoidedUsd: { type: "number" },
    tokensIn: { type: "integer" },
    tokensOut: { type: "integer" }
  },
  required: ["actualUsd", "avoidedUsd", "tokensIn", "tokensOut"]
} as const;

const verificationSchema = {
  type: "object",
  additionalProperties: true,
  properties: {
    status: { type: "string", enum: ["passed", "failed", "unavailable"] },
    eventCount: { type: "integer" },
    ledgerEventCount: { type: "integer" },
    latestAttemptIndex: { type: "integer" },
    completedAt: { type: "string" },
    summary: { type: "string" },
    warnings: stringArraySchema
  },
  required: ["status", "eventCount", "ledgerEventCount", "warnings"]
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
    "remainingTokens",
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
    "remainingTokens",
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
        mode: { type: "string", enum: ["live", "stub"] },
        liveMode: { type: "boolean" }
      },
      required: ["workspaceRoot", "workingDirectory", "runsRoot", "mode", "liveMode"]
    },
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
  required: ["status", "summary", "server", "environment", "engines", "runStore", "warnings"]
} as const;

const preflightOutputSchema = {
  type: "object",
  additionalProperties: true,
  properties: {
    ok: { type: "boolean" },
    summary: { type: "string" },
    warnings: stringArraySchema,
    readiness: {
      type: "object",
      additionalProperties: false,
      properties: {
        mode: { type: "string", enum: ["live", "stub"] },
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
  required: ["ok", "summary", "warnings", "readiness", "normalized", "execution"]
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

export function createMartinMcpServer(serverInfo?: {
  name?: string;
  version?: string;
}) {
  const server = new Server(
    {
      name: serverInfo?.name ?? "martin-loop",
      version: serverInfo?.version ?? MARTIN_MCP_PACKAGE_VERSION
    },
    { capabilities: { tools: {}, resources: {}, prompts: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, () => ({
  tools: [
    {
      name: "martin_run",
      description:
        "Execute a governed Martin Loop run on a coding task and return the run summary, spend, artifact rollup, and verification state.",
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
            enum: ["claude", "codex"],
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
        "Return the current budget and cost state of a Martin loop record.",
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
              "Optional path under the Martin runs root to a loop-record.json file, a legacy .jsonl file, or a run-store directory."
          },
          loopId: {
            type: "string",
            description: "Loop ID resolved as <runsDir>/<loopId>/loop-record.json."
          },
          runsDir: {
            type: "string",
            description: "Optional runs-root override resolved under the default Martin runs root."
          },
          latest: {
            const: true,
            description: "When true, loads the most recently updated loop record in the runs directory."
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
        "Read-only environment and run-store diagnostics for the Martin MCP server.",
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
            enum: ["claude", "codex"],
            description: "Optional engine to highlight in diagnostics."
          }
        }
      },
      outputSchema: doctorOutputSchema
    },
    {
      name: "martin_preflight",
      description:
        "Read-only validation of a planned Martin run before any execution or spend.",
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
            enum: ["claude", "codex"],
            description: "Which agent CLI would be used. Defaults to claude."
          },
          model: {
            type: "string",
            description: "Model override passed to the CLI."
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
        "Prioritize Martin runs that need operator or agent attention based on verification, lifecycle, and budget pressure.",
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
        "Load verification evidence for a Martin run from stored loop events and ledger entries.",
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
          runsDir: { type: "string", description: "Optional runs-root override." }
        },
        oneOf: [{ required: ["file"] }, { required: ["loopId"] }]
      },
      outputSchema: verificationResultsOutputSchema
    },
    {
      name: "martin_run_dossier",
      description:
        "Return the full governed execution dossier for one Martin run, including attempts, events, artifacts, and related discovery surfaces.",
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
      outputSchema: dossierOutputSchema
    }
  ]
  }));

  server.setRequestHandler(ListResourcesRequestSchema, () => ({
  ...listMartinResources()
  }));

  server.setRequestHandler(ListResourceTemplatesRequestSchema, () => ({
  ...listMartinResourceTemplates()
  }));

  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
  try {
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
    if (name === "martin_run") {
      const input = validateToolInput("martin_run", args) as Parameters<typeof runLoopTool>[0];
      const output = await runLoopTool(input);
      return createToolSuccessResult(
        output,
        `Run ${output.loopId} is ${output.status}/${output.lifecycleState} after ${output.attempts} attempt(s); spend ${output.costUsd.toFixed(2)} USD.`
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
      return createToolSuccessResult(output, output.summary);
    }

    if (name === "martin_preflight") {
      const input = validateToolInput("martin_preflight", args) as Parameters<typeof martinPreflightTool>[0];
      const output = await martinPreflightTool(input);
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
        `Dossier ready for Martin run ${output.loop.loopId} with ${output.attempts.length} attempt(s).`
      );
    }

    return createToolErrorResult(toToolFailure(new Error(`Unknown tool: ${name}`)));
  } catch (error) {
    return createToolErrorResult(toToolFailure(error));
  }
  });

  return server;
}

export async function connectMartinMcpStdioServer() {
  const server = createMartinMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  return server;
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
  await connectMartinMcpStdioServer();
}
