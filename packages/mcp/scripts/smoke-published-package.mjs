#!/usr/bin/env node

import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import { buildStandaloneMcpPackage, createCommandLaunch } from "./build-package-lib.mjs";
import {
  PUBLISHED_PACKAGE_SPEC,
  assertMcpPackageMetadataParity,
  readJsonFile,
  sanitizePackageManagerEnv,
} from "./smoke-package.mjs";

const REQUIRED_TOOLS = ["martin_inspect", "martin_run", "martin_status"];
const INSTALLED_PACKAGE_PATH = path.join("node_modules", ...PUBLISHED_PACKAGE_SPEC.split("/"));

export async function runPublishedMcpSmoke(options = {}) {
  const packageDir = path.resolve(options.packageDir ?? fileURLToPath(new URL("..", import.meta.url)));
  const sourceManifest = await readJsonFile(path.join(packageDir, "package.json"));
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
      allowLocalFallback:
        options.allowLocalFallback === true || process.env.MARTIN_MCP_ALLOW_LOCAL_FALLBACK === "1",
    });
    const installedPackageDir = await installPublishedPackage({
      installRoot,
      npmCacheDir,
      packageSpec,
    });
    let installedManifest;
    let installedServerMetadata;
    try {
      [installedManifest, installedServerMetadata] = await Promise.all([
        readJsonFile(path.join(installedPackageDir, "package.json")),
        readJsonFile(path.join(installedPackageDir, "server.json")),
      ]);
    } catch (error) {
      if (error?.code === "ENOENT") {
        throw new Error(
          [
            `Installed MCP artifact at ${installedPackageDir} is missing required metadata files.`,
            "Published smoke fails closed until the npm package includes both package.json and server.json.",
          ].join(" "),
        );
      }
      throw error;
    }
    assertMcpPackageMetadataParity(installedManifest, installedServerMetadata);
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
      { name: "martin-mcp-published-smoke", version: sourceManifest.version },
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
      installedManifest: {
        name: installedManifest.name,
        version: installedManifest.version,
        mcpName: installedManifest.mcpName,
      },
      installedServerMetadata,
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

export async function resolvePublishedPackageSpec({
  packageDir,
  tempPackDir,
  explicitPackageSpec,
  allowLocalFallback = false,
  lookupPublishedVersion = npmViewPublishedVersion,
  buildLocalFallbackPackageSpec = buildLocalFallbackTarballSpec,
}) {
  if (explicitPackageSpec) {
    if (explicitPackageSpec === "__BUILD_LOCAL_PACK__") {
      return buildLocalFallbackPackageSpec({ packageDir, tempPackDir });
    }
    return explicitPackageSpec;
  }

  const manifest = await readJsonFile(path.join(packageDir, "package.json"));
  const currentVersionSpec = `${PUBLISHED_PACKAGE_SPEC}@${manifest.version}`;
  const lookup = await lookupPublishedVersion(currentVersionSpec);
  if (lookup.found) {
    return currentVersionSpec;
  }

  if (!allowLocalFallback) {
    throw new Error(
      [
        `Published MCP package ${currentVersionSpec} is not available for smoke validation.`,
        lookup.reason,
        "Set MARTIN_MCP_PACKAGE_SPEC to an explicit package spec or set MARTIN_MCP_ALLOW_LOCAL_FALLBACK=1 for a local fallback tarball.",
      ].join(" "),
    );
  }

  return buildLocalFallbackPackageSpec({ packageDir, tempPackDir });
}

async function npmViewPublishedVersion(packageSpec) {
  try {
    await runCommand(npmCommand(), ["view", packageSpec, "version"], { cwd: process.cwd() });
    return {
      found: true,
      reason: `Resolved ${packageSpec} from npm.`,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const normalized = message.toLowerCase();
    const notFound = normalized.includes("e404") || normalized.includes("404") || normalized.includes("not found");
    return {
      found: false,
      reason: notFound
        ? `npm view did not find ${packageSpec}.`
        : `npm view failed for ${packageSpec}: ${message}`,
    };
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

async function buildLocalFallbackTarballSpec({ packageDir, tempPackDir }) {
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
  const cliOptions = parseCliOptions(process.argv.slice(2));
  const result = await runPublishedMcpSmoke(cliOptions);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

function parseCliOptions(argv) {
  const options = {};

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];

    if (argument === "--allow-local-fallback") {
      options.allowLocalFallback = true;
      continue;
    }

    if (argument === "--package-spec") {
      const next = argv[index + 1];
      if (!next) {
        throw new Error("--package-spec requires a value.");
      }
      options.packageSpec = parsePackageSpecValue(next);
      index += 1;
      continue;
    }

    if (argument.startsWith("--package-spec=")) {
      options.packageSpec = parsePackageSpecValue(argument.slice("--package-spec=".length));
      continue;
    }

    throw new Error(`Unknown argument: ${argument}`);
  }

  return options;
}

function parsePackageSpecValue(value) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error("--package-spec requires a non-empty value.");
  }

  if (value.startsWith("--")) {
    throw new Error(`--package-spec expected a package spec but received another flag: ${value}`);
  }

  if (value === "pack") {
    return "__BUILD_LOCAL_PACK__";
  }

  return value;
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
