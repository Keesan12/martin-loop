#!/usr/bin/env node

import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

async function main() {
  const runsRoot = await mkdtemp(path.join(os.tmpdir(), "martin-mcp-inspect-"));
  const serverPath = path.resolve("src/server.ts");
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", "tsx", serverPath],
    cwd: process.cwd(),
    env: {
      ...process.env,
      MARTIN_LIVE: process.env.MARTIN_LIVE ?? "false",
      MARTIN_RUNS_DIR: process.env.MARTIN_RUNS_DIR ?? runsRoot
    }
  });
  const client = new Client(
    { name: "martin-mcp-inspector", version: "0.0.0" },
    { capabilities: {} }
  );

  try {
    await client.connect(transport);

    const [tools, resources, templates, prompts] = await Promise.all([
      client.listTools(),
      client.listResources(),
      client.listResourceTemplates(),
      client.listPrompts()
    ]);

    process.stdout.write(
      `${JSON.stringify(
        {
          tools: tools.tools.map((tool) => tool.name),
          resources: resources.resources.map((resource) => resource.uri),
          resourceTemplates: templates.resourceTemplates.map((template) => template.uriTemplate),
          prompts: prompts.prompts.map((prompt) => prompt.name)
        },
        null,
        2
      )}\n`
    );
  } finally {
    await transport.close().catch(() => {});
    await rm(runsRoot, { recursive: true, force: true }).catch(() => {});
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
