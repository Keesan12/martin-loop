#!/usr/bin/env node

import { spawn } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const RC_VALIDATION_STEPS = [
  ["pnpm", "--filter", "@martin/contracts", "build"],
  ["pnpm", "--filter", "@martin/core", "lint"],
  ["pnpm", "--filter", "@martin/core", "test"],
  ["pnpm", "--filter", "@martin/core", "build"],
  ["pnpm", "--filter", "@martin/adapters", "lint"],
  ["pnpm", "--filter", "@martin/adapters", "test"],
  ["pnpm", "--filter", "@martin/adapters", "build"],
  ["pnpm", "--filter", "@martin/cli", "lint"],
  ["pnpm", "--filter", "@martin/cli", "test"],
  ["pnpm", "--filter", "@martin/cli", "build"],
  ["pnpm", "--filter", "@martin/benchmarks", "test"],
  ["pnpm", "--filter", "@martin/benchmarks", "build"],
  ["pnpm", "--filter", "@martin/benchmarks", "eval:phase12"],
  ["pnpm", "--filter", "@martin/benchmarks", "eval:providers"],
  ["pnpm", "oss:validate"],
  ["pnpm", "release:surface:validate"],
  ["pnpm", "pilot:prep:validate"],
  ["pnpm", "--filter", "@martin/control-plane", "lint"],
  ["pnpm", "--filter", "@martin/control-plane", "test"],
  ["pnpm", "--filter", "@martin/control-plane", "build"],
  ["pnpm", "build"],
  ["pnpm", "public:smoke"],
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

async function runCommand(step, options) {
  const { cwd, env, logDir } = options;
  const stepLogPath = path.join(logDir, `${options.index.toString().padStart(2, "0")}-${slugify(step.label)}.log`);
  const execution = resolveRcCommandExecution(step.command, process.platform);

  return new Promise((resolve, reject) => {
    const child = spawn(execution.command, execution.args, {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      shell: execution.shell,
    });

    let output = `> ${step.label}\n`;

    child.stdout.on("data", (chunk) => {
      const text = chunk.toString();
      output += text;
      process.stdout.write(text);
    });

    child.stderr.on("data", (chunk) => {
      const text = chunk.toString();
      output += text;
      process.stderr.write(text);
    });

    child.on("error", async (error) => {
      output += `\n[spawn-error] ${error instanceof Error ? error.message : String(error)}\n`;
      await writeFile(stepLogPath, output, "utf8");
      reject(error);
    });

    child.on("close", async (code) => {
      await writeFile(stepLogPath, output, "utf8");
      if (code === 0) {
        resolve();
        return;
      }

      reject(new Error(`Command failed (${code ?? "unknown"}): ${step.label}`));
    });
  });
}

export function resolveRcCommandExecution(
  command,
  platform = process.platform,
  comSpec = process.env.ComSpec ?? "cmd.exe",
) {
  if (platform === "win32") {
    const commandLine = command.map(quoteForWindowsShell).join(" ");
    return {
      command: comSpec,
      args: ["/d", "/s", "/c", commandLine],
      shell: false,
    };
  }

  return {
    command: command[0],
    args: command.slice(1),
    shell: false,
  };
}

function slugify(value) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

function quoteForWindowsShell(value) {
  if (!/[\s"&|<>^]/.test(value)) {
    return value;
  }

  return `"${value.replace(/"/g, '\\"')}"`;
}

async function main() {
  const includeInstall = process.argv.includes("--install");
  const cwd = process.cwd();
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "martin-rc-validation-"));
  const cleanHomeRoot = path.join(tempRoot, "home");
  const logDir = path.join(tempRoot, "logs");
  await mkdir(logDir, { recursive: true });

  const env = createRcValidationEnvironment(process.env, cleanHomeRoot);
  await ensureCleanEnvironmentDirs(env);

  const plan = createRcValidationPlan({ includeInstall });
  const summary = {
    cwd,
    tempRoot,
    cleanHomeRoot,
    logDir,
    includeInstall,
    steps: plan.map((step) => step.label),
  };

  await writeFile(path.join(logDir, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`, "utf8");

  process.stdout.write(`RC validation logs: ${logDir}\n`);
  process.stdout.write(`RC validation clean home: ${cleanHomeRoot}\n`);

  for (const [index, step] of plan.entries()) {
    process.stdout.write(`\n[${index + 1}/${plan.length}] ${step.label}\n`);
    await runCommand(step, {
      cwd,
      env,
      logDir,
      index: index + 1,
    });
  }

  process.stdout.write("\nRC validation completed successfully.\n");
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
