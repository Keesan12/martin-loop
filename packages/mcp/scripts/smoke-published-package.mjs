#!/usr/bin/env node

import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import { buildStandaloneMcpPackage, createCommandLaunch } from "./build-package-lib.mjs";
import { PUBLISHED_PACKAGE_SPEC, sanitizePackageManagerEnv } from "./smoke-package.mjs";

const REQUIRED_TOOLS = ["martin_inspect", "martin_run", "martin_status"];
const INSTALLED_PACKAGE_PATH = path.join("node_modules", ...PUBLISHED_PACKAGE_SPEC.split("/"));

export async function runPublishedMcpSmoke(options = {}) {
  const packageDir = path.resolve(options.packageDir ?? fileURLToPath(new URL("..", import.meta.url)));
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "martin-mcp-published-smoke-"));
  const runsRoot = path.join(tempRoot, "runs");
  const npmCacheDir = path.join(tempRoot, ".npm-cache");
  const packDir = path.join(tempRoot, "pack");
  const installRoot = path.join(tempRoot, "install");
  const workspaceRoot = path.join(tempRoot, "workspace");
  await mkdir(runsRoot, { recursive: true });
  await mkdir(npmCacheDir, { recursive: true });
  await mkdir(packDir, { recursive: true });
  await mkdir(installRoot, { recursive: true });
  await mkdir(path.join(workspaceRoot, "src"), { recursive: true });

  let transport;
  try {
    const packageSpec = await resolvePublishedPackageSpec({
      packageDir,
      tempPackDir: packDir,
      explicitPackageSpec: options.packageSpec ?? process.env.MARTIN_MCP_PACKAGE_SPEC,
    });
    const installedPackageDir = await installPublishedPackage({
      installRoot,
      npmCacheDir,
      packageSpec,
    });
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
    await writeFile(
      path.join(workspaceRoot, "src", "smoke-entry.ts"),
      "export const martinSmokeWorkspace = true;\n",
      "utf8",
    );

    transport = new StdioClientTransport({
      ...createInstalledPackageLaunch(installedPackageDir),
      cwd: workspaceRoot,
      env: {
        ...sanitizePackageManagerEnv(process.env),
        MARTIN_RUNS_DIR: runsRoot,
        MARTIN_LIVE: "false",
        MARTIN_MCP_WORKSPACE_ROOT: workspaceRoot,
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
      npxCommand: packageSpec.startsWith("@") ? `npx ${packageSpec}` : `npm exec --yes --package "${packageSpec}" -- mcp`,
      launchCommand: `${JSON.stringify(process.execPath)} ${JSON.stringify(path.join(installedPackageDir, "dist", "server.js"))}`,
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
      await removeTempDir(tempRoot);
    }
  }
}

async function resolvePublishedPackageSpec({ packageDir, tempPackDir, explicitPackageSpec }) {
  if (explicitPackageSpec) {
    return explicitPackageSpec;
  }

  const manifest = JSON.parse(await readFile(path.join(packageDir, "package.json"), "utf8"));
  const currentVersionSpec = `${PUBLISHED_PACKAGE_SPEC}@${manifest.version}`;
  if (await npmPackageExists(currentVersionSpec)) {
    return currentVersionSpec;
  }

  await buildStandaloneMcpPackage({ packageDir });
  const packRun = await runCommand(
    npmCommand(),
    ["pack", "--ignore-scripts", "--json", "--pack-destination", tempPackDir],
    { cwd: packageDir },
  );
  const packEntry = JSON.parse(packRun.stdout)?.[0];
  if (!packEntry?.filename) {
    throw new Error("Unable to create fallback MCP tarball for smoke verification.");
  }

  return path.join(tempPackDir, packEntry.filename);
}

async function npmPackageExists(packageSpec) {
  try {
    await runCommand(npmCommand(), ["view", packageSpec, "version"], { cwd: process.cwd() });
    return true;
  } catch {
    return false;
  }
}

function npmCommand() {
  return process.platform === "win32" ? "npm.cmd" : "npm";
}

async function runCommand(command, args, options) {
  return new Promise((resolve, reject) => {
    const launch = createCommandLaunch(command, args);
    const child = spawn(launch.command, launch.args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`Command failed (${code ?? "unknown"}): ${command} ${args.join(" ")}\n${stdout}${stderr}`));
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

async function installPublishedPackage({ installRoot, npmCacheDir, packageSpec }) {
  await writeFile(
    path.join(installRoot, "package.json"),
    `${JSON.stringify({ name: "martin-mcp-published-smoke", private: true }, null, 2)}\n`,
    "utf8",
  );

  await runCommand(
    npmCommand(),
    ["install", "--no-save", "--ignore-scripts", "--fund=false", "--audit=false", packageSpec],
    {
      cwd: installRoot,
      env: {
        ...sanitizePackageManagerEnv(process.env),
        npm_config_cache: npmCacheDir,
      },
    },
  );

  return path.join(installRoot, INSTALLED_PACKAGE_PATH);
}

function createInstalledPackageLaunch(installedPackageDir) {
  return {
    command: process.execPath,
    args: [path.join(installedPackageDir, "dist", "server.js")],
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

async function removeTempDir(tempRoot) {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      await rm(tempRoot, { force: true, recursive: true, maxRetries: 10, retryDelay: 100 });
      return;
    } catch (error) {
      const code = error?.code;
      if (code !== "EBUSY" && code !== "EPERM" && code !== "ENOTEMPTY") {
        throw error;
      }
      await sleep(120 * (attempt + 1));
    }
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
