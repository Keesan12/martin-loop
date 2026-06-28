#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import { access, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { resolveRcCommandExecution } from "./rc-validation.mjs";
import {
  assertPackedSurface,
  extractPackJsonPayload,
  inspectPackedFiles,
} from "./root-release-guard.mjs";

export function createPublicFacadeSmokePlan(options = {}) {
  const rootDir = options.rootDir ?? process.cwd();

  return {
    rootDir,
    packageName: "martin-loop",
    installCommand: "npm install martin-loop",
    npxCommand: "npx martin-loop --help",
    sdkSmoke: {
      description: "MartinLoop root import resolves from a clean temp project.",
    },
    cliSmoke: {
      description: "npx martin-loop --help resolves through the root public package facade.",
    },
    startSmoke: {
      description: "npx martin-loop start proves the first-run governed workflow from a clean temp install.",
    },
    demoSmoke: {
      description: "npx martin-loop demo copies the packaged sandbox from a clean temp install.",
    },
    governedRunSmoke: {
      description:
        "A governed Codex run uses the real Codex CLI when available and reports truthful availability blocks when it is not.",
    },
    unsafeBypassSmoke: {
      description: "unsafe-allow-unguarded-run remains available as an explicit operator bypass.",
    },
  };
}

export async function runPublicFacadeSmoke(options = {}) {
  const rootDir = options.rootDir ?? process.cwd();
  const rootManifest = JSON.parse(await readFile(path.join(rootDir, "package.json"), "utf8"));
  await ensureBuiltPublicFacade(rootDir);
  const packedFiles = await inspectPackedFiles({ rootDir, ignoreScripts: true });
  assertPackedSurface(packedFiles);

  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "martin-public-facade-"));
  const packDir = path.join(tempRoot, "pack");
  const appDir = path.join(tempRoot, "app");
  await mkdir(packDir, { recursive: true });
  await mkdir(appDir, { recursive: true });

  try {
    const packRun = await runCommand(["npm", "pack", "--json", "--ignore-scripts", "--pack-destination", packDir], {
      cwd: rootDir,
    });
    const packArtifacts = extractPackJsonPayload(packRun.stdout);
    const tarballName = Array.isArray(packArtifacts) ? packArtifacts[0]?.filename : undefined;

    if (typeof tarballName !== "string" || tarballName.trim().length === 0) {
      throw new Error("npm pack did not return a tarball filename.");
    }

    const tarballPath = path.join(packDir, tarballName);
    await writeFile(
      path.join(appDir, "package.json"),
      `${JSON.stringify(
        {
          name: "martin-loop-public-facade-smoke",
          private: true,
          type: "module",
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    await writeFile(
      path.join(appDir, "sdk-smoke.mjs"),
      [
        'import { MartinLoop } from "martin-loop";',
        "",
        'if (typeof MartinLoop !== "function") {',
        '  throw new Error("MartinLoop export missing");',
        "}",
        "",
        'console.log("MartinLoop");',
        "",
      ].join("\n"),
      "utf8",
    );

    await runCommand(["npm", "install", tarballPath], { cwd: appDir });

    const sdkRun = await runCommand(["node", "sdk-smoke.mjs"], { cwd: appDir });

    const cliRun = await runCommand(["npx", "martin-loop", "--help"], { cwd: appDir });
    if (!cliRun.stdout.includes("martin-loop run") && !cliRun.stdout.includes("Martin Loop CLI")) {
      throw new Error(`Expected CLI help output to include "martin-loop run" or "Martin Loop CLI".\n${cliRun.stdout}${cliRun.stderr}`);
    }

    const startRun = await runCommand(["npx", "martin-loop", "start"], { cwd: appDir });
    if (!/martin-loop proofRun|martin run/iu.test(`${startRun.stdout}\n${startRun.stderr}`)) {
      throw new Error(`Expected start command to describe the first-run governed workflow.\n${startRun.stdout}${startRun.stderr}`);
    }

    const demoTarget = path.join(appDir, "martin-loop-demo");
    const demoRun = await runCommand(["npx", "martin-loop", "demo", "--dir", demoTarget], {
      cwd: appDir,
    });
    const demoReadme = await readFile(path.join(demoTarget, "README.md"), "utf8");
    if (!/Martin\s*Loop demo sandbox created at/u.test(demoRun.stdout) || !demoReadme.includes("Demo Sandbox")) {
      throw new Error(`Expected demo command to copy the packaged sandbox.\n${demoRun.stdout}${demoRun.stderr}`);
    }

    const governedWorkspace = path.join(appDir, "governed-workspace");
    const governedRunsDir = path.join(appDir, ".martin-runs");
    const governedGroundingDir = path.join(appDir, ".martin-grounding");
    const governedIntegrityDir = path.join(appDir, ".martin-receipt-integrity");
    await mkdir(governedWorkspace, { recursive: true });
    initializeGitRepo(governedWorkspace);

    const codexAvailable = isCliCommandAvailable("codex");
    const governedEnv = {
      MARTIN_RUNS_DIR: governedRunsDir,
      MARTIN_GROUNDING_DIR: governedGroundingDir,
      MARTIN_INTEGRITY_KEY_DIR: governedIntegrityDir,
    };

    const noopVerifier = process.platform === "win32" ? "cmd /c exit 0" : "true";
    const governedRun = await runCommand(
      [
        "npx",
        "martin-loop",
        "--json",
        "run",
        "--engine",
        "codex",
        "--cwd",
        governedWorkspace,
        "--runs-dir",
        governedRunsDir,
        "--objective",
        "Fix the bug",
        "--verify",
        noopVerifier,
        "--max-iterations",
        "1",
        "--budget-usd",
        "2",
      ],
      { cwd: appDir, env: governedEnv, allowFailure: !codexAvailable },
    );
    const governedPayload = tryParseJson(governedRun.stdout);
    const governedAdapterId = governedPayload?.loop?.attempts?.[0]?.adapterId;
    if (codexAvailable) {
      if (governedAdapterId !== "agent-cli:codex") {
        throw new Error(`Expected governed public smoke to execute through the Codex adapter.\n${governedRun.stdout}${governedRun.stderr}`);
      }
    } else {
      const blockingIssues = Array.isArray(governedPayload?.details?.blockingIssues)
        ? governedPayload.details.blockingIssues.join("\n")
        : `${governedRun.stdout}\n${governedRun.stderr}`;
      if (governedRun.exitCode !== 8 || governedPayload?.category !== "policy_blocked") {
        throw new Error(
          `Expected governed public smoke to report a truthful Codex availability block when Codex is missing.\n${governedRun.stdout}${governedRun.stderr}`,
        );
      }
      if (!/Codex CLI is not available on PATH|codex is not installed|Codex launch probe failed/iu.test(blockingIssues)) {
        throw new Error(
          `Expected governed public smoke to explain the missing Codex CLI.\n${governedRun.stdout}${governedRun.stderr}`,
        );
      }
    }

    const unsafeBypassRun = await runCommand(
      [
        "npx",
        "martin-loop",
        "run",
        "--engine",
        "codex",
        "--cwd",
        governedWorkspace,
        "--runs-dir",
        path.join(appDir, ".martin-runs-bypass"),
        "--objective",
        "Fix the bug",
        "--verify",
        noopVerifier,
        "--max-iterations",
        "1",
        "--budget-usd",
        "2",
        "--unsafe-allow-unguarded-run",
      ],
      { cwd: appDir, env: governedEnv, allowFailure: true },
    );
    if (unsafeBypassRun.exitCode === 8) {
      throw new Error(`Expected unsafe bypass smoke to avoid the governed receipt-chain block.\n${unsafeBypassRun.stdout}${unsafeBypassRun.stderr}`);
    }

    return {
      packageName: rootManifest.name,
      tarballPath,
      installCommand: `npm install ${rootManifest.name}`,
      packedFiles,
      sdkSmoke: {
        ok: true,
        exportName: sdkRun.stdout.trim() || "MartinLoop",
      },
      cliSmoke: {
        ok: true,
        command: "npx martin-loop --help",
      },
      startSmoke: {
        ok: true,
        command: "npx martin-loop start",
      },
      demoSmoke: {
        ok: true,
        command: "npx martin-loop demo --dir ./martin-loop-demo",
      },
      governedRunSmoke: {
        ok: true,
        status: codexAvailable ? "executed" : "availability-blocked",
        adapterId: codexAvailable ? governedAdapterId : null,
      },
      unsafeBypassSmoke: {
        ok: unsafeBypassRun.exitCode !== 8,
        command: "npx martin-loop run --engine codex --unsafe-allow-unguarded-run",
        exitCode: unsafeBypassRun.exitCode,
      },
    };
  } finally {
    if (!options.keepTempDir) {
      await rm(tempRoot, { force: true, recursive: true });
    }
  }
}

async function runCommand(command, options) {
  const execution = resolveRcCommandExecution(command, process.platform);
  const env = buildLifecycleSafeEnv(options.env ?? process.env);

  return new Promise((resolve, reject) => {
    const child = spawn(execution.command, execution.args, {
      cwd: options.cwd,
      env,
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
      if (code !== 0 && options.allowFailure !== true) {
        reject(
          new Error(
            `Command failed (${code ?? "unknown"}): ${command.join(" ")}\n${stdout}${stderr}`,
          ),
        );
        return;
      }

      resolve({
        exitCode: code ?? 0,
        stdout,
        stderr,
      });
    });
  });
}

async function ensureBuiltPublicFacade(rootDir) {
  const requiredFiles = [
    path.join(rootDir, "dist", "index.js"),
    path.join(rootDir, "dist", "index.d.ts"),
    path.join(rootDir, "dist", "bin", "martin-loop.js"),
  ];
  const allPresent = await Promise.all(
    requiredFiles.map((filePath) => access(filePath).then(() => true).catch(() => false)),
  );

  if (!allPresent.every(Boolean)) {
    throw new Error("Public facade build is incomplete; run `pnpm build` before `pnpm public:smoke`.");
  }
}

function buildLifecycleSafeEnv(sourceEnv = process.env) {
  const env = { ...sourceEnv };

  for (const key of Object.keys(env)) {
    if (
      key === "INIT_CWD" ||
      key === "npm_command" ||
      key === "npm_execpath" ||
      key === "npm_node_execpath" ||
      key.startsWith("npm_config_") ||
      key.startsWith("npm_lifecycle_") ||
      key.startsWith("npm_package_") ||
      key.startsWith("PNPM_") ||
      key.startsWith("pnpm_")
    ) {
      delete env[key];
    }
  }

  return env;
}

function initializeGitRepo(directory) {
  const result = spawn(process.platform === "win32" ? "git.exe" : "git", ["init"], {
    cwd: directory,
    stdio: "ignore",
    shell: false,
  });

  return new Promise((resolve, reject) => {
    result.on("error", reject);
    result.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`Failed to initialize git repository. exit=${String(code)}`));
        return;
      }
      resolve();
    });
  });
}

function isCliCommandAvailable(command) {
  const probe = spawnSync(command, ["--help"], {
    encoding: "utf8",
    shell: false,
    timeout: 10_000,
    stdio: "ignore",
  });
  return probe.status === 0;
}

function tryParseJson(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

async function main() {
  const result = await runPublicFacadeSmoke({ rootDir: process.cwd() });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
const modulePath = fileURLToPath(import.meta.url);
if (invokedPath === path.resolve(modulePath)) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`Public facade smoke failed: ${message}\n`);
    process.exitCode = 1;
  });
}
