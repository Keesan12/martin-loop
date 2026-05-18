import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { describe, expect, it } from "vitest";

describe("live MCP server handshake", () => {
  it("initializes over stdio and exposes the expected discovery surface", { timeout: 20000 }, async () => {
    const runsRoot = await mkdtemp(path.join(os.tmpdir(), "martin-mcp-live-"));
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
    } finally {
      await transport.close().catch(() => {});
      await rm(runsRoot, { recursive: true, force: true }).catch(() => {});
    }
  });
});
