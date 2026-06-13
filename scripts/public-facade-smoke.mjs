#!/usr/bin/env node

import { spawn } from "node:child_process";
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
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
      description: "npx martin-loop start prints the first-run governed workflow from a clean temp install.",
    },
    demoSmoke: {
      description: "npx martin-loop demo copies the packaged sandbox from a clean temp install.",
    },
    governedRunSmoke: {
      description: "npx martin-loop run auto-bootstraps governed prerequisites and executes when a healthy adapter is available.",
    },
    unsafeBypassSmoke: {
      description: "npx martin-loop run --unsafe-allow-unguarded-run bypasses the local receipt gate in packaged CLI builds.",
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
    if (!startRun.stdout.includes("MartinLoop start") || !startRun.stdout.includes("Governed runs are the default path")) {
      throw new Error(`Expected start command to print the governed first-run flow.\n${startRun.stdout}${startRun.stderr}`);
    }

    const demoTarget = path.join(appDir, "martin-loop-demo");
    const demoRun = await runCommand(["npx", "martin-loop", "demo", "--dir", demoTarget], {
      cwd: appDir,
    });
    const demoReadme = await readFile(path.join(demoTarget, "README.md"), "utf8");
    if (!/Martin\s*Loop demo sandbox created at/u.test(demoRun.stdout) || !demoReadme.includes("Demo Sandbox")) {
      throw new Error(`Expected demo command to copy the packaged sandbox.\n${demoRun.stdout}${demoRun.stderr}`);
    }

    await runCommand(["git", "init"], { cwd: appDir });
    const governedRunsRoot = path.join(tempRoot, "runs");
    const fakeCodexRoot = path.join(tempRoot, "fake-codex");
    await mkdir(fakeCodexRoot, { recursive: true });
    const fakeCodexPath = path.join(fakeCodexRoot, process.platform === "win32" ? "codex.cmd" : "codex");
    await writeFile(
      fakeCodexPath,
      process.platform === "win32"
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
          ].join("\n"),
      "utf8",
    );
    if (process.platform !== "win32") {
      await chmod(fakeCodexPath, 0o755);
    }

    const governedRun = await runCommand(
      [
        "npx",
        "martin-loop",
        "run",
        "--json",
        "--engine",
        "codex",
        "--cwd",
        appDir,
        "--runs-dir",
        governedRunsRoot,
        "--objective",
        "Summarize the demo workspace and confirm the verifier is green",
        "--verify",
        process.platform === "win32" ? "cmd /c exit 0" : "true",
        "--max-iterations",
        "1",
        "--budget-usd",
        "2",
      ],
      {
        cwd: appDir,
        env: {
          MARTIN_LIVE: "true",
          LOCALAPPDATA: fakeCodexRoot,
          PATH: `${fakeCodexRoot}${path.delimiter}${process.env.PATH ?? ""}`,
        },
      },
    );
    const governedPayload = JSON.parse(governedRun.stdout);
    if (
      governedPayload.command !== "run" ||
      governedPayload.loop?.attempts?.[0]?.adapterId !== "agent-cli:codex" ||
      !governedPayload.loop?.attempts?.[0]?.summary?.includes("fake codex completed")
    ) {
      throw new Error(`Expected packaged governed run to execute with the fake Codex adapter.\n${governedRun.stdout}${governedRun.stderr}`);
    }

    const workflowState = JSON.parse(
      await readFile(path.join(governedRunsRoot, "_martin", "workflow-state.json"), "utf8"),
    );
    if (!workflowState?.cli?.doctor || !workflowState?.cli?.["session-start"] || !workflowState?.cli?.preflight) {
      throw new Error("Expected packaged governed run to persist doctor, session-start, and preflight workflow receipts.");
    }

    // This command is expected to fail in clean temp installs when an adapter cannot launch,
    // but it must not fail with local receipt-gate policy_blocked when unsafe bypass is explicit.
    const unsafeBypassRun = await runCommandAllowFailure(
      [
        "npx",
        "martin-loop",
        "run",
        "--objective",
        "Unsafe bypass smoke",
        "--verify",
        "node -e \"process.exit(0)\"",
        "--unsafe-allow-unguarded-run",
      ],
      { cwd: appDir },
    );
    if (
      /Governed run blocked until MartinLoop receipts exist/u.test(unsafeBypassRun.stderr) ||
      /Governed run preflight blocked execution/u.test(unsafeBypassRun.stderr)
    ) {
      throw new Error(
        [
          "Expected --unsafe-allow-unguarded-run to bypass local receipt gating in packaged CLI.",
          unsafeBypassRun.stderr || unsafeBypassRun.stdout,
        ].join("\n"),
      );
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
        command: "npx martin-loop run --json --engine codex --cwd . --runs-dir ./runs --objective \"Summarize the demo workspace and confirm the verifier is green\" --verify \"<platform verifier>\" --max-iterations 1 --budget-usd 2",
        adapterId: governedPayload.loop.attempts[0].adapterId,
      },
      unsafeBypassSmoke: {
        ok: true,
        command: "npx martin-loop run --objective \"Unsafe bypass smoke\" --verify \"node -e \\\"process.exit(0)\\\"\" --unsafe-allow-unguarded-run",
        exitCode: unsafeBypassRun.exitCode,
      },
    };
  } finally {
    if (!options.keepTempDir) {
      await rm(tempRoot, { force: true, recursive: true }).catch(() => {});
    }
  }
}

async function runCommand(command, options) {
  const execution = resolveRcCommandExecution(command, process.platform);
  const env = buildLifecycleSafeEnv(options.env);

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
      if (code !== 0) {
        reject(
          new Error(
            `Command failed (${code ?? "unknown"}): ${command.join(" ")}\n${stdout}${stderr}`,
          ),
        );
        return;
      }

      resolve({
        stdout,
        stderr,
      });
    });
  });
}

async function runCommandAllowFailure(command, options) {
  const execution = resolveRcCommandExecution(command, process.platform);
  const env = buildLifecycleSafeEnv(options.env);

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
      resolve({
        stdout,
        stderr,
        exitCode: code ?? 1,
      });
    });
  });
}

async function ensureBuiltPublicFacade(rootDir) {
  await runCommand(["pnpm", "build"], { cwd: rootDir });
}

function buildLifecycleSafeEnv(overrides = {}) {
  const env = { ...process.env, ...overrides };

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
