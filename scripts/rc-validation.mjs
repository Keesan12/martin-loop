#!/usr/bin/env node

import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  resolveReleaseCommandExecution,
  resolveReleaseStageTimeoutMs,
  runReleaseCommand,
} from "./lib/release-command-runner.mjs";

const RC_VALIDATION_STEPS = [
  ["pnpm", "build"],
  ["pnpm", "test"],
  ["pnpm", "oss:validate"],
  ["pnpm", "public:smoke"],
  ["pnpm", "--filter", "@martinloop/mcp", "smoke:pack"],
  ["pnpm", "mcp:published:smoke:pack"],
  ["node", "./scripts/published-artifact-e2e.mjs", "--package-spec=pack"],
];

export function createRcValidationPlan(options = {}) {
  const includeInstall = options.includeInstall === true;
  const steps = RC_VALIDATION_STEPS.map((command) => ({
    label: command.join(" "),
    command,
  }));

  if (includeInstall) {
    return [
      {
        label: "pnpm install --frozen-lockfile",
        command: ["pnpm", "install", "--frozen-lockfile"],
      },
      ...steps,
    ];
  }

  return steps;
}

export function createRcValidationEnvironment(baseEnv, cleanHomeRoot) {
  const appDataRoot = path.join(cleanHomeRoot, "AppData");
  const roamingRoot = path.join(appDataRoot, "Roaming");
  const localRoot = path.join(appDataRoot, "Local");

  return {
    ...baseEnv,
    CI: "true",
    HOME: cleanHomeRoot,
    USERPROFILE: cleanHomeRoot,
    APPDATA: roamingRoot,
    LOCALAPPDATA: localRoot,
    XDG_CACHE_HOME: path.join(cleanHomeRoot, ".cache"),
    XDG_CONFIG_HOME: path.join(cleanHomeRoot, ".config"),
    MARTIN_RUNS_DIR: path.join(cleanHomeRoot, ".martin", "runs"),
    npm_config_cache: path.join(cleanHomeRoot, ".npm"),
    PNPM_HOME: path.join(cleanHomeRoot, ".pnpm-home"),
  };
}

async function ensureCleanEnvironmentDirs(env) {
  const requiredDirs = [
    env.HOME,
    env.USERPROFILE,
    env.APPDATA,
    env.LOCALAPPDATA,
    env.XDG_CACHE_HOME,
    env.XDG_CONFIG_HOME,
    env.MARTIN_RUNS_DIR,
    env.npm_config_cache,
    env.PNPM_HOME,
  ].filter(Boolean);

  await Promise.all(requiredDirs.map((dir) => mkdir(dir, { recursive: true })));
}

export function resolveRcCommandExecution(
  command,
  platform = process.platform,
  comSpec = process.env.ComSpec ?? "cmd.exe",
) {
  return resolveReleaseCommandExecution(command, platform, comSpec);
}

export async function runRcValidation(options = {}) {
  const includeInstall = options.includeInstall === true;
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const tempRoot = options.tempRoot
    ? path.resolve(options.tempRoot)
    : await mkdtemp(path.join(os.tmpdir(), "martin-rc-validation-"));
  const cleanHomeRoot = path.join(tempRoot, "home");
  const logDir = path.join(tempRoot, "logs");
  await mkdir(logDir, { recursive: true });

  const env = createRcValidationEnvironment(options.baseEnv ?? process.env, cleanHomeRoot);
  await ensureCleanEnvironmentDirs(env);
  const plan = options.plan ?? createRcValidationPlan({ includeInstall });
  const runner = options.runner ?? runReleaseCommand;
  const timeoutMs = resolveReleaseStageTimeoutMs({ timeoutMs: options.timeoutMs, env });
  const startedAt = new Date().toISOString();
  const startedMs = Date.now();
  const summaryPath = path.join(logDir, "summary.json");
  const summary = {
    schemaVersion: 1,
    kind: "rc-validation",
    status: "running",
    failureKind: null,
    failedStage: null,
    activeStage: null,
    startedAt,
    completedAt: null,
    elapsedMs: null,
    platform: options.platform ?? process.platform,
    toolchain: await resolveToolchainContext(cwd, env),
    cwd,
    tempRoot,
    cleanHomeRoot,
    logDir,
    includeInstall,
    stageTimeoutMs: timeoutMs,
    plannedSteps: plan.map((step) => ({ label: step.label, command: [...step.command] })),
    results: [],
    externalHarnessTimedOut: false,
  };
  await writeSummary(summaryPath, summary);

  process.stdout.write(`RC validation logs: ${logDir}\n`);
  process.stdout.write(`RC validation clean home: ${cleanHomeRoot}\n`);

  for (const [index, step] of plan.entries()) {
    process.stdout.write(`\n[${index + 1}/${plan.length}] ${step.label}\n`);
    summary.activeStage = {
      index: index + 1,
      label: step.label,
      command: [...step.command],
      startedAt: new Date().toISOString(),
    };
    await writeSummary(summaryPath, summary);
    const result = await runner(step, {
      cwd,
      env,
      logDir,
      index: index + 1,
      timeoutMs,
      platform: summary.platform,
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
  process.stdout.write("\nRC validation completed successfully.\n");
  return summary;
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
  await runRcValidation({ includeInstall: process.argv.includes("--install") });
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
const modulePath = fileURLToPath(import.meta.url);
if (invokedPath === path.resolve(modulePath)) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`RC validation failed: ${message}\n`);
    process.exitCode = 1;
  });
}
