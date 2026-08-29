#!/usr/bin/env node

import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import { buildStandaloneMcpPackage } from "./build-package-lib.mjs";
import { resolveSmokeWorkspaceRoot } from "./smoke-paths.mjs";

const REQUIRED_TOOLS = [
  "martin_doctor",
  "martin_preflight",
  "martin_run",
  "martin_inspect",
  "martin_status",
  "martin_list_runs",
  "martin_triage_runs",
  "martin_get_run",
  "martin_get_attempt",
  "martin_get_verification_results",
  "martin_run_dossier",
];
export const PUBLISHED_PACKAGE_SPEC = "@martinloop/mcp";

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
  "dist/vendor/presentation/index.d.ts",
  "dist/vendor/presentation/index.js",
  "server.json",
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
  const workspaceRoot = await resolveSmokeWorkspaceRoot(tempRoot);
  const packDir = path.join(tempRoot, "pack");
  const installRoot = path.join(tempRoot, "install");
  const npmCacheDir = path.join(tempRoot, ".npm-cache");
  const sourceManifest = await readJsonFile(path.join(packageDir, "package.json"));
  await mkdir(packDir, { recursive: true });
  await mkdir(installRoot, { recursive: true });
  await mkdir(npmCacheDir, { recursive: true });

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

    const [packedManifestOutput, packedServerOutput] = await Promise.all([
      runCommand(
        tarCommand(),
        ["-xOf", tarballFilename, "package/package.json"],
        { cwd: packDir },
      ),
      runCommand(
        tarCommand(),
        ["-xOf", tarballFilename, "package/server.json"],
        { cwd: packDir },
      ),
    ]);
    const packedManifest = JSON.parse(packedManifestOutput.stdout);
    const packedServerMetadata = JSON.parse(packedServerOutput.stdout);
    assertPackedManifest(packedManifest, packedServerMetadata);

    const stderrChunks = [];
    const installedPackageDir = await installPackagedTarball({
      installRoot,
      npmCacheDir,
      tarballPath,
    });
    const launch = createPackagedLaunch(installedPackageDir);
    transport = new StdioClientTransport({
      command: launch.command,
      args: launch.args,
      cwd: workspaceRoot,
      env: {
        ...sanitizePackageManagerEnv(process.env),
        MARTIN_LIVE: "false",
        MARTIN_NO_MOTION: "1",
        NO_COLOR: "1",
      },
      stderr: "pipe",
    });
    transport.stderr?.on("data", (chunk) => {
      stderrChunks.push(chunk.toString());
    });

    const client = new Client(
      { name: "martin-mcp-smoke", version: sourceManifest.version },
      { capabilities: {} },
    );

    await client.connect(transport);

    // ML-E2E-2026-08-20-MCP-VERSION-001: verify serverInfo.version matches package.json
    const serverInfoVersion = client.getServerVersion?.()?.version;
    if (serverInfoVersion !== undefined && serverInfoVersion !== packedManifest.version) {
      throw new Error(
        `MCP serverInfo.version drift: initialize reported "${serverInfoVersion}" but package.json version is "${packedManifest.version}". ` +
        `Ensure MARTIN_MCP_PACKAGE_VERSION in package-version.ts is generated from package.json at build time.`,
      );
    }

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

    const statusPayload = readStructuredContent(statusResult, "martin_status");
    if (statusPayload.loopId === undefined || statusPayload.pressure === undefined) {
      throw new Error("Packaged martin_status response is missing expected fields.");
    }

    const preflightResult = await client.callTool({
      name: "martin_preflight",
      arguments: {
        objective: "Verify packaged MCP human proof surface",
        workingDirectory: workspaceRoot,
        engine: "codex",
        verificationPlan: ["node --version"],
        maxUsd: 1,
        maxIterations: 1,
      },
    });
    const preflightPayload = readStructuredContent(preflightResult, "martin_preflight");
    if (preflightPayload.receiptScope?.workingDirectory !== workspaceRoot) {
      throw new Error("Packaged martin_preflight did not preserve the canonical workspace root.");
    }
    const preflightPresentation = assertHumanFirstCompatibilityResponse(
      preflightResult,
      "martin_preflight",
      "## MartinLoop Governed Run Plan",
    );

    return {
      tarballPath,
      npxCommand: "npx -y @martinloop/mcp",
      toolNames,
      tarballFiles,
      packedDependencies: packedManifest.dependencies ?? {},
      packedServerMetadata,
      serverInitializeVersion: serverInfoVersion ?? "(not reported)",
      statusPayload,
      preflightPayload,
      preflightPresentation,
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

function assertTarballFileSet(filePaths) {
  const unexpected = filePaths.filter(
    (filePath) =>
      filePath !== "package.json" &&
      filePath !== "README.md" &&
      filePath !== "server.json" &&
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

export function assertMcpPackageMetadataParity(manifest, serverMetadata) {
  if (!manifest || typeof manifest !== "object") {
    throw new Error("Expected an MCP package manifest object.");
  }

  if (!serverMetadata || typeof serverMetadata !== "object") {
    throw new Error("Expected an MCP server metadata object.");
  }

  if (manifest.name !== PUBLISHED_PACKAGE_SPEC) {
    throw new Error(
      `Standalone MCP package name must be ${PUBLISHED_PACKAGE_SPEC}, received ${String(manifest.name)}.`,
    );
  }

  if (manifest.mcpName !== serverMetadata.name) {
    throw new Error(
      `package.json mcpName (${String(manifest.mcpName)}) must match server.json name (${String(serverMetadata.name)}).`,
    );
  }

  if (manifest.version !== serverMetadata.version) {
    throw new Error(
      `package.json version (${String(manifest.version)}) must match server.json version (${String(serverMetadata.version)}).`,
    );
  }

  const npmPackage = Array.isArray(serverMetadata.packages)
    ? serverMetadata.packages.find((pkg) => pkg?.registryType === "npm")
    : undefined;
  if (!npmPackage) {
    throw new Error("server.json must declare an npm package entry.");
  }

  if (npmPackage.identifier !== manifest.name) {
    throw new Error(
      `server.json npm identifier (${String(npmPackage.identifier)}) must match package.json name (${String(manifest.name)}).`,
    );
  }

  if (npmPackage.version !== manifest.version) {
    throw new Error(
      `server.json npm package version (${String(npmPackage.version)}) must match package.json version (${String(manifest.version)}).`,
    );
  }

  if (serverMetadata.name !== manifest.mcpName) {
    throw new Error(
      `server.json name (${String(serverMetadata.name)}) must match package.json mcpName (${String(manifest.mcpName)}).`,
    );
  }

  if (npmPackage.transport?.type !== "stdio") {
    throw new Error(
      `server.json npm transport must be stdio, received ${String(npmPackage.transport?.type)}.`,
    );
  }

  const expectedBinPath = "./dist/server.js";
  if (manifest.bin?.mcp !== expectedBinPath || manifest.bin?.["martin-loop-mcp"] !== expectedBinPath) {
    throw new Error(
      `package.json bin aliases must expose both "mcp" and "martin-loop-mcp" at ${expectedBinPath}.`,
    );
  }

  const shippedFiles = Array.isArray(manifest.files) ? manifest.files : [];
  for (const requiredFile of ["dist", "README.md", "server.json"]) {
    if (!shippedFiles.includes(requiredFile)) {
      throw new Error(`package.json files must include ${requiredFile}.`);
    }
  }
}

export async function readJsonFile(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

function assertPackedManifest(manifest, serverMetadata) {
  assertMcpPackageMetadataParity(manifest, serverMetadata);

  const dependencyNames = Object.keys(manifest.dependencies ?? {});
  const internalDependencies = dependencyNames.filter((name) => name.startsWith("@martin/"));
  if (internalDependencies.length > 0) {
    throw new Error(
      `Packed package still depends on internal workspace packages: ${internalDependencies.join(", ")}`,
    );
  }
}

function readStructuredContent(result, label) {
  const payload = result?.structuredContent;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error(`Expected structuredContent from ${label}.`);
  }

  return payload;
}

function assertHumanFirstCompatibilityResponse(result, label, expectedHeading) {
  const content = result?.content;
  if (!Array.isArray(content) || content.length < 2) {
    throw new Error(`Expected human Markdown and compatibility JSON from ${label}.`);
  }

  const humanText = content[0]?.type === "text" ? content[0].text : undefined;
  if (typeof humanText !== "string" || !humanText.includes(expectedHeading)) {
    throw new Error(`Expected human-first Markdown heading from ${label}.`);
  }
  if (/\u001b\[/u.test(humanText)) {
    throw new Error(`${label} human Markdown contains ANSI escape sequences.`);
  }

  const compatibilityText = content[1]?.type === "text" ? content[1].text : undefined;
  if (typeof compatibilityText !== "string") {
    throw new Error(`Expected compatibility JSON text block from ${label}.`);
  }

  let compatibilityPayload;
  try {
    compatibilityPayload = JSON.parse(compatibilityText);
  } catch (error) {
    throw new Error(
      `${label} compatibility JSON is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const structuredPayload = readStructuredContent(result, label);
  if (JSON.stringify(compatibilityPayload) !== JSON.stringify(structuredPayload)) {
    throw new Error(`${label} compatibility JSON does not match structuredContent.`);
  }

  return {
    humanFirst: true,
    compatibilityJson: true,
    structuredContent: true,
    ansiFree: true,
  };
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
  return process.platform === "win32" ? "npm.cmd" : "npm";
}

function tarCommand() {
  return process.platform === "win32" ? "tar.exe" : "tar";
}

function createPackagedLaunch(installedPackageDir) {
  return {
    command: process.execPath,
    args: [path.join(installedPackageDir, "dist", "server.js")],
  };
}

async function installPackagedTarball({ installRoot, npmCacheDir, tarballPath }) {
  await writeFile(
    path.join(installRoot, "package.json"),
    `${JSON.stringify({ name: "martin-mcp-pack-smoke", private: true }, null, 2)}\n`,
    "utf8",
  );

  await runCommand(
    npmCommand(),
    ["install", "--no-save", "--ignore-scripts", "--fund=false", "--audit=false", tarballPath],
    {
      cwd: installRoot,
      env: {
        ...sanitizePackageManagerEnv(process.env),
        npm_config_cache: npmCacheDir,
      },
    },
  );

  return path.join(installRoot, "node_modules", ...PUBLISHED_PACKAGE_SPEC.split("/"));
}

export function sanitizePackageManagerEnv(env = process.env) {
  const sanitized = { ...env };

  for (const key of Object.keys(sanitized)) {
    if (
      /^npm_/iu.test(key) ||
      /^npm_config_/iu.test(key) ||
      /^pnpm_/iu.test(key) ||
      /^INIT_CWD$/u.test(key)
    ) {
      delete sanitized[key];
    }
  }

  return sanitized;
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
