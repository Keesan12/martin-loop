#!/usr/bin/env node

import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  resolveReleaseStageTimeoutMs,
  runReleaseCommand,
} from "./lib/release-command-runner.mjs";

const RELEASE_MATRIX_STEPS = [
  ["pnpm", "install", "--frozen-lockfile"],
  ["pnpm", "build"],
  ["pnpm", "release:root:guard"],
  ["pnpm", "test"],
  ["pnpm", "oss:validate"],
  ["pnpm", "public:smoke"],
  ["pnpm", "--filter", "@martinloop/mcp", "smoke:pack"],
  ["pnpm", "mcp:published:smoke:pack"],
  ["node", "./scripts/published-artifact-e2e.mjs", "--package-spec=pack"],
];

const RELEASE_MATRIX_LANES = [
  { id: "windows", runner: "windows-latest", platform: "win32" },
  { id: "macos", runner: "macos-latest", platform: "darwin" },
  { id: "linux", runner: "ubuntu-latest", platform: "linux" },
];

export function createReleaseMatrixPlan(options = {}) {
  const rootDir = options.rootDir ?? process.cwd();

  return {
    rootDir,
    lanes: RELEASE_MATRIX_LANES.map((lane) => ({
      ...lane,
      steps: RELEASE_MATRIX_STEPS.map((command) => ({
        label: command.join(" "),
        command,
      })),
    })),
  };
}

export function resolveReleaseMatrixLane(plan, platform = process.platform) {
  const lane = plan.lanes.find((candidate) => candidate.platform === platform);

  if (!lane) {
    throw new Error(`No release matrix lane is defined for platform ${platform}.`);
  }

  return lane;
}

export async function runLocalReleaseMatrix(options = {}) {
  const plan = options.plan ?? createReleaseMatrixPlan({ rootDir: options.rootDir ?? process.cwd() });
  const lane = resolveReleaseMatrixLane(plan, options.platform ?? process.platform);
  const tempRoot = await resolveReleaseMatrixOutputRoot(
    options.outputRoot ?? process.env.MARTIN_RELEASE_MATRIX_OUTDIR,
  );
  const logDir = path.join(tempRoot, "logs");
  await mkdir(logDir, { recursive: true });
  const cleanedRootTmpArtifacts = await cleanupRootTmpArtifacts(plan.rootDir);
  const env = createReleaseMatrixEnvironment(options.baseEnv ?? process.env);
  const timeoutMs = resolveReleaseStageTimeoutMs({ timeoutMs: options.timeoutMs, env });
  const runner = options.runner ?? runReleaseCommand;
  const startedAt = new Date().toISOString();
  const startedMs = Date.now();
  const summaryPath = path.join(logDir, "summary.json");
  const summary = {
    schemaVersion: 1,
    kind: "release-matrix",
    status: "running",
    failureKind: null,
    failedStage: null,
    activeStage: null,
    startedAt,
    completedAt: null,
    elapsedMs: null,
    platform: lane.platform,
    toolchain: await resolveToolchainContext(plan.rootDir, env),
    rootDir: plan.rootDir,
    lane: {
      id: lane.id,
      runner: lane.runner,
      platform: lane.platform,
    },
    logDir,
    cleanedRootTmpArtifacts,
    stageTimeoutMs: timeoutMs,
    plannedSteps: lane.steps.map((step) => ({ label: step.label, command: [...step.command] })),
    results: [],
    externalHarnessTimedOut: false,
  };

  await writeSummary(summaryPath, summary);
  process.stdout.write(`Release matrix logs: ${logDir}\n`);
  process.stdout.write(`Executing local ${lane.id} lane (${lane.platform}).\n`);
  if (cleanedRootTmpArtifacts.length > 0) {
    process.stdout.write(
      `Preflight cleanup removed root temp artifacts: ${cleanedRootTmpArtifacts.join(", ")}\n`,
    );
  }

  for (const [index, step] of lane.steps.entries()) {
    process.stdout.write(`\n[${index + 1}/${lane.steps.length}] ${step.label}\n`);
    summary.activeStage = {
      index: index + 1,
      label: step.label,
      command: [...step.command],
      startedAt: new Date().toISOString(),
    };
    await writeSummary(summaryPath, summary);
    const result = await runner(step, {
      cwd: plan.rootDir,
      env,
      logDir,
      index: index + 1,
      timeoutMs,
      platform: lane.platform,
    });
    summary.results.push(result);
    summary.activeStage = null;
    if (result.status !== "passed") {
      summary.status = "failed";
      summary.failureKind = result.failureKind;
      summary.failedStage = step.label;
      summary.completedAt = new Date().toISOString();
      summary.elapsedMs = Math.max(0, Date.now() - startedMs);
      await writeSummary(summaryPath, summary);
      throw new Error(formatReleaseStageFailure(result));
    }
    await writeSummary(summaryPath, summary);
  }

  summary.status = "passed";
  summary.completedAt = new Date().toISOString();
  summary.elapsedMs = Math.max(0, Date.now() - startedMs);
  await writeSummary(summaryPath, summary);
  return summary;
}

