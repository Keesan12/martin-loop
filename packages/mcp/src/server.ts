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
 *   claude mcp add martin-loop -- npx @martin/mcp
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

const server = new Server(
  { name: "martin-loop", version: "0.1.0" },
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
        "Summarise a saved Martin loop record file. Reads a JSON file containing one or more LoopRecords and returns portfolio-level statistics: total spend, avoided spend, token counts, and loop counts.",
      inputSchema: {
        type: "object",
        properties: {
          file: {
            type: "string",
            description: "Absolute or relative path to a LoopRecord JSON file."
          }
        },
        required: ["file"]
      }
    },
    {
      name: "martin_status",
      description:
        "Return the current budget and cost state of a Martin loop record. Useful for monitoring in-progress or completed loops.",
      inputSchema: {
        type: "object",
        properties: {
          loopJson: {
            type: "string",
            description: "JSON-serialized LoopRecord."
          }
        },
        required: ["loopJson"]
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
      const input = args as unknown as Parameters<typeof runLoopTool>[0];
      const output = await runLoopTool(input);
      return { content: [{ type: "text", text: JSON.stringify(output, null, 2) }] };
    }

    if (name === "martin_inspect") {
      const input = args as unknown as Parameters<typeof inspectLoopTool>[0];
      const output = await inspectLoopTool(input);
      return { content: [{ type: "text", text: JSON.stringify(output, null, 2) }] };
    }

    if (name === "martin_status") {
      const input = args as unknown as Parameters<typeof getStatusTool>[0];
      const output = getStatusTool(input);
      return { content: [{ type: "text", text: JSON.stringify(output, null, 2) }] };
    }

    return {
      content: [{ type: "text", text: `Unknown tool: ${name}` }],
      isError: true
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
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
