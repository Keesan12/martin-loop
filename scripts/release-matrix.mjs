#!/usr/bin/env node

import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { resolveRcCommandExecution } from "./rc-validation.mjs";

const RELEASE_MATRIX_STEPS = [
  ["pnpm", "install", "--frozen-lockfile"],
  ["pnpm", "build"],
  ["pnpm", "oss:validate"],
  ["pnpm", "public:smoke"],
  ["pnpm", "repo:smoke"],
  ["pnpm", "rc:validate"],
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
  const plan = createReleaseMatrixPlan({ rootDir: options.rootDir ?? process.cwd() });
  const lane = resolveReleaseMatrixLane(plan, options.platform ?? process.platform);
  const tempRoot = await resolveReleaseMatrixOutputRoot(
    options.outputRoot ?? process.env.MARTIN_RELEASE_MATRIX_OUTDIR,
  );
  const logDir = path.join(tempRoot, "logs");
  await mkdir(logDir, { recursive: true });
  const cleanedRootTmpArtifacts = await cleanupRootTmpArtifacts(plan.rootDir);

  const summary = {
    rootDir: plan.rootDir,
    lane: {
      id: lane.id,
      runner: lane.runner,
      platform: lane.platform,
    },
    logDir,
    cleanedRootTmpArtifacts,
    steps: lane.steps.map((step) => step.label),
  };

  await writeFile(path.join(logDir, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  process.stdout.write(`Release matrix logs: ${logDir}\n`);
  process.stdout.write(`Executing local ${lane.id} lane (${lane.platform}).\n`);
  if (cleanedRootTmpArtifacts.length > 0) {
    process.stdout.write(
      `Preflight cleanup removed root temp artifacts: ${cleanedRootTmpArtifacts.join(", ")}\n`,
    );
  }

  for (const [index, step] of lane.steps.entries()) {
    process.stdout.write(`\n[${index + 1}/${lane.steps.length}] ${step.label}\n`);
    await runCommand(step, {
      cwd: plan.rootDir,
      logDir,
      index: index + 1,
    });
  }

  return {
    lane: {
      id: lane.id,
      runner: lane.runner,
      platform: lane.platform,
    },
    logDir,
    cleanedRootTmpArtifacts,
    steps: lane.steps.map((step) => step.label),
  };
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

async function runCommand(step, options) {
  const execution = resolveRcCommandExecution(step.command, process.platform);
  const stepLogPath = path.join(logDirFor(options), `${String(options.index).padStart(2, "0")}-${slugify(step.label)}.log`);

  return new Promise((resolve, reject) => {
    const child = spawn(execution.command, execution.args, {
      cwd: options.cwd,
      env: process.env,
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

function logDirFor(options) {
  return options.logDir;
}

function slugify(value) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
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
