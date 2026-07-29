// SPDX-FileCopyrightText: MartinLoop contributors
//
// SPDX-License-Identifier: Apache-2.0

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { describe, expect, it } from "vitest";

describe("live MCP server handshake", () => {
  it("initializes over stdio and exposes the expected discovery surface", { timeout: 20000 }, async () => {
    const runsRoot = await mkdtemp(path.join(os.tmpdir(), "martin-mcp-live-"));
    const loopId = "loop_live_routed_020";
    await writeLiveInspectionRun(runsRoot, loopId);
    const serverPath = path.resolve("src/server.ts");
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ["--import", "tsx", serverPath],
      cwd: process.cwd(),
      env: {
        ...process.env,
        MARTIN_LIVE: "false",
        MARTIN_RUNS_DIR: runsRoot
      }
    });
    const client = new Client(
      { name: "martin-mcp-live-test", version: "0.0.0" },
      { capabilities: {} }
    );

    try {
      await client.connect(transport);

      const [tools, resources, templates, prompts, health] = await Promise.all([
        client.listTools(),
        client.listResources(),
        client.listResourceTemplates(),
        client.listPrompts(),
        client.readResource({ uri: "martin://server/health" })
      ]);

      expect(tools.tools.map((tool) => tool.name)).toContain("martin_run_dossier");
      expect(resources.resources.map((resource) => resource.uri)).toContain("martin://server/health");
      expect(templates.resourceTemplates.map((template) => template.uriTemplate)).toContain(
        "martin://runs/{loopId}"
      );
      expect(prompts.prompts.map((prompt) => prompt.name)).toContain("martin_debug_failed_run");
      expect(health.contents[0]?.text).toContain("\"metadata\"");
      expect(health.contents[0]?.text).toContain("\"serverVersion\"");

      const toolCall = await client.callTool({
        name: "martin_get_run",
        arguments: { loopId }
      });
      const resourceRead = await client.readResource({
        uri: `martin://runs/${loopId}/verification`
      });
      const promptFetch = await client.getPrompt({
        name: "martin_debug_failed_run",
        arguments: { loopId, attemptIndex: "1" }
      });
      const routedInspection = {
        toolCall: JSON.parse(readTextContent(toolCall)),
        resourceRead: JSON.parse(readResourceText(resourceRead)),
        promptFetch
      };

      expect(routedInspection.toolCall.loop.loopId).toBe(loopId);
      expect(routedInspection.toolCall.verification.status).toBe("failed");
      expect(routedInspection.resourceRead.value.loopId).toBe(loopId);
      expect(routedInspection.resourceRead.value.verificationCount).toBe(1);
      expect(routedInspection.promptFetch.messages.length).toBeGreaterThan(0);
      expect(JSON.stringify(routedInspection.promptFetch.messages)).toContain(loopId);
    } finally {
      await transport.close().catch(() => {});
      await rm(runsRoot, { recursive: true, force: true }).catch(() => {});
    }
  });
});

async function writeLiveInspectionRun(runsRoot: string, loopId: string): Promise<void> {
  const runDir = path.join(runsRoot, loopId);
  await mkdir(runDir, { recursive: true });
  await writeFile(
    path.join(runDir, "loop-record.json"),
    `${JSON.stringify({
      loopId,
      status: "failed",
      lifecycleState: "failed",
      createdAt: "2026-05-12T00:00:00.000Z",
      updatedAt: "2026-05-12T00:01:00.000Z",
      attempts: [
        {
          index: 1,
          attemptId: "att_live_routed_020",
          adapterId: "direct:stub:stub",
          model: "stub",
          failureClass: "verification_failure",
          intervention: "run_verifier",
          startedAt: "2026-05-12T00:00:05.000Z",
          completedAt: "2026-05-12T00:00:30.000Z",
          summary: "Seeded live-server inspection attempt."
        }
      ],
      budget: {
        maxUsd: 1,
        softLimitUsd: 0.5,
        maxIterations: 1,
        maxTokens: 1000
      },
      cost: {
        actualUsd: 0,
        avoidedUsd: 0,
        tokensIn: 10,
        tokensOut: 5,
        thinkingTokensOut: 0,
        childCostUsd: 0
      },
      events: [
        {
          type: "verification.completed",
          timestamp: "2026-05-12T00:00:31.000Z",
          lifecycleState: "failed",
          payload: {
            attemptId: "att_live_routed_020",
            passed: false,
            summary: "Seeded verification failure for live routed inspection."
          }
        }
      ],
      task: {
        title: "Live routed inspection",
        objective: "Exercise routed 0.2.0 inspection surfaces over stdio."
      }
    }, null, 2)}\n`,
    "utf8"
  );
}

function readTextContent(result: {
  content?: Array<{ type?: string; text?: string }>;
}): string {
  const first = result.content?.[0];
  if (first?.type !== "text" || typeof first.text !== "string") {
    throw new Error("Expected text content from MCP tool call.");
  }

  return first.text;
}

function readResourceText(result: {
  contents?: Array<{ text?: string }>;
}): string {
  const first = result.contents?.[0];
  if (typeof first?.text !== "string") {
    throw new Error("Expected text resource content from MCP resource read.");
  }

  return first.text;
}
