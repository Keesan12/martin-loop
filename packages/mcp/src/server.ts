#!/usr/bin/env node

// SPDX-FileCopyrightText: MartinLoop contributors
//
// SPDX-License-Identifier: Apache-2.0

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

import { resolveRunsRoot } from "@martin/core";
import type { LoopBudget, ReceiptScope } from "@martin/contracts";
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
import { MartinToolError, toToolFailure } from "./tools/tool-errors.js";
import { normalizeLoopBudget } from "./tools/workflow-governance.js";
import { resolveSafeRepoRoot, sanitizeToolErrorMessage, validateToolInput } from "./server-validation.js";
import { evaluateMcpRunGate, recordMcpWorkflowStep } from "./workflow-state.js";

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
  additionalProperties: true
} as const;

const controlOutputSchema = {
  type: "object",
  additionalProperties: true
} as const;

const evalOutputSchema = {
  type: "object",
  additionalProperties: true
} as const;

const prSummaryOutputSchema = {
  type: "object",
  additionalProperties: true
} as const;

const prReviewOutputSchema = {
  type: "object",
  additionalProperties: true
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
        "Execute a governed Martin Loop run on a coding task and return the run summary, spend, artifact rollup, and verification state. This hard-blocks until martin_doctor, martin_estimate, martin_plan, and martin_preflight receipts exist for the same task.",
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
        "Read-only environment and run-store diagnostics for the Martin MCP server. This is the expected first call before governed work begins.",
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
        "Read-only planning step that turns an objective into a scoped implementation plan, verifier proposal, policy pack, and risk recommendation. Use before preflight and before any real coding run.",
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
        "Read-only validation of a planned Martin run before any execution or spend. This is the last required step before martin_run.",
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
        "Read recent Martin loop events, ledger entries, and operator control receipts for live observability.",
      annotations: {
        readOnlyHint: true,
        idempotentHint: true
      },
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          file: { type: "string" },
          loopId: { type: "string" },
          runsDir: { type: "string" },
          latest: { const: true },
          limit: { type: "integer", minimum: 1 }
        },
        oneOf: [{ required: ["file"] }, { required: ["loopId"] }, { required: ["latest"] }]
      },
      outputSchema: logsOutputSchema
    },
    {
      name: "martin_pause",
      description:
        "Record a durable pause request for a Martin run so humans and runtimes can see that execution should pause before risky follow-up work.",
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
      name: "martin_cancel",
      description:
        "Record a durable cancellation request for a Martin run. This writes a control receipt; it does not silently kill a process without evidence.",
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
    },
    {
      name: "martin_dossier",
      description:
        "Alias for martin_run_dossier with support for JSON, Markdown, or GitHub PR formatting. Use after martin_run to understand what happened and whether the result is actually safe to trust.",
      annotations: {
        readOnlyHint: true,
        idempotentHint: true
      },
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          file: { type: "string" },
          loopId: { type: "string" },
          runsDir: { type: "string" },
          latest: { const: true },
          format: { type: "string", enum: ["json", "md", "github-pr"] }
        },
        oneOf: [{ required: ["file"] }, { required: ["loopId"] }, { required: ["latest"] }]
      },
      outputSchema: dossierOutputSchema
    },
    {
      name: "martin_eval",
      description:
        "Grade a Martin run for task completion, verifier health, diff discipline, risk, and reviewability.",
      annotations: {
        readOnlyHint: true,
        idempotentHint: true
      },
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          file: { type: "string" },
          loopId: { type: "string" },
          runsDir: { type: "string" },
          latest: { const: true }
        },
        oneOf: [{ required: ["file"] }, { required: ["loopId"] }, { required: ["latest"] }]
      },
      outputSchema: evalOutputSchema
    },
    {
      name: "martin_pr_summary",
      description:
        "Generate a PR title and body with a MartinLoop dossier block for a completed run.",
      annotations: {
        readOnlyHint: true,
        idempotentHint: true
      },
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          file: { type: "string" },
          loopId: { type: "string" },
          runsDir: { type: "string" },
          latest: { const: true },
          format: { type: "string", enum: ["json", "md", "github-pr"] }
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
        "Review a PR or PR draft against the Martin dossier and evaluation evidence.",
      annotations: {
        readOnlyHint: true,
        idempotentHint: true
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
          prBody: { type: "string" }
        },
        oneOf: [{ required: ["file"] }, { required: ["loopId"] }, { required: ["latest"] }]
      },
      outputSchema: prReviewOutputSchema
    },
    {
      name: "martin_estimate",
      description:
        "Estimate the cost, recommended route, and Pre Work Burn for an objective without spending anything. Use before martin_run to understand what a task will cost.",
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
      await recordMcpWorkflowStep({
        runsRoot: output.environment.runsRoot,
        step: "doctor",
        workingDirectory: output.environment.workingDirectory,
        engine: input.engine,
        receiptScope: output.receiptScope
      });
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
      });
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
        });
      }
      return createToolSuccessResult(output, output.summary);
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
        `Dossier ready for Martin run ${output.loop.loopId} with ${output.attempts.length} attempt(s).`
      );
    }

    if (name === "martin_dossier") {
      const input = validateToolInput("martin_dossier", args) as Parameters<typeof martinRunDossierTool>[0];
      const output = await martinRunDossierTool(input);
      return createToolSuccessResult(
        output,
        `Dossier ready for Martin run ${output.loop.loopId} in ${output.format} format.`
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
        engine?: MartinEngine;
        budgetUsd?: number;
        fileScope?: string[];
      };
      const objective = input.objective;
      const engine = input.engine ?? "claude";
      const budgetUsd = input.budgetUsd ?? 5;
      const fileScope = input.fileScope ?? [];
      const workingDirectory = resolveSafeRepoRoot();
      const runsRoot = resolveRunsRoot(process.env);
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
        recommendedModelTier: route.recommendedModelTier,
        estimatedSavingVsSonnetUsd: route.estimatedSavingVsSonnetUsd
      };
      await recordMcpWorkflowStep({
        runsRoot,
        step: "estimate",
        workingDirectory,
        objective,
        engine
      });
      return createToolSuccessResult(
        output,
        `Estimate: ${route.selectedMode} route (${route.recommendedModelTier}), ~$${route.expectedCostUsd.toFixed(2)} expected cost, ${route.expectedPreworkBurnPct}% pre-work burn. Recommended budget: $${recommendedBudgetUsd.toFixed(2)}.`
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
