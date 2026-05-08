#!/usr/bin/env node

import { spawn } from "node:child_process";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import { buildStandaloneMcpPackage } from "./build-package-lib.mjs";

const REQUIRED_TOOLS = ["martin_inspect", "martin_run", "martin_status"];
const PACKAGED_BIN_NAME = "mcp";
const REQUIRED_TARBALL_FILES = [
  "README.md",
  "dist/server.d.ts",
  "dist/server.js",
  "dist/tools/get-status.d.ts",
  "dist/tools/get-status.js",
  "dist/tools/inspect-loop.d.ts",
  "dist/tools/inspect-loop.js",
  "dist/tools/run-loop.d.ts",
  "dist/tools/run-loop.js",
  "dist/vendor/adapters/index.d.ts",
  "dist/vendor/adapters/index.js",
  "dist/vendor/contracts/index.d.ts",
  "dist/vendor/contracts/index.js",
  "dist/vendor/core/index.d.ts",
  "dist/vendor/core/index.js",
  "package.json",
];
const SMOKE_LOOP_RECORD = {
  loopId: "loop_pack_smoke",
  status: "queued",
  lifecycleState: "created",
  attempts: [],
  budget: {
    maxUsd: 5,
    softLimitUsd: 3,
    maxIterations: 2,
    maxTokens: 1_000,
  },
  cost: {
    actualUsd: 1.25,
    avoidedUsd: 0,
    tokensIn: 20,
    tokensOut: 10,
  },
};

export async function runStandaloneMcpSmoke(options = {}) {
  const packageDir = path.resolve(options.packageDir ?? fileURLToPath(new URL("..", import.meta.url)));
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "martin-mcp-smoke-"));
  const packDir = path.join(tempRoot, "pack");
  await mkdir(packDir, { recursive: true });

  let transport;
  try {
    await buildStandaloneMcpPackage({ packageDir });

    const packDryRun = await runCommand(npmCommand(), ["pack", "--ignore-scripts", "--json", "--dry-run"], {
      cwd: packageDir,
    });
    const dryRunEntry = parsePackEntry(packDryRun.stdout);
    const tarballFiles = dryRunEntry.files.map((file) => file.path).sort();
    assertTarballFileSet(tarballFiles);

    const packRun = await runCommand(
      npmCommand(),
      ["pack", "--ignore-scripts", "--json", "--pack-destination", packDir],
      { cwd: packageDir },
    );
    const packEntry = parsePackEntry(packRun.stdout);
    const tarballFilename = packEntry.filename;
    const tarballPath = path.join(packDir, packEntry.filename);

    const packedManifestOutput = await runCommand(
      tarCommand(),
      ["-xOf", tarballFilename, "package/package.json"],
      { cwd: packDir },
    );
    const packedManifest = JSON.parse(packedManifestOutput.stdout);
    assertPackedManifest(packedManifest);

    const stderrChunks = [];
    const launch = createPackagedLaunch(tarballPath);
    transport = new StdioClientTransport({
      command: launch.command,
      args: launch.args,
      cwd: tempRoot,
      env: process.env,
      stderr: "pipe",
    });
    transport.stderr?.on("data", (chunk) => {
      stderrChunks.push(chunk.toString());
    });

    const client = new Client(
      { name: "martin-mcp-smoke", version: "0.1.1" },
      { capabilities: {} },
    );

    await client.connect(transport);
    const tools = await client.listTools();
    const toolNames = tools.tools.map((tool) => tool.name).sort();

    for (const toolName of REQUIRED_TOOLS) {
      if (!toolNames.includes(toolName)) {
        throw new Error(`Missing expected tool "${toolName}" in packaged MCP server.`);
      }
    }

    const statusResult = await client.callTool({
      name: "martin_status",
      arguments: {
        loopJson: JSON.stringify(SMOKE_LOOP_RECORD),
      },
    });

    const statusPayload = JSON.parse(readTextContent(statusResult));
    if (statusPayload.loopId === undefined || statusPayload.pressure === undefined) {
      throw new Error("Packaged martin_status response is missing expected fields.");
    }

    return {
      tarballPath,
      npxCommand: "npx @keean12/mcp",
      toolNames,
      tarballFiles,
      packedDependencies: packedManifest.dependencies ?? {},
      statusPayload,
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

function assertTarballFileSet(filePaths) {
  const unexpected = filePaths.filter(
    (filePath) =>
      filePath !== "package.json" &&
      filePath !== "README.md" &&
      !filePath.startsWith("dist/"),
  );
  if (unexpected.length > 0) {
    throw new Error(`Tarball still contains unexpected files: ${unexpected.join(", ")}`);
  }

  const missing = REQUIRED_TARBALL_FILES.filter((requiredFile) => !filePaths.includes(requiredFile));
  if (missing.length > 0) {
    throw new Error(`Tarball is missing required files: ${missing.join(", ")}`);
  }
}

function assertPackedManifest(manifest) {
  const dependencyNames = Object.keys(manifest.dependencies ?? {});
  const internalDependencies = dependencyNames.filter((name) => name.startsWith("@martin/"));
  if (internalDependencies.length > 0) {
    throw new Error(
      `Packed package still depends on internal workspace packages: ${internalDependencies.join(", ")}`,
    );
  }
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

function parsePackEntry(stdout) {
  const parsed = JSON.parse(stdout);
  const entry = Array.isArray(parsed) ? parsed[0] : null;
  if (!entry || typeof entry.filename !== "string" || !Array.isArray(entry.files)) {
    throw new Error("npm pack did not return a usable pack result.");
  }
  return entry;
}

function npmCommand() {
  return "npm";
}

function tarCommand() {
  return process.platform === "win32" ? "tar.exe" : "tar";
}

function createPackagedLaunch(tarballPath) {
  if (process.platform === "win32") {
    const normalizedTarballPath = tarballPath.replace(/\\/g, "/");
    return {
      command: process.env.ComSpec ?? "cmd.exe",
      args: ["/d", "/s", "/c", `npm exec --yes --package ${normalizedTarballPath} -- ${PACKAGED_BIN_NAME}`],
    };
  }

  return {
    command: "npm",
    args: ["exec", "--yes", "--package", tarballPath, "--", PACKAGED_BIN_NAME],
  };
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

function createCommandLaunch(command, args) {
  if (process.platform !== "win32") {
    return { command, args };
  }

  return {
    command: process.env.ComSpec ?? "cmd.exe",
    args: ["/d", "/s", "/c", toCmdCommand(command, args)],
  };
}

function toCmdCommand(command, args) {
  return [quoteForCmdArgument(command), ...args.map((arg) => quoteForCmdArgument(arg))].join(" ");
}

function quoteForCmdArgument(value) {
  return /[\s"]/u.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

async function main() {
  const result = await runStandaloneMcpSmoke();
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
const modulePath = fileURLToPath(import.meta.url);
if (invokedPath === path.resolve(modulePath)) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`Standalone MCP smoke failed: ${message}\n`);
    process.exitCode = 1;
  });
}
