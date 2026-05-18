#!/usr/bin/env node

import { spawn } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { buildPublicFacade } from "./build-public-facade.mjs";
import { resolveRcCommandExecution } from "./rc-validation.mjs";

const DEFAULT_BUDGET = {
  maxUsd: 10,
  softLimitUsd: 8,
  maxIterations: 1,
  maxTokens: 2_000,
};

export function createRepoBackedSmokePlan(options = {}) {
  const rootDir = options.rootDir ?? process.cwd();

  return {
    rootDir,
    groundedSmoke: {
      description: "Repo-backed grounded run persists a grounding artifact inside the attempt bundle.",
    },
    rollbackSmoke: {
      description: "Repo-backed blocked run persists a rollback boundary and explicit restore outcome artifacts.",
    },
    expectedLifecycle: {
      grounded: "completed",
      rollback: "human_escalation",
    },
  };
}

export async function runRepoBackedSmoke(options = {}) {
  const rootDir = options.rootDir ?? process.cwd();
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "martin-repo-smoke-"));
  const isolatedHome = path.join(tempRoot, "home");
  await mkdir(isolatedHome, { recursive: true });

  try {
    return await withTemporaryHome(isolatedHome, async () => {
      const facade = await loadPublicFacade(rootDir);
      const groundedSmoke = await runGroundedRepoSmoke({ tempRoot, isolatedHome, facade });
      const rollbackSmoke = await runRollbackRepoSmoke({ tempRoot, facade });

      return {
        groundedSmoke,
        rollbackSmoke,
      };
    });
  } finally {
    if (!options.keepTempDir) {
      await rm(tempRoot, { recursive: true, force: true });
    }
  }
}

async function runGroundedRepoSmoke(input) {
  const repoRoot = path.join(input.tempRoot, "grounded repo");
  const runsRoot = path.join(input.tempRoot, "grounded-runs");
  await mkdir(path.join(repoRoot, "src"), { recursive: true });
  await writeFile(path.join(repoRoot, "src", "real.ts"), "export const real = 1;\n", "utf8");
  await initializeGitRepo(repoRoot);

  const adapter = {
    adapterId: "repo-smoke:grounded",
    kind: "direct-provider",
    label: "Repo smoke grounded adapter",
    metadata: {
      providerId: "smoke",
      model: "repo-grounded",
      transport: "http",
    },
    async execute() {
      await writeFile(path.join(repoRoot, "src", "real.ts"), "export const real = 2;\n", "utf8");

      return {
        status: "completed",
        summary: "Applied a grounded repo-backed change inside the allowed scope.",
        usage: {
          actualUsd: 0.18,
          tokensIn: 44,
          tokensOut: 18,
          provenance: "actual",
        },
        verification: {
          passed: true,
          summary: "repo-backed grounded smoke passed",
        },
        execution: {
          changedFiles: ["src/real.ts"],
          diffStats: {
            filesChanged: 1,
            addedLines: 1,
            deletedLines: 1,
          },
        },
      };
    },
  };

  const store = input.facade.createFileRunStore({ runsRoot });
  const martin = new input.facade.MartinLoop({ adapter });
  const result = await martin.run({
    workspaceId: "ws_repo_grounded",
    projectId: "proj_repo_grounded",
    task: {
      title: "Grounded repo-backed smoke",
      objective: "Persist a real grounding scan artifact for a repo-backed allowed-path change.",
      verificationPlan: ["pnpm --filter @martin/core test"],
      repoRoot,
      allowedPaths: ["src/**"],
    },
    budget: DEFAULT_BUDGET,
    store,
  });

  const attemptDir = path.join(runsRoot, result.loop.loopId, "artifacts", "attempt-001");
  const groundingScanPath = path.join(attemptDir, "grounding-scan.json");
  const groundingScan = JSON.parse(await readFile(groundingScanPath, "utf8"));
  const groundingCachePath = path.join(
    input.isolatedHome,
    ".martin",
    "grounding",
    `${Buffer.from(repoRoot).toString("base64url")}.json`,
  );

  return {
    ok: result.decision.lifecycleState === "completed",
    lifecycleState: result.decision.lifecycleState,
    contractWritten: await pathExists(path.join(runsRoot, result.loop.loopId, "contract.json")),
    ledgerWritten: await pathExists(path.join(runsRoot, result.loop.loopId, "ledger.jsonl")),
    groundingArtifactWritten:
      (await pathExists(groundingScanPath)) &&
      Array.isArray(groundingScan.resolvedFiles) &&
      groundingScan.resolvedFiles.includes("src/real.ts"),
    groundingCacheWritten: await pathExists(groundingCachePath),
  };
}

