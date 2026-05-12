#!/usr/bin/env node

import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import { PUBLISHED_PACKAGE_SPEC, sanitizePackageManagerEnv } from "./smoke-package.mjs";

const REQUIRED_TOOLS = ["martin_inspect", "martin_run", "martin_status"];

export async function runPublishedMcpSmoke(options = {}) {
  const packageSpec = options.packageSpec ?? process.env.MARTIN_MCP_PACKAGE_SPEC ?? PUBLISHED_PACKAGE_SPEC;
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "martin-mcp-published-smoke-"));
  const runsRoot = path.join(tempRoot, "runs");
  const npmCacheDir = path.join(tempRoot, ".npm-cache");
  await mkdir(runsRoot, { recursive: true });
  await mkdir(npmCacheDir, { recursive: true });

  let transport;
  try {
    const canonicalLoop = {
      loopId: "loop_published_canonical",
      status: "completed",
      lifecycleState: "completed",
      createdAt: "2026-05-12T00:00:00.000Z",
      updatedAt: "2026-05-12T00:00:00.000Z",
      attempts: [],
      budget: {
        maxUsd: 5,
        softLimitUsd: 3,
        maxIterations: 2,
        maxTokens: 1_000,
      },
      cost: {
        actualUsd: 1.25,
        avoidedUsd: 0.2,
        tokensIn: 20,
        tokensOut: 10,
        thinkingTokensOut: 0,
        childCostUsd: 0,
      },
      events: [],
      task: {
        title: "Canonical smoke",
        objective: "Canonical smoke",
      },
    };
    const jsonlOlderLoop = {
      ...canonicalLoop,
      loopId: "loop_published_jsonl_old",
      createdAt: "2026-05-11T00:00:00.000Z",
      updatedAt: "2026-05-11T00:00:00.000Z",
      cost: {
        ...canonicalLoop.cost,
        actualUsd: 0.75,
      },
    };
    const jsonlNewerLoop = {
      ...canonicalLoop,
      loopId: "loop_published_jsonl_new",
      createdAt: "2026-05-13T00:00:00.000Z",
      updatedAt: "2026-05-13T00:00:00.000Z",
      cost: {
        ...canonicalLoop.cost,
        actualUsd: 2.5,
      },
    };

    const canonicalDir = path.join(runsRoot, canonicalLoop.loopId);
    await mkdir(canonicalDir, { recursive: true });
    const canonicalFile = path.join(canonicalDir, "loop-record.json");
    await writeFile(canonicalFile, `${JSON.stringify(canonicalLoop, null, 2)}\n`, "utf8");

    const jsonlFile = path.join(runsRoot, "workspace.jsonl");
    await writeFile(
      jsonlFile,
      `${JSON.stringify(jsonlOlderLoop)}\n${JSON.stringify(jsonlNewerLoop)}\n`,
      "utf8",
    );

    transport = new StdioClientTransport({
      ...createPublishedLaunch(packageSpec),
      cwd: tempRoot,
      env: {
        ...sanitizePackageManagerEnv(process.env),
        MARTIN_RUNS_DIR: runsRoot,
        MARTIN_LIVE: "false",
        npm_config_cache: npmCacheDir,
      },
      stderr: "pipe",
    });

    const stderrChunks = [];
    transport.stderr?.on("data", (chunk) => {
      stderrChunks.push(chunk.toString());
    });

    const client = new Client(
      { name: "martin-mcp-published-smoke", version: "0.1.2" },
      { capabilities: {} },
    );

    await client.connect(transport);

    const tools = await client.listTools();
    const toolNames = tools.tools.map((tool) => tool.name).sort();
    for (const toolName of REQUIRED_TOOLS) {
      if (!toolNames.includes(toolName)) {
        throw new Error(`Missing expected tool "${toolName}" in published MCP server.`);
      }
    }

    const canonicalInspect = await client.callTool({
      name: "martin_inspect",
      arguments: { file: canonicalFile },
    });
    const jsonlInspect = await client.callTool({
      name: "martin_inspect",
      arguments: { file: jsonlFile },
    });
    const latestStatus = await client.callTool({
      name: "martin_status",
      arguments: { latest: true },
    });
    const runResult = await client.callTool({
      name: "martin_run",
      arguments: {
        objective: "Summarize the current runtime state",
        verificationPlan: [],
        maxIterations: 1,
        maxUsd: 1,
        allowedPaths: ["src/**"],
        deniedPaths: ["docs/**"],
        workspaceId: "ws_published_smoke",
        projectId: "proj_published_smoke",
      },
    });

    return {
      packageSpec,
      npxCommand: `npx ${packageSpec}`,
      toolNames,
      canonicalInspect: JSON.parse(readTextContent(canonicalInspect)),
      jsonlInspect: JSON.parse(readTextContent(jsonlInspect)),
      latestStatus: JSON.parse(readTextContent(latestStatus)),
      runResult: JSON.parse(readTextContent(runResult)),
      stderr: stderrChunks.join(""),
    };
  } finally {
    if (transport) {
      await transport.close().catch(() => {});
    }
    if (!options.keepTempDir) {
      await rm(tempRoot, { force: true, recursive: true, maxRetries: 10, retryDelay: 100 });
    }
  }
}

function createPublishedLaunch(packageSpec) {
  return {
    command: process.platform === "win32" ? "npm.cmd" : "npm",
    args: ["exec", "--yes", "--package", packageSpec, "--", "mcp"],
  };
}

function readTextContent(result) {
  if (!Array.isArray(result.content) || result.content.length === 0) {
    throw new Error("MCP tool call returned no content.");
  }

  const first = result.content[0];
  if (first?.type !== "text" || typeof first.text !== "string") {
    throw new Error("Expected text content from MCP tool call.");
  }

  return first.text;
}

async function main() {
  const result = await runPublishedMcpSmoke();
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
const modulePath = fileURLToPath(import.meta.url);
if (invokedPath === path.resolve(modulePath)) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`Published MCP smoke failed: ${message}\n`);
    process.exitCode = 1;
  });
}
