#!/usr/bin/env node

import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { buildPublicFacade } from "./build-public-facade.mjs";
import { resolveRcCommandExecution } from "./rc-validation.mjs";

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
  };
}

export async function runPublicFacadeSmoke(options = {}) {
  const rootDir = options.rootDir ?? process.cwd();
  const rootManifest = JSON.parse(await readFile(path.join(rootDir, "package.json"), "utf8"));
  await buildPublicFacade({ rootDir });

  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "martin-public-facade-"));
  const packDir = path.join(tempRoot, "pack");
  const appDir = path.join(tempRoot, "app");
  await mkdir(packDir, { recursive: true });
  await mkdir(appDir, { recursive: true });

  try {
    const packRun = await runCommand(["npm", "pack", "--json", "--pack-destination", packDir], {
      cwd: rootDir,
    });
    const packArtifacts = JSON.parse(packRun.stdout);
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

    return {
      packageName: rootManifest.name,
      tarballPath,
      installCommand: `npm install ${rootManifest.name}`,
      sdkSmoke: {
        ok: true,
        exportName: sdkRun.stdout.trim() || "MartinLoop",
      },
      cliSmoke: {
        ok: true,
        command: "npx martin-loop --help",
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
