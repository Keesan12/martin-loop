#!/usr/bin/env node

/**
 * Martin Loop MCP Server
 *
 * Exposes a governed local MCP cockpit over stdio:
 *   martin_doctor     — inspect local readiness and run-store health
 *   martin_preflight  — normalize a proposed run contract before execution
 *   martin_run        — execute a full Martin loop on a coding task
 *   martin_inspect    — summarise a saved loop record file
 *   martin_status     — return cost and pressure state from a loop record
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

import { createRequire } from "node:module";

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

import { martinDoctorTool } from "./tools/doctor.js";
import { getAttemptTool } from "./tools/get-attempt.js";
import { getRunTool } from "./tools/get-run.js";
import { getStatusTool } from "./tools/get-status.js";
import { getVerificationResultsTool } from "./tools/get-verification-results.js";
import { inspectLoopTool } from "./tools/inspect-loop.js";
import { listRunsTool } from "./tools/list-runs.js";
import { martinPreflightTool } from "./tools/preflight.js";
import { getMartinPrompt, listMartinPrompts } from "./prompts.js";
import { listMartinResourceTemplates, listMartinResources, readMartinResource } from "./resources.js";
import { runLoopTool } from "./tools/run-loop.js";
import { runDossierTool } from "./tools/run-dossier.js";
import { sanitizeToolErrorMessage, validateToolInput } from "./server-validation.js";

const require = createRequire(import.meta.url);
const packageJson = require("../package.json") as { version: string };

const server = new Server(
  { name: "martin-loop", version: packageJson.version },
  { capabilities: { tools: {}, resources: {}, prompts: {} } }
);

// ---------------------------------------------------------------------------
// Tool manifest
// ---------------------------------------------------------------------------

server.setRequestHandler(ListToolsRequestSchema, () => ({
  tools: [
    {
      name: "martin_doctor",
      description:
        "Inspect Martin MCP readiness without changing code. Reports workspace roots, run-store visibility, execution mode, and whether claude or codex is available on PATH.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          workingDirectory: {
            type: "string",
            description:
              "Optional repo-root override resolved under the MCP workspace root (or current working directory). Must stay within that safe root."
          },
          runsDir: {
            type: "string",
            description:
              "Optional runs-root override resolved under the default Martin runs root. Defaults to MARTIN_RUNS_DIR or ~/.martin/runs."
          },
          engine: {
            type: "string",
            enum: ["claude", "codex"],
            description: "Optional engine to emphasize in the readiness report."
          }
        }
      }
    },
    {
      name: "martin_preflight",
      description:
        "Validate and normalize a proposed martin_run contract before execution. Reports the effective budget, path scope, engine readiness, and expected run-store layout.",
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
              "Optional repo-root override resolved under the MCP workspace root (or current working directory). Must stay within that safe root."
          },
          engine: {
            type: "string",
            enum: ["claude", "codex"],
            description: "Which agent CLI to use. Defaults to 'claude'."
          },
          model: {
            type: "string",
            description: "Model override passed to the CLI (e.g. 'claude-opus-4-6', 'o3')."
          },
          maxUsd: {
            type: "number",
            exclusiveMinimum: 0,
            description: "Hard budget ceiling in USD. Defaults to 25."
          },
          maxIterations: {
            type: "integer",
            exclusiveMinimum: 0,
            description: "Maximum number of loop attempts. Defaults to 8."
          },
          maxTokens: {
            type: "integer",
            exclusiveMinimum: 0,
            description: "Maximum total tokens across all attempts. Defaults to 80000."
          },
          verificationPlan: {
            type: "array",
            items: { type: "string" },
            description:
              "Shell commands that must all exit 0 for the task to be considered complete (e.g. ['pnpm test', 'pnpm build'])."
          },
          allowedPaths: {
            type: "array",
            items: { type: "string" },
            description:
              "Repo-relative path globs Martin may modify, such as ['src/**', 'tests/**']. Absolute paths and '..' traversal are rejected."
          },
          deniedPaths: {
            type: "array",
            items: { type: "string" },
            description:
              "Repo-relative path globs Martin must never modify, such as ['.env', 'docs/security/**']. Absolute paths and '..' traversal are rejected."
          },
          workspaceId: {
            type: "string",
            description: "Workspace identifier for telemetry. Defaults to 'ws_mcp'."
          },
          projectId: {
            type: "string",
            description: "Project identifier for telemetry. Defaults to 'proj_mcp'."
          }
        },
        required: ["objective"]
      }
    },
    {
      name: "martin_run",
      description:
        "Execute a full Martin Loop on a coding task. Martin spawns the selected agent CLI (claude or codex), runs the task, classifies failures, and retries within the specified budget. Returns the loop outcome including lifecycle state, attempt count, and spend.",
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
              "Optional repo-root override resolved under the MCP workspace root (or current working directory). Must stay within that safe root."
          },
          engine: {
            type: "string",
            enum: ["claude", "codex"],
            description: "Which agent CLI to use. Defaults to 'claude'."
          },
          model: {
            type: "string",
            description: "Model override passed to the CLI (e.g. 'claude-opus-4-6', 'o3')."
          },
          maxUsd: {
            type: "number",
            exclusiveMinimum: 0,
            description: "Hard budget ceiling in USD. Defaults to 25."
          },
          maxIterations: {
            type: "integer",
            exclusiveMinimum: 0,
            description: "Maximum number of loop attempts. Defaults to 8."
          },
          maxTokens: {
            type: "integer",
            exclusiveMinimum: 0,
            description: "Maximum total tokens across all attempts. Defaults to 80000."
          },
          verificationPlan: {
            type: "array",
            items: { type: "string" },
            description:
              "Shell commands that must all exit 0 for the task to be considered complete (e.g. ['pnpm test', 'pnpm build'])."
          },
          allowedPaths: {
            type: "array",
            items: { type: "string" },
            description:
              "Repo-relative path globs Martin may modify, such as ['src/**', 'tests/**']. Absolute paths and '..' traversal are rejected."
          },
          deniedPaths: {
            type: "array",
            items: { type: "string" },
            description:
              "Repo-relative path globs Martin must never modify, such as ['.env', 'docs/security/**']. Absolute paths and '..' traversal are rejected."
          },
          workspaceId: {
            type: "string",
            description: "Workspace identifier for telemetry. Defaults to 'ws_mcp'."
          },
          projectId: {
            type: "string",
            description: "Project identifier for telemetry. Defaults to 'proj_mcp'."
          }
        },
        required: ["objective"]
      }
    },
    {
      name: "martin_inspect",
      description:
        "Summarise Martin Loop run records from a saved loop file or run-store directory. Supports canonical loop-record.json files, legacy JSONL files, and full runs directories.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          file: {
            type: "string",
            description:
              "Optional path resolved under the Martin runs root to a loop-record.json file, a legacy .jsonl file, or a run-store directory."
          },
          runsDir: {
            type: "string",
            description:
              "Optional runs-root override resolved under the default Martin runs root. Defaults to MARTIN_RUNS_DIR or ~/.martin/runs."
          }
        }
      }
    },
    {
      name: "martin_status",
      description:
        "Return the current budget and cost state of a Martin loop record. Accepts inline JSON, a saved loop file, a loopId under the run store, or the latest run in the store.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          loopJson: {
            type: "string",
            description: "JSON-serialized LoopRecord."
          },
          file: {
            type: "string",
            description:
              "Optional path resolved under the Martin runs root to a loop-record.json file, a legacy .jsonl file, or a run-store directory."
          },
          loopId: {
            type: "string",
            description:
              "Optional Martin loop ID. Loads <runsDir>/<loopId>/loop-record.json."
          },
          runsDir: {
            type: "string",
            description:
              "Optional runs-root override resolved under the default Martin runs root. Defaults to MARTIN_RUNS_DIR or ~/.martin/runs."
          },
          latest: {
            const: true,
            description:
              "When true, loads the most recently updated loop record in the runs directory."
          }
        },
        oneOf: [
          { required: ["loopJson"] },
          { required: ["file"] },
          { required: ["loopId"] },
          { required: ["latest"] }
        ]
      }
    },
    {
      name: "martin_list_runs",
      description:
        "List recent Martin Loop runs from the local run store with budget, verifier, and lifecycle summaries. Read-only.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          runsDir: {
            type: "string",
            description:
              "Optional runs-root override resolved under the default Martin runs root. Defaults to MARTIN_RUNS_DIR or ~/.martin/runs."
          },
          limit: {
            type: "integer",
            exclusiveMinimum: 0,
            description: "Maximum number of runs to return. Defaults to 20."
          }
        }
      }
    },
    {
      name: "martin_get_run",
      description:
        "Load a read-only run dossier by loopId or latest run selector, including task, budget, cost, and attempts.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          loopId: {
            type: "string",
            description: "Martin loop ID under the run store."
          },
          runsDir: {
            type: "string",
            description:
              "Optional runs-root override resolved under the default Martin runs root. Defaults to MARTIN_RUNS_DIR or ~/.martin/runs."
          },
          latest: {
            const: true,
            description: "When true, loads the most recently updated loop record in the runs directory."
          }
        },
        oneOf: [{ required: ["loopId"] }, { required: ["latest"] }]
      }
    },
    {
      name: "martin_get_attempt",
      description:
        "Load read-only attempt evidence for a single Martin Loop attempt by loopId and attempt index.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          loopId: {
            type: "string",
            description: "Martin loop ID under the run store."
          },
          attemptIndex: {
            type: "integer",
            exclusiveMinimum: 0,
            description: "1-based attempt index to inspect."
          },
          runsDir: {
            type: "string",
            description:
              "Optional runs-root override resolved under the default Martin runs root. Defaults to MARTIN_RUNS_DIR or ~/.martin/runs."
          }
        },
        required: ["loopId", "attemptIndex"]
      }
    },
    {
      name: "martin_get_verification_results",
      description:
        "Extract verifier completion events for a run by loopId or latest selector. Read-only.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          loopId: {
            type: "string",
            description: "Martin loop ID under the run store."
          },
          runsDir: {
            type: "string",
            description:
              "Optional runs-root override resolved under the default Martin runs root. Defaults to MARTIN_RUNS_DIR or ~/.martin/runs."
          },
          latest: {
            const: true,
            description: "When true, loads the most recently updated loop record in the runs directory."
          }
        },
        oneOf: [{ required: ["loopId"] }, { required: ["latest"] }]
      }
    },
    {
      name: "martin_run_dossier",
      description:
        "Build a compact read-only dossier for review: summary, budget, attempts, and verification evidence.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          loopId: {
            type: "string",
            description: "Martin loop ID under the run store."
          },
          runsDir: {
            type: "string",
            description:
              "Optional runs-root override resolved under the default Martin runs root. Defaults to MARTIN_RUNS_DIR or ~/.martin/runs."
          },
          latest: {
            const: true,
            description: "When true, loads the most recently updated loop record in the runs directory."
          }
        },
        oneOf: [{ required: ["loopId"] }, { required: ["latest"] }]
      }
    }
  ]
}));

// ---------------------------------------------------------------------------
// Resources and prompts
// ---------------------------------------------------------------------------

server.setRequestHandler(ListResourcesRequestSchema, () => ({
  resources: listMartinResources()
}));

server.setRequestHandler(ListResourceTemplatesRequestSchema, () => ({
  resourceTemplates: listMartinResourceTemplates()
}));

server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
  return readMartinResource(request.params.uri);
});

server.setRequestHandler(ListPromptsRequestSchema, () => ({
  prompts: listMartinPrompts()
}));

server.setRequestHandler(GetPromptRequestSchema, (request) => {
  return getMartinPrompt(request.params.name, request.params.arguments ?? {});
});

// ---------------------------------------------------------------------------
// Tool dispatch
// ---------------------------------------------------------------------------

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    if (name === "martin_doctor") {
      const input = validateToolInput("martin_doctor", args) as Parameters<typeof martinDoctorTool>[0];
      const output = await martinDoctorTool(input);
      return { content: [{ type: "text", text: JSON.stringify(output, null, 2) }] };
    }

    if (name === "martin_preflight") {
      const input = validateToolInput("martin_preflight", args) as Parameters<typeof martinPreflightTool>[0];
      const output = await martinPreflightTool(input);
      return { content: [{ type: "text", text: JSON.stringify(output, null, 2) }] };
    }

    if (name === "martin_run") {
      const input = validateToolInput("martin_run", args) as Parameters<typeof runLoopTool>[0];
      const output = await runLoopTool(input);
      return { content: [{ type: "text", text: JSON.stringify(output, null, 2) }] };
    }

    if (name === "martin_inspect") {
      const input = validateToolInput("martin_inspect", args) as Parameters<typeof inspectLoopTool>[0];
      const output = await inspectLoopTool(input);
      return { content: [{ type: "text", text: JSON.stringify(output, null, 2) }] };
    }

    if (name === "martin_status") {
      const input = validateToolInput("martin_status", args) as Parameters<typeof getStatusTool>[0];
      const output = await getStatusTool(input);
      return { content: [{ type: "text", text: JSON.stringify(output, null, 2) }] };
    }

    if (name === "martin_list_runs") {
      const input = validateToolInput("martin_list_runs", args) as Parameters<typeof listRunsTool>[0];
      const output = await listRunsTool(input);
      return { content: [{ type: "text", text: JSON.stringify(output, null, 2) }] };
    }

    if (name === "martin_get_run") {
      const input = validateToolInput("martin_get_run", args) as Parameters<typeof getRunTool>[0];
      const output = await getRunTool(input);
      return { content: [{ type: "text", text: JSON.stringify(output, null, 2) }] };
    }

    if (name === "martin_get_attempt") {
      const input = validateToolInput("martin_get_attempt", args) as Parameters<typeof getAttemptTool>[0];
      const output = await getAttemptTool(input);
      return { content: [{ type: "text", text: JSON.stringify(output, null, 2) }] };
    }

    if (name === "martin_get_verification_results") {
      const input = validateToolInput("martin_get_verification_results", args) as Parameters<
        typeof getVerificationResultsTool
      >[0];
      const output = await getVerificationResultsTool(input);
      return { content: [{ type: "text", text: JSON.stringify(output, null, 2) }] };
    }

    if (name === "martin_run_dossier") {
      const input = validateToolInput("martin_run_dossier", args) as Parameters<typeof runDossierTool>[0];
      const output = await runDossierTool(input);
      return { content: [{ type: "text", text: JSON.stringify(output, null, 2) }] };
    }

    return {
      content: [{ type: "text", text: `Unknown tool: ${name}` }],
      isError: true
    };
  } catch (error) {
    const message = sanitizeToolErrorMessage(error);
    return {
      content: [{ type: "text", text: `Tool error: ${message}` }],
      isError: true
    };
  }
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

const transport = new StdioServerTransport();
await server.connect(transport);