export async function cleanupRootTmpArtifacts(rootDir) {
  const entries = await readdir(rootDir, { withFileTypes: true });
  const candidates = entries
    .filter((entry) => entry.isFile() && /^_tmp_/i.test(entry.name))
    .map((entry) => entry.name)
    .sort();

  for (const candidate of candidates) {
    await rm(path.join(rootDir, candidate), { force: true });
  }

  return candidates;
}

async function resolveReleaseMatrixOutputRoot(configuredOutputRoot) {
  if (typeof configuredOutputRoot === "string" && configuredOutputRoot.trim().length > 0) {
    const resolved = path.resolve(configuredOutputRoot);
    await mkdir(resolved, { recursive: true });
    return resolved;
  }

  return mkdtemp(path.join(os.tmpdir(), "martin-release-matrix-"));
}

export function createReleaseMatrixEnvironment(baseEnv = process.env) {
  const ci = readEnvValueCaseInsensitive(baseEnv, "CI");
  const confirmModulesPurge = readEnvValueCaseInsensitive(baseEnv, "npm_config_confirm_modules_purge");

  return {
    ...baseEnv,
    CI: ci && ci.trim().length > 0 ? ci : "true",
    npm_config_confirm_modules_purge:
      confirmModulesPurge && confirmModulesPurge.trim().length > 0 ? confirmModulesPurge : "false",
  };
}

function readEnvValueCaseInsensitive(baseEnv, key) {
  const direct = baseEnv[key];
  if (typeof direct === "string") {
    return direct;
  }

  const matchedKey = Object.keys(baseEnv).find((candidate) => candidate.toLowerCase() === key.toLowerCase());
  if (!matchedKey) {
    return undefined;
  }

  const matchedValue = baseEnv[matchedKey];
  return typeof matchedValue === "string" ? matchedValue : undefined;
}

async function resolveToolchainContext(cwd, env) {
  let packageManager = "unknown";
  try {
    const packageJson = JSON.parse(await readFile(path.join(cwd, "package.json"), "utf8"));
    if (typeof packageJson.packageManager === "string") packageManager = packageJson.packageManager;
  } catch {}
  const userAgent = env.npm_config_user_agent;
  const pnpm = packageManager.startsWith("pnpm@")
    ? packageManager.slice("pnpm@".length)
    : typeof userAgent === "string" && userAgent.startsWith("pnpm/")
      ? userAgent.split(" ")[0].slice("pnpm/".length)
      : "unknown";
  return { node: process.version, pnpm };
}

function formatReleaseStageFailure(result) {
  if (result.failureKind === "repository_stage_timeout") {
    return `Release stage failed: ${result.label} (repository stage timeout after ${result.timeoutMs}ms)`;
  }
  if (result.failureKind === "spawn_error") {
    return `Release stage failed: ${result.label} (spawn error: ${result.spawnError ?? "unknown"})`;
  }
  return `Release stage failed: ${result.label} (exit ${result.exitCode ?? "unknown"}${result.signal ? `, signal ${result.signal}` : ""})`;
}

async function writeSummary(summaryPath, summary) {
  await writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
}

async function main() {
  const result = await runLocalReleaseMatrix({ rootDir: process.cwd() });
  process.stdout.write(`\n${JSON.stringify(result, null, 2)}\n`);
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
const modulePath = fileURLToPath(import.meta.url);
if (invokedPath === path.resolve(modulePath)) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`Release matrix failed: ${message}\n`);
    process.exitCode = 1;
  });
}
