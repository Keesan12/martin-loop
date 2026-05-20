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
const REQUIRED_RESOURCES = [
  "martin://server/health",
  "martin://runs/recent",
  "martin://runs/triage",
  "martin://guides/mcp-usage",
  "martin://guides/publish-readiness",
];
const REQUIRED_RESOURCE_TEMPLATES = [
  "martin://runs/{loopId}",
  "martin://runs/{loopId}/attempts/{attemptIndex}",
  "martin://runs/{loopId}/verification",
];
const REQUIRED_PROMPTS = [
  "martin_governed_coding_kickoff",
  "martin_debug_failed_run",
  "martin_publish_readiness_review",
  "martin_triage_run_store",
];
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
    await mkdir(path.join(runsRoot, "loop_broken"), { recursive: true });
    await writeFile(path.join(runsRoot, "loop_broken", "loop-record.json"), "{not-json", "utf8");
    await writeFile(
      path.join(workspaceRoot, "src", "smoke-entry.ts"),
      "export const martinSmokeWorkspace = true;\n",
      "utf8",
    );

    const launch = createInstalledPackageLaunch(installedPackageDir);
    transport = new StdioClientTransport({
      ...launch,
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

    const resources = await client.listResources();
    const resourceUris = resources.resources.map((resource) => resource.uri).sort();
    for (const resourceUri of REQUIRED_RESOURCES) {
      if (!resourceUris.includes(resourceUri)) {
        throw new Error(`Missing expected resource "${resourceUri}" in published MCP server.`);
      }
    }

    const resourceTemplates = await client.listResourceTemplates();
    const resourceTemplateUris = resourceTemplates.resourceTemplates
      .map((resourceTemplate) => resourceTemplate.uriTemplate)
      .sort();
    for (const resourceTemplateUri of REQUIRED_RESOURCE_TEMPLATES) {
      if (!resourceTemplateUris.includes(resourceTemplateUri)) {
        throw new Error(`Missing expected resource template "${resourceTemplateUri}" in published MCP server.`);
      }
    }

    const prompts = await client.listPrompts();
    const promptNames = prompts.prompts.map((prompt) => prompt.name).sort();
    for (const promptName of REQUIRED_PROMPTS) {
      if (!promptNames.includes(promptName)) {
        throw new Error(`Missing expected prompt "${promptName}" in published MCP server.`);
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
    const degradedInspect = await client.callTool({
      name: "martin_inspect",
      arguments: {},
    });
    const triageRuns = await client.callTool({
      name: "martin_triage_runs",
      arguments: {},
    });
    const invalidInspect = await client.callTool({
      name: "martin_inspect",
      arguments: { file: "..\\..\\outside.jsonl" },
    });
    const doctorResult = await client.callTool({
      name: "martin_doctor",
      arguments: { engine: "codex" },
    });
    const kickoffPrompt = await client.getPrompt({
      name: "martin_governed_coding_kickoff",
      arguments: {
        objective: "Summarize the current runtime state",
        workingDirectory: workspaceRoot,
        engine: "claude",
        verificationPlan: "node --version",
        allowedPaths: "src/**",
        deniedPaths: "docs/**",
        maxUsd: "1",
        maxIterations: "1",
        workspaceId: "ws_published_smoke",
        projectId: "proj_published_smoke",
      },
    });
    const preflightResult = await client.callTool({
      name: "martin_preflight",
      arguments: {
        objective: "Summarize the current runtime state",
        workingDirectory: workspaceRoot,
        engine: "claude",
        verificationPlan: ["node --version"],
        maxIterations: 1,
        maxUsd: 1,
        allowedPaths: ["src/**"],
        deniedPaths: ["docs/**"],
        workspaceId: "ws_published_smoke",
        projectId: "proj_published_smoke",
      },
    });
    const serverHealthResource = await client.readResource({
      uri: "martin://server/health",
    });
    const triageResource = await client.readResource({
      uri: "martin://runs/triage",
    });
    const triagePrompt = await client.getPrompt({
      name: "martin_triage_run_store",
      arguments: {
        focus: "verification failures",
      },
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
    const runResultPayload = JSON.parse(readTextContent(runResult));
    const runLoopId = runResultPayload.loopId;
    if (typeof runLoopId !== "string" || runLoopId.length === 0) {
      throw new Error("Published martin_run did not return a loopId for follow-up inspection.");
    }
    const runAttemptIndex = runResultPayload.inspection?.loop?.lastAttempt?.index;
    if (!Number.isInteger(runAttemptIndex)) {
      throw new Error("Published martin_run did not return a last attempt index for follow-up inspection.");
    }
    const encodedRunLoopId = encodeURIComponent(runLoopId);
    const listRuns = await client.callTool({
      name: "martin_list_runs",
      arguments: { limit: 10 },
    });
    const getRun = await client.callTool({
      name: "martin_get_run",
      arguments: { loopId: runLoopId },
    });
    const getAttempt = await client.callTool({
      name: "martin_get_attempt",
      arguments: { loopId: runLoopId, attemptIndex: runAttemptIndex },
    });
    const getVerificationResults = await client.callTool({
      name: "martin_get_verification_results",
      arguments: { loopId: runLoopId },
    });
    const runDossier = await client.callTool({
      name: "martin_run_dossier",
      arguments: { loopId: runLoopId },
    });
    const dynamicRunResource = await client.readResource({
      uri: `martin://runs/${encodedRunLoopId}`,
    });
    const dynamicVerificationResource = await client.readResource({
      uri: `martin://runs/${encodedRunLoopId}/verification`,
    });
    const debugPrompt = await client.getPrompt({
      name: "martin_debug_failed_run",
      arguments: {
        loopId: runLoopId,
        attemptIndex: String(runAttemptIndex),
      },
    });
    const publishReadinessPrompt = await client.getPrompt({
      name: "martin_publish_readiness_review",
      arguments: {
        loopId: runLoopId,
        focus: "packaged smoke evidence",
      },
    });

    const publishedUserJourney = {
      preflightResult: JSON.parse(readTextContent(preflightResult)),
      listRuns: JSON.parse(readTextContent(listRuns)),
      getRun: JSON.parse(readTextContent(getRun)),
      getAttempt: JSON.parse(readTextContent(getAttempt)),
      getVerificationResults: JSON.parse(readTextContent(getVerificationResults)),
      runDossier: JSON.parse(readTextContent(runDossier)),
      dynamicRunResource: JSON.parse(readResourceText(dynamicRunResource)),
      dynamicVerificationResource: JSON.parse(readResourceText(dynamicVerificationResource)),
      kickoffPrompt,
      debugPrompt,
      publishReadinessPrompt,
    };
    assertPublishedUserJourneyEvidence(publishedUserJourney, {
      loopId: runLoopId,
      attemptIndex: runAttemptIndex,
    });

    const degradedInspectPayload = JSON.parse(readTextContent(degradedInspect));
    if (!Array.isArray(degradedInspectPayload.warnings) ||
      !degradedInspectPayload.warnings.some((warning) => warning.includes("loop_broken"))) {
      throw new Error("Published martin_inspect did not surface degraded run-store warnings.");
    }

    const triagePayload = JSON.parse(readTextContent(triageRuns));
    if (!Array.isArray(triagePayload.findings)) {
      throw new Error("Published martin_triage_runs did not return findings.");
    }

    if (!invalidInspect.isError || invalidInspect?._meta?.["martinloop/errorCategory"] !== "invalid_input") {
      throw new Error("Published MCP server did not return a typed invalid_input error for path traversal.");
    }

    const doctorPayload = JSON.parse(readTextContent(doctorResult));
    if (!Array.isArray(doctorPayload.warnings) ||
      !doctorPayload.warnings.some((warning) => warning.includes("loop_broken"))) {
      throw new Error("Published martin_doctor did not include degraded run-store warnings.");
    }

    const triagePromptMessages = Array.isArray(triagePrompt.messages) ? triagePrompt.messages : [];
    if (triagePromptMessages.length < 4) {
      throw new Error("Published martin_triage_run_store prompt is missing expected guidance messages.");
    }

    return {
      packageSpec,
      npxCommand: packageSpec.startsWith("@")
        ? `npx -y ${packageSpec}`
        : `npm exec --yes --package "${packageSpec}" -- mcp`,
      launchCommand: [launch.command, ...launch.args].map((value) => JSON.stringify(value)).join(" "),
      toolNames,
      installedManifest: {
        name: installedManifest.name,
        version: installedManifest.version,
        mcpName: installedManifest.mcpName,
      },
      installedServerMetadata,
      resourceUris,
      resourceTemplateUris,
      promptNames,
      serverHealth: JSON.parse(readResourceText(serverHealthResource)),
      triageResource: JSON.parse(readResourceText(triageResource)),
      triagePrompt,
      canonicalInspect: JSON.parse(readTextContent(canonicalInspect)),
      jsonlInspect: JSON.parse(readTextContent(jsonlInspect)),
      latestStatus: JSON.parse(readTextContent(latestStatus)),
      degradedInspect: degradedInspectPayload,
      triageRuns: triagePayload,
      invalidInspectError: invalidInspect._meta?.["martinloop/error"] ?? null,
      doctorResult: doctorPayload,
      runResult: runResultPayload,
      publishedUserJourney,
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
  const binDirectory = path.resolve(installedPackageDir, "..", "..", ".bin");
  const executable = process.platform === "win32"
    ? path.join(binDirectory, "mcp.cmd")
    : path.join(binDirectory, "mcp");

  return createCommandLaunch(executable, []);
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

function readResourceText(result) {
  if (!Array.isArray(result.contents) || result.contents.length === 0) {
    throw new Error("MCP resource read returned no contents.");
  }

  const first = result.contents[0];
  if (typeof first?.text !== "string") {
    throw new Error("Expected text resource content from MCP resource read.");
  }

  return first.text;
}

function assertPublishedUserJourneyEvidence(journey, expected) {
  const requiredKeys = [
    "preflightResult",
    "listRuns",
    "getRun",
    "getAttempt",
    "getVerificationResults",
    "runDossier",
    "dynamicRunResource",
    "dynamicVerificationResource",
    "kickoffPrompt",
    "debugPrompt",
    "publishReadinessPrompt",
  ];
  const missingKeys = requiredKeys.filter((key) => journey[key] === undefined);
  if (missingKeys.length > 0) {
    throw new Error(
      `Published smoke did not exercise installed-package 0.2.0 journey: missing ${missingKeys.join(", ")}.`,
    );
  }

  if (journey.preflightResult.normalized?.objective !== "Summarize the current runtime state") {
    throw new Error("Published martin_preflight did not preserve the packaged smoke objective.");
  }

  if (!journey.listRuns.recentRuns?.some((run) => run.loopId === expected.loopId)) {
    throw new Error("Published martin_list_runs did not include the real run created by martin_run.");
  }

  if (journey.getRun.loop?.loopId !== expected.loopId) {
    throw new Error("Published martin_get_run did not resolve the real run by loopId.");
  }

  if (journey.getAttempt.loop?.loopId !== expected.loopId ||
    journey.getAttempt.attempt?.index !== expected.attemptIndex) {
    throw new Error("Published martin_get_attempt did not resolve the real run attempt.");
  }

  if (journey.getVerificationResults.loop?.loopId !== expected.loopId ||
    typeof journey.getVerificationResults.verification?.status !== "string") {
    throw new Error("Published martin_get_verification_results did not return verification evidence.");
  }

  if (journey.runDossier.loop?.loopId !== expected.loopId ||
    !journey.runDossier.related?.resources?.includes(`martin://runs/${expected.loopId}`) ||
    !journey.runDossier.related?.resources?.includes(`martin://runs/${expected.loopId}/verification`)) {
    throw new Error("Published martin_run_dossier did not link the real run to its dynamic resources.");
  }

  if (journey.dynamicRunResource.value?.loop?.loopId !== expected.loopId) {
    throw new Error("Published dynamic martin://runs/{loopId} resource did not return the real run.");
  }

  if (journey.dynamicVerificationResource.value?.loopId !== expected.loopId) {
    throw new Error("Published dynamic martin://runs/{loopId}/verification resource did not return the real run.");
  }

  for (const [promptName, prompt] of Object.entries({
    kickoffPrompt: journey.kickoffPrompt,
    debugPrompt: journey.debugPrompt,
    publishReadinessPrompt: journey.publishReadinessPrompt,
  })) {
    if (!Array.isArray(prompt.messages) || prompt.messages.length === 0) {
      throw new Error(`Published ${promptName} fetch did not return prompt messages.`);
    }
  }
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
