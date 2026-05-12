#!/usr/bin/env node

/**
 * Martin Loop MCP Server
 *
 * Exposes three tools over the Model Context Protocol (stdio transport):
 *   martin_run      — execute a full Martin loop on a coding task
 *   martin_inspect  — summarise a saved loop record file
 *   martin_status   — return cost and pressure state from a loop record
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

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema
} from "@modelcontextprotocol/sdk/types.js";

import { getStatusTool } from "./tools/get-status.js";
import { inspectLoopTool } from "./tools/inspect-loop.js";
import { runLoopTool } from "./tools/run-loop.js";
import { sanitizeToolErrorMessage, validateToolInput } from "./server-validation.js";

const server = new Server(
  { name: "martin-loop", version: "0.1.2" },
  { capabilities: { tools: {} } }
);

// ---------------------------------------------------------------------------
// Tool manifest
// ---------------------------------------------------------------------------

server.setRequestHandler(ListToolsRequestSchema, () => ({
  tools: [
    {
      name: "martin_run",
      description:
        "Execute a full Martin Loop on a coding task. Martin spawns the selected agent CLI (claude or codex), runs the task, classifies failures, and retries within the specified budget. Returns the loop outcome including lifecycle state, attempt count, and spend.",
      inputSchema: {
        type: "object",
        properties: {
          objective: {
            type: "string",
            description: "The coding task to complete. Be specific about what needs to change."
          },
          workingDirectory: {
            type: "string",
            description:
              "Absolute path to the project root. Defaults to the current working directory."
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
            description: "Hard budget ceiling in USD. Defaults to 25."
          },
          maxIterations: {
            type: "number",
            description: "Maximum number of loop attempts. Defaults to 8."
          },
          maxTokens: {
            type: "number",
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
              "Relative path globs Martin may modify, such as ['src/**', 'tests/**']."
          },
          deniedPaths: {
            type: "array",
            items: { type: "string" },
            description:
              "Relative path globs Martin must never modify, such as ['.env', 'docs/security/**']."
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
        properties: {
          file: {
            type: "string",
            description:
              "Optional path under the Martin runs root to a loop-record.json file, a legacy .jsonl file, or a run-store directory."
          },
          runsDir: {
            type: "string",
            description:
              "Optional Martin runs directory. Defaults to MARTIN_RUNS_DIR or ~/.martin/runs."
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
        properties: {
          loopJson: {
            type: "string",
            description: "JSON-serialized LoopRecord."
          },
          file: {
            type: "string",
            description:
              "Optional path under the Martin runs root to a loop-record.json file, a legacy .jsonl file, or a run-store directory."
          },
          loopId: {
            type: "string",
            description:
              "Optional Martin loop ID. Loads <runsDir>/<loopId>/loop-record.json."
          },
          runsDir: {
            type: "string",
            description:
              "Optional Martin runs directory. Defaults to MARTIN_RUNS_DIR or ~/.martin/runs."
          },
          latest: {
            type: "boolean",
            description:
              "When true, loads the most recently updated loop record in the runs directory."
          }
        }
      }
    }
  ]
}));

// ---------------------------------------------------------------------------
// Tool dispatch
// ---------------------------------------------------------------------------

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
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
