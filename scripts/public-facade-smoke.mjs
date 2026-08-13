#!/usr/bin/env node

import { spawn } from "node:child_process";
import { access, chmod, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { resolveRcCommandExecution } from "./rc-validation.mjs";
import {
  assertPackedSurface,
  findSingleTarball,
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
      description: "A governed Codex run honors the governed receipt workflow from a clean temp install.",
    },
    unsafeBypassSmoke: {
      description: "unsafe-allow-unguarded-run is fail-closed for live governed coding runs.",
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
    await runCommand(["npm", "pack", "--ignore-scripts", "--pack-destination", packDir], {
      cwd: rootDir,
    });
    const tarballName = await findSingleTarball(packDir);
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
    await initializeGitRepo(governedWorkspace);

    const fakeCodex = await createFakeCodexCli(tempRoot);
    const governedEnv = {
      LOCALAPPDATA: fakeCodex.localAppData,
      MARTIN_LIVE: "true",
      MARTIN_RUNS_DIR: governedRunsDir,
      MARTIN_GROUNDING_DIR: governedGroundingDir,
      MARTIN_INTEGRITY_KEY_DIR: governedIntegrityDir,
      PATH: withPrependedPath(process.env.PATH ?? "", fakeCodex.binDir),
    };

    const noopVerifier = process.platform === "win32" ? "cmd /c exit 0" : "true";
    await runCommand(
      [
        "npx",
        "martin-loop",
        "--json",
        "doctor",
        "--engine",
        "codex",
        "--cwd",
        governedWorkspace,
        "--runs-dir",
        governedRunsDir,
      ],
      { cwd: appDir, env: governedEnv },
    );
    await runCommand(
      [
        "npx",
        "martin-loop",
        "--json",
        "session-start",
        "--cwd",
        governedWorkspace,
        "--runs-dir",
        governedRunsDir,
      ],
      { cwd: appDir, env: governedEnv },
    );
    await runCommand(
      [
        "npx",
        "martin-loop",
        "estimate",
        "Fix the bug",
        "--engine",
        "codex",
        "--cwd",
        governedWorkspace,
        "--runs-dir",
        governedRunsDir,
        "--budget-usd",
        "2",
      ],
      { cwd: appDir, env: governedEnv },
    );
    const preflightRun = await runCommand(
      [
        "npx",
        "martin-loop",
        "--json",
        "preflight",
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
      { cwd: appDir, env: governedEnv },
    );
    const preflightPayload = JSON.parse(preflightRun.stdout);
    if (preflightPayload?.ready !== true) {
      throw new Error(`Expected governed public smoke preflight to be ready.\n${preflightRun.stdout}${preflightRun.stderr}`);
    }
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
      { cwd: appDir, env: governedEnv },
    );
    const governedPayload = JSON.parse(governedRun.stdout);
    const governedAdapterId = governedPayload?.loop?.attempts?.[0]?.adapterId;
    if (governedAdapterId !== "agent-cli:codex") {
      throw new Error(`Expected governed public smoke to execute through the Codex adapter.\n${governedRun.stdout}${governedRun.stderr}`);
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
    if (unsafeBypassRun.exitCode !== 8) {
      throw new Error(`Expected unsafe bypass smoke to fail closed for live governed runs.\n${unsafeBypassRun.stdout}${unsafeBypassRun.stderr}`);
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
        adapterId: governedAdapterId,
      },
      unsafeBypassSmoke: {
        ok: unsafeBypassRun.exitCode === 8,
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
  // Always rebuild package dist + facade for smoke checks so stale local
  // artifacts cannot bypass release-surface guards.
  await runCommand(["pnpm", "build"], { cwd: rootDir });

  const requiredFiles = [
    path.join(rootDir, "dist", "index.js"),
    path.join(rootDir, "dist", "index.d.ts"),
    path.join(rootDir, "dist", "bin", "martin-loop.js"),
  ];
  const allPresent = await Promise.all(
    requiredFiles.map((filePath) => access(filePath).then(() => true).catch(() => false)),
  );

  if (!allPresent.every(Boolean)) {
    throw new Error("Public facade build is incomplete; required dist artifacts are missing.");
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

async function createFakeCodexCli(tempRoot) {
  const binDir = path.join(tempRoot, "fake-codex-bin");
  const localAppData = path.join(tempRoot, "localappdata");
  await mkdir(binDir, { recursive: true });
  await mkdir(localAppData, { recursive: true });

  const file = path.join(binDir, process.platform === "win32" ? "codex.cmd" : "codex");
  const script = process.platform === "win32"
    ? [
        "@echo off",
        "echo %* | findstr /C:\"--help\" >nul",
        "if %errorlevel%==0 (",
        "  echo usage: codex exec ...",
        "  exit /b 0",
        ")",
        "echo {\"type\":\"item.completed\",\"item\":{\"type\":\"command_execution\",\"status\":\"completed\",\"exit_code\":0}}",
        "echo {\"type\":\"item.completed\",\"item\":{\"type\":\"agent_message\",\"text\":\"fake codex completed\"}}",
        "echo {\"type\":\"turn.completed\",\"usage\":{\"input_tokens\":10,\"output_tokens\":5}}",
        "exit /b 0",
        "",
      ].join("\r\n")
    : [
        "#!/usr/bin/env sh",
        "case \"$*\" in",
        "  *--help*)",
        "    echo 'usage: codex exec ...'",
        "    ;;",
        "  *)",
        "    echo '{\"type\":\"item.completed\",\"item\":{\"type\":\"command_execution\",\"status\":\"completed\",\"exit_code\":0}}'",
        "    echo '{\"type\":\"item.completed\",\"item\":{\"type\":\"agent_message\",\"text\":\"fake codex completed\"}}'",
        "    echo '{\"type\":\"turn.completed\",\"usage\":{\"input_tokens\":10,\"output_tokens\":5}}'",
        "    ;;",
        "esac",
        "",
      ].join("\n");
  await writeFile(file, script, "utf8");
  if (process.platform !== "win32") {
    await chmod(file, 0o755);
    await access(file);
  }

  return {
    binDir,
    localAppData,
  };
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

function withPrependedPath(originalPath, directory) {
  return originalPath.length > 0
    ? `${directory}${process.platform === "win32" ? ";" : ":"}${originalPath}`
    : directory;
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
