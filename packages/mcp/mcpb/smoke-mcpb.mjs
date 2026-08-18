#!/usr/bin/env node

import { access } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(scriptDirectory, "..");
const stagedServerRoot = path.join(packageRoot, "dist-mcpb", "martinloop", "server");
const stagedServerEntry = path.join(stagedServerRoot, "dist", "server.js");
const requiredTools = ["martin_doctor", "martin_preflight", "martin_run", "martin_run_dossier"];

async function smoke() {
  await access(stagedServerEntry);
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [stagedServerEntry],
    cwd: stagedServerRoot,
    env: {
      ...process.env,
      MARTIN_RUNS_DIR: path.join(packageRoot, "dist-mcpb", "smoke-runs"),
    },
    stderr: "pipe",
  });
  const client = new Client(
    { name: "martin-mcpb-smoke", version: "0.0.0" },
    { capabilities: {} },
  );

  try {
    await client.connect(transport);
    const tools = await client.listTools();
    const names = new Set(tools.tools.map((tool) => tool.name));
    const missing = requiredTools.filter((name) => !names.has(name));
    if (missing.length > 0) {
      throw new Error(`Packed MCPB server is missing required tools: ${missing.join(", ")}`);
    }
    process.stdout.write(
      `${JSON.stringify({ stagedServerEntry, toolCount: tools.tools.length, requiredTools }, null, 2)}\n`,
    );
  } finally {
    await client.close().catch(() => {});
    await transport.close().catch(() => {});
  }
}

smoke().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