async function runRollbackRepoSmoke(input) {
  const repoRoot = path.join(input.tempRoot, "rollback repo");
  const runsRoot = path.join(input.tempRoot, "rollback-runs");
  await mkdir(path.join(repoRoot, "src"), { recursive: true });
  const originalReadme = "# Martin repo smoke baseline\n";
  await writeFile(path.join(repoRoot, "README.md"), originalReadme, "utf8");
  await writeFile(path.join(repoRoot, "src", "real.ts"), "export const real = 1;\n", "utf8");
  await initializeGitRepo(repoRoot);

  const adapter = {
    adapterId: "repo-smoke:rollback",
    kind: "direct-provider",
    label: "Repo smoke rollback adapter",
    metadata: {
      providerId: "smoke",
      model: "repo-rollback",
      transport: "http",
    },
    async execute() {
      await writeFile(path.join(repoRoot, "README.md"), "# Martin repo smoke mutated\n", "utf8");

      return {
        status: "completed",
        summary: "Mutated a forbidden file outside the allowed repo scope.",
        usage: {
          actualUsd: 0.22,
          tokensIn: 52,
          tokensOut: 24,
          provenance: "actual",
        },
        verification: {
          passed: true,
          summary: "repo-backed rollback smoke verifier passed",
        },
        execution: {
          changedFiles: ["README.md"],
          diffStats: {
            filesChanged: 1,
            addedLines: 1,
            deletedLines: 1,
          },
        },
      };
    },
  };

  const store = input.facade.createFileRunStore({ runsRoot });
  const martin = new input.facade.MartinLoop({ adapter });
  const result = await martin.run({
    workspaceId: "ws_repo_rollback",
    projectId: "proj_repo_rollback",
    task: {
      title: "Rollback repo-backed smoke",
      objective: "Persist rollback evidence and restore forbidden file edits back to the repo boundary.",
      verificationPlan: ["pnpm --filter @martin/core test"],
      repoRoot,
      allowedPaths: ["src/**"],
    },
    budget: DEFAULT_BUDGET,
    store,
  });

  const attemptDir = path.join(runsRoot, result.loop.loopId, "artifacts", "attempt-001");

  return {
    ok: result.decision.lifecycleState === "human_escalation",
    lifecycleState: result.decision.lifecycleState,
    rollbackBoundaryWritten: await pathExists(path.join(attemptDir, "rollback-boundary.json")),
    rollbackOutcomeWritten: await pathExists(path.join(attemptDir, "rollback-outcome.json")),
    leashArtifactWritten: await pathExists(path.join(attemptDir, "leash.json")),
    restoredOriginalContent:
      normalizeLineEndings(await readFile(path.join(repoRoot, "README.md"), "utf8")) ===
      normalizeLineEndings(originalReadme),
  };
}

async function loadPublicFacade(rootDir) {
  await buildPublicFacade({ rootDir });
  const moduleUrl = `${pathToFileURL(path.join(rootDir, "dist", "index.js")).href}?t=${Date.now()}`;
  const facade = await import(moduleUrl);

  if (typeof facade.MartinLoop !== "function" || typeof facade.createFileRunStore !== "function") {
    throw new Error("Public facade did not expose MartinLoop and createFileRunStore for repo smoke.");
  }

  return facade;
}

async function initializeGitRepo(repoRoot) {
  await runCommand(["git", "init"], { cwd: repoRoot });
  await runCommand(["git", "config", "user.email", "martin-smoke@example.com"], { cwd: repoRoot });
  await runCommand(["git", "config", "user.name", "Martin Smoke"], { cwd: repoRoot });
  await runCommand(["git", "add", "."], { cwd: repoRoot });
  await runCommand(["git", "commit", "-m", "initial-smoke-baseline"], { cwd: repoRoot });
}

async function runCommand(command, options) {
  const execution = resolveRcCommandExecution(command, process.platform);

  return new Promise((resolve, reject) => {
    const child = spawn(execution.command, execution.args, {
      cwd: options.cwd,
      env: process.env,
      shell: execution.shell,
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

    child.on("error", (error) => {
      reject(error);
    });

    child.on("close", (code) => {
      if (code !== 0) {
        reject(
          new Error(`Command failed (${code ?? "unknown"}): ${command.join(" ")}\n${stdout}${stderr}`),
        );
        return;
      }

      resolve({ stdout, stderr });
    });
  });
}

async function pathExists(targetPath) {
  try {
    await access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function withTemporaryHome(homeRoot, callback) {
  const previous = {
    HOME: process.env.HOME,
    USERPROFILE: process.env.USERPROFILE,
    APPDATA: process.env.APPDATA,
    LOCALAPPDATA: process.env.LOCALAPPDATA,
    XDG_CACHE_HOME: process.env.XDG_CACHE_HOME,
    XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
  };

  process.env.HOME = homeRoot;
  process.env.USERPROFILE = homeRoot;
  process.env.APPDATA = path.join(homeRoot, "AppData", "Roaming");
  process.env.LOCALAPPDATA = path.join(homeRoot, "AppData", "Local");
  process.env.XDG_CACHE_HOME = path.join(homeRoot, ".cache");
  process.env.XDG_CONFIG_HOME = path.join(homeRoot, ".config");

  await Promise.all([
    mkdir(process.env.APPDATA, { recursive: true }),
    mkdir(process.env.LOCALAPPDATA, { recursive: true }),
    mkdir(process.env.XDG_CACHE_HOME, { recursive: true }),
    mkdir(process.env.XDG_CONFIG_HOME, { recursive: true }),
  ]);

  try {
    return await callback();
  } finally {
    restoreEnvironment(previous);
  }
}

function restoreEnvironment(previous) {
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

function normalizeLineEndings(value) {
  return value.replace(/\r\n/g, "\n");
}

async function main() {
  const result = await runRepoBackedSmoke({ rootDir: process.cwd() });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
const modulePath = fileURLToPath(import.meta.url);
if (invokedPath === path.resolve(modulePath)) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`Repo-backed smoke failed: ${message}\n`);
    process.exitCode = 1;
  });
}
